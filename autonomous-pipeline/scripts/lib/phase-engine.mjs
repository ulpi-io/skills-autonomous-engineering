// phase-engine.mjs — the fail-closed POST-BUILD phase runner for the Codex-native pipeline coordinator.
//
// Where review-panel.mjs owns the review phase's *decision* machinery (kept deliberately separate and
// imported here for the review phase), THIS module owns the sequential *orchestration* of every other
// post-build phase — simplify, test, review, performance, ship_prep — and the terminal FINAL VALIDATION
// gate. It runs them SEQUENTIALLY in the coordinator-owned integration worktree, turning "run the rest of
// the pipeline" into structured, evidence-honest, hard-gated results:
//
//   1. SKIP vs RUN. A phase the run configured to OMIT persists as 'skipped' (NEVER 'done') — but only an
//      OPTIONAL phase may be omitted. A configured omission of a REQUIRED phase is a fail-closed BLOCK
//      (you cannot skip a gate). Required phases run, in declaration order, one at a time.
//   2. BUDGET-RESERVED-BEFORE-INVOKE. Every mutating phase RESERVES one Codex spawn from the immutable
//      budget ledger BEFORE its agent is invoked — the engine never oversubscribes the termination set.
//   3. STRUCTURED-OUTPUT + COORDINATOR-RUN VALIDATION. A mutating phase's result can only advance when the
//      agent returned VALID structured output (ok:true) AND the COORDINATOR itself ran validation in the
//      integration worktree and observed it GREEN. The agent's self-claim never advances the phase —
//      resolution is the coordinator's observation (observedBy:'coordinator'), not the claimant's word.
//   4. HARD DOWNSTREAM GATE. Agent death, ok:false / malformed output, red OR missing coordinator
//      validation, a refused budget reservation, a no-progress / budget stop, a blocked review panel, or a
//      failed checkpoint write BLOCKS the phase AND every downstream phase. Nothing runs past a gate that
//      did not go green — and a phase that did not actually pass is NEVER reported 'done'.
//   5. CONVERGENCE. The engine ends by reconciling its phase states + the terminal final-validation result
//      against pipeline-state's convergence conjunction, so a blocked run reports converged:false honestly.
//
// Imports (does NOT reimplement): budget-ledger (reserve/settle/evaluate/progressFingerprint — the
// immutable termination set + reservation discipline), checkpoint-store (durable phase/validation state),
// pipeline-state (optional-vs-required phase model + the convergence conjunction), review-panel (the review
// phase's fail-closed verdict), cli-contract (the pinned EXIT table). Zero external deps, Node 22+.

import { reserve, settle, evaluate, progressFingerprint } from './budget-ledger.mjs';
import { convergenceFailures } from './pipeline-state.mjs';
import { runReviewPanel } from './review-panel.mjs';
import { EXIT } from './cli-contract.mjs';
import { phase as ckPhase, validation as ckValidation } from '../../../checkpoint-resume/scripts/lib/checkpoint-store.mjs';

// ── errors ──────────────────────────────────────────────────────────────────────
export class PhaseEngineError extends Error {
  constructor(message, code = EXIT.USAGE) { super(message); this.name = 'PhaseEngineError'; this.code = code; }
}
const fail = (m, code = EXIT.USAGE) => { throw new PhaseEngineError(m, code); };

// ── typed BLOCK vocabulary — every path that stops a phase names itself ─────────────────
export const PHASE_BLOCK_REASONS = Object.freeze({
  REQUIRED_OMITTED: 'required-omitted',       // a REQUIRED phase was configured to skip (illegitimate)
  MISSING_AGENT: 'missing-agent',             // a phase that must run had no agent function / no config
  AGENT_DEAD: 'agent-dead',                   // the phase agent threw
  BAD_OUTPUT: 'bad-output',                   // ok:false or malformed structured output
  VALIDATION_RED: 'validation-red',           // coordinator-run validation failed
  VALIDATION_MISSING: 'validation-missing',   // coordinator validation was absent (fail-closed)
  BUDGET_EXHAUSTED: 'budget-exhausted',       // the budget refused the phase's reservation / a limit is spent
  NO_PROGRESS: 'no-progress',                 // maxNoProgressBarriers consecutive unchanged fingerprints
  CHECKPOINT_FAILED: 'checkpoint-failed',     // a durable checkpoint write refused / threw
  REVIEW_BLOCKED: 'review-blocked',           // the review panel returned a blocked verdict
  UPSTREAM_BLOCKED: 'upstream-blocked',       // a prior phase blocked — this one is gated, never run
});

// The sentinel phase name for the terminal final-validation gate (not a workflow-owned phase).
export const FINAL_VALIDATION = '__final_validation__';

// The canonical POST-BUILD phase order (build itself is upstream of this engine). Optional phases may be
// omitted; required phases may not. `review` is delegated to review-panel; the rest invoke a phase agent.
export const POST_BUILD_PHASES = Object.freeze([
  Object.freeze({ name: 'simplify', optional: true, mutating: true }),
  Object.freeze({ name: 'test', optional: false, mutating: true }),
  Object.freeze({ name: 'review', optional: false, review: true }),
  Object.freeze({ name: 'performance', optional: true, mutating: true }),
  Object.freeze({ name: 'ship_prep', optional: true, mutating: true }),
]);

// ── phase output validation ─────────────────────────────────────────────────────────
// A phase agent's structured output MUST be a plain object that explicitly claims ok:true. Anything else
// (null, array, scalar, missing/false ok) is malformed — fail-closed, never treated as a pass.
function isValidPhaseOutput(out) {
  return !!out && typeof out === 'object' && !Array.isArray(out) && out.ok === true;
}

// ── input validation / defaults ─────────────────────────────────────────────────────
function normPhase(p) {
  if (!p || typeof p !== 'object' || typeof p.name !== 'string' || p.name.trim() === '') {
    fail('each phase must be an object { name, optional?, mutating?, review?, schema? } with a non-empty name');
  }
  return {
    name: p.name,
    optional: p.optional === true,
    mutating: p.review === true ? false : p.mutating !== false, // agent phases mutate by default; review does not
    review: p.review === true,
    schema: p.schema ?? null,
  };
}

function normalizeOptions(opts) {
  const o = opts || {};
  if (typeof o.file !== 'string' || o.file.trim() === '') fail('runPhaseEngine requires a checkpoint `file` path (with an initialized budget)');
  if (typeof o.worktree !== 'string' || o.worktree.trim() === '') fail('runPhaseEngine requires a `worktree` path (the coordinator-owned integration worktree)');
  const phaseDefs = Array.isArray(o.phases) && o.phases.length ? o.phases.map(normPhase) : POST_BUILD_PHASES.map(normPhase);
  const names = new Set();
  for (const p of phaseDefs) { if (names.has(p.name)) fail(`duplicate phase '${p.name}'`); names.add(p.name); }
  const phaseFns = (o.phaseFns && typeof o.phaseFns === 'object' && !Array.isArray(o.phaseFns)) ? o.phaseFns : {};
  const validateFn = typeof o.validateFn === 'function' ? o.validateFn : null;         // coordinator per-phase validation
  const finalValidateFn = typeof o.finalValidateFn === 'function' ? o.finalValidateFn : null; // coordinator terminal gate
  const reviewOptions = (o.reviewOptions && typeof o.reviewOptions === 'object' && !Array.isArray(o.reviewOptions)) ? o.reviewOptions : null;
  const skipRaw = Array.isArray(o.skip) ? o.skip : [];
  const skip = new Set(skipRaw.map(String));
  const callTimeoutMs = Number.isInteger(o.callTimeoutMs) && o.callTimeoutMs > 0 ? o.callTimeoutMs : 60_000;
  const clock = typeof o.clock === 'function' ? o.clock : () => Date.now();
  const openItems = Array.isArray(o.openItems) ? o.openItems : [];
  const units = (o.units && typeof o.units === 'object' && !Array.isArray(o.units)) ? o.units : {};
  const hooks = (o.hooks && typeof o.hooks === 'object') ? o.hooks : {};
  const setPhaseState = typeof hooks.setPhaseState === 'function' ? hooks.setPhaseState : ckPhase;
  const recordValidation = typeof hooks.recordValidation === 'function' ? hooks.recordValidation : ckValidation;
  return {
    file: o.file, worktree: o.worktree, phaseDefs, phaseFns, validateFn, finalValidateFn, reviewOptions,
    skip, callTimeoutMs, clock, openItems, units, setPhaseState, recordValidation,
  };
}

// ── durable state helpers (fail-closed: a failed checkpoint write is a hard gate) ──────
function tryCheckpoint(ctx, name, status) {
  try { ctx.setPhaseState(ctx.file, name, status); return { ok: true }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// Build a standardized BLOCKED phase result + its typed reason token.
function blockedResult(name, reason, { ran = false, mutating = false, ...extra } = {}) {
  return {
    blocked: true,
    reason: `${reason}:${name}`,
    result: { name, state: 'blocked', ran, mutating, reason, ...extra },
  };
}

// ── one non-review agent phase ───────────────────────────────────────────────────────
async function runAgentPhase(ctx, p, order) {
  // (2) RESERVE one Codex spawn BEFORE the agent is invoked — never oversubscribe the immutable budget.
  const rsv = reserve(ctx.file, { task: `phase:${p.name}`, phase: p.name, callTimeoutMs: ctx.callTimeoutMs });
  if (!rsv.granted) {
    tryCheckpoint(ctx, p.name, 'blocked');
    return blockedResult(p.name, PHASE_BLOCK_REASONS.BUDGET_EXHAUSTED, {
      mutating: p.mutating, budget: rsv.reasons || (rsv.stopped ? ['budget-stopped'] : []),
    });
  }
  // Honest in-progress marker (a crash mid-phase resumes as 'running', not silently 'done').
  tryCheckpoint(ctx, p.name, 'running');
  order.push(p.name);

  const fn = ctx.phaseFns[p.name];
  if (typeof fn !== 'function') {
    settle(ctx.file, rsv.reservationId, { actualWallMs: 0 });
    tryCheckpoint(ctx, p.name, 'blocked');
    return blockedResult(p.name, PHASE_BLOCK_REASONS.MISSING_AGENT, { ran: false, mutating: p.mutating });
  }

  const t0 = ctx.clock();
  let out = null; let dead = false; let error = null;
  try {
    out = await fn({
      phase: p.name, worktree: ctx.worktree, schema: p.schema,
      reservation: { reservationId: rsv.reservationId, childTimeoutMs: rsv.childTimeoutMs },
    });
  } catch (e) { dead = true; error = String((e && e.message) || e); }
  settle(ctx.file, rsv.reservationId, { actualWallMs: Math.max(0, ctx.clock() - t0), tokens: (out && out.tokens) || undefined });

  if (dead) {
    tryCheckpoint(ctx, p.name, 'blocked');
    return blockedResult(p.name, PHASE_BLOCK_REASONS.AGENT_DEAD, { ran: true, mutating: p.mutating, error });
  }
  if (!isValidPhaseOutput(out)) {
    tryCheckpoint(ctx, p.name, 'blocked');
    return blockedResult(p.name, PHASE_BLOCK_REASONS.BAD_OUTPUT, { ran: true, mutating: p.mutating, output: out ?? null });
  }

  // (3) COORDINATOR-RUN validation — required for a mutating phase; the agent's word never advances it.
  let observed = null;
  if (p.mutating) {
    if (typeof ctx.validateFn !== 'function') {
      tryCheckpoint(ctx, p.name, 'blocked');
      return blockedResult(p.name, PHASE_BLOCK_REASONS.VALIDATION_MISSING, { ran: true, mutating: true });
    }
    let val = null;
    try { val = await ctx.validateFn({ phase: p.name, worktree: ctx.worktree, output: out }); }
    catch (e) { val = { ok: false, error: String((e && e.message) || e) }; }
    if (val == null || typeof val !== 'object' || Array.isArray(val)) {
      tryCheckpoint(ctx, p.name, 'blocked');
      return blockedResult(p.name, PHASE_BLOCK_REASONS.VALIDATION_MISSING, { ran: true, mutating: true });
    }
    if (val.ok !== true) {
      tryCheckpoint(ctx, p.name, 'blocked');
      return blockedResult(p.name, PHASE_BLOCK_REASONS.VALIDATION_RED, { ran: true, mutating: true, validation: { observedBy: 'coordinator', ...val, ok: false } });
    }
    observed = { observedBy: 'coordinator', ...val, ok: true };
  }

  // (4) no-progress / budget barrier — record the progress barrier and evaluate the termination set. A
  // THRASH stop (maxNoProgressBarriers consecutive unchanged coordinator-observed signatures) blocks THIS
  // phase: it produced no forward progress. A pure RESOURCE-exhaustion stop (calls/wall/attempts spent) is
  // NOT retroactively applied to this phase — it genuinely succeeded — it is enforced by the NEXT phase's
  // refused reservation (evaluate durably sets budget.stopped, so the next reserve is refused fail-closed),
  // keeping this phase honestly 'done' while still gating everything downstream.
  const ev = evaluate(ctx.file, {
    fingerprint: progressFingerprint({
      integrationHead: (observed && observed.head) || '',
      validationSignature: (observed && observed.signature) || p.name,
    }),
  });
  if (ev.stop && ev.reasons.includes('max-no-progress-barriers')) {
    tryCheckpoint(ctx, p.name, 'blocked');
    return blockedResult(p.name, PHASE_BLOCK_REASONS.NO_PROGRESS, { ran: true, mutating: p.mutating, budget: ev.reasons });
  }

  // Advance ONLY now that structured output + coordinator validation + budget all cleared.
  const ck = tryCheckpoint(ctx, p.name, 'done');
  if (!ck.ok) {
    return blockedResult(p.name, PHASE_BLOCK_REASONS.CHECKPOINT_FAILED, { ran: true, mutating: p.mutating, error: ck.error });
  }
  return { blocked: false, reason: null, result: { name: p.name, state: 'done', ran: true, mutating: p.mutating, output: out, validation: observed } };
}

// ── the review phase — delegated to the fail-closed review panel ─────────────────────
async function runReviewPhase(ctx, p, order) {
  if (!ctx.reviewOptions) {
    tryCheckpoint(ctx, p.name, 'blocked');
    return blockedResult(p.name, PHASE_BLOCK_REASONS.MISSING_AGENT, { ran: false });
  }
  tryCheckpoint(ctx, p.name, 'running');
  order.push(p.name);
  let panel = null; let error = null;
  try { panel = await runReviewPanel({ file: ctx.file, phase: p.name, ...ctx.reviewOptions }); }
  catch (e) { error = String((e && e.message) || e); }
  if (error || !panel || panel.canAdvanceShipPrep !== true) {
    tryCheckpoint(ctx, p.name, 'blocked');
    return blockedResult(p.name, PHASE_BLOCK_REASONS.REVIEW_BLOCKED, {
      ran: true, panel: panel ? { blockedReasons: panel.blockedReasons } : null, error,
    });
  }
  const ck = tryCheckpoint(ctx, p.name, 'done');
  if (!ck.ok) return blockedResult(p.name, PHASE_BLOCK_REASONS.CHECKPOINT_FAILED, { ran: true, error: ck.error });
  return { blocked: false, reason: null, result: { name: p.name, state: 'done', ran: true, review: true, panel } };
}

// ── terminal final-validation gate (coordinator-run, in the integration worktree) ──────
async function runFinalValidation(ctx) {
  if (typeof ctx.finalValidateFn !== 'function') {
    return { observedBy: 'coordinator', ok: false, missing: true };
  }
  let v = null;
  try { v = await ctx.finalValidateFn({ worktree: ctx.worktree }); }
  catch (e) { v = { ok: false, error: String((e && e.message) || e) }; }
  if (v == null || typeof v !== 'object' || Array.isArray(v)) v = { ok: false, missing: true };
  const ok = v.ok === true;
  try { ctx.recordValidation(ctx.file, ok ? 'green' : 'red'); } catch { /* recording failure never fakes a pass */ }
  return { observedBy: 'coordinator', ...v, ok };
}

// ── the engine entrypoint ────────────────────────────────────────────────────────────
/**
 * Run the post-build phase sequence to a typed, fail-closed, evidence-honest result.
 * @returns {Promise<{status:'ok'|'blocked', exitCode:number, phases:object[], order:string[],
 *   blockedReasons:string[], firstBlockedPhase:string|null, finalValidation:object|null,
 *   convergenceFailures:object[], converged:boolean}>}
 */
export async function runPhaseEngine(opts) {
  const ctx = normalizeOptions(opts);
  const results = [];
  const order = [];
  const blockedReasons = [];
  let gated = false;              // the hard downstream-gate latch
  let firstBlockedPhase = null;

  const trip = (name, reasonToken) => {
    gated = true;
    if (firstBlockedPhase === null) firstBlockedPhase = name;
    blockedReasons.push(reasonToken);
  };

  for (const p of ctx.phaseDefs) {
    // (4) HARD DOWNSTREAM GATE: once anything blocked, nothing after it runs — it is gated, not skipped.
    if (gated) {
      tryCheckpoint(ctx, p.name, 'blocked');
      results.push({ name: p.name, state: 'blocked', ran: false, reason: PHASE_BLOCK_REASONS.UPSTREAM_BLOCKED });
      blockedReasons.push(`${PHASE_BLOCK_REASONS.UPSTREAM_BLOCKED}:${p.name}`);
      continue;
    }

    // (1) SKIP vs RUN. A configured omission persists as 'skipped' — only for an OPTIONAL phase.
    if (ctx.skip.has(p.name)) {
      if (!p.optional) {
        tryCheckpoint(ctx, p.name, 'blocked');
        const r = blockedResult(p.name, PHASE_BLOCK_REASONS.REQUIRED_OMITTED, { ran: false });
        results.push(r.result); trip(p.name, r.reason);
        continue;
      }
      const ck = tryCheckpoint(ctx, p.name, 'skipped');
      if (!ck.ok) {
        const r = blockedResult(p.name, PHASE_BLOCK_REASONS.CHECKPOINT_FAILED, { ran: false, error: ck.error });
        results.push(r.result); trip(p.name, r.reason);
        continue;
      }
      results.push({ name: p.name, state: 'skipped', ran: false });
      continue;
    }

    // RUN the phase (review is delegated; every other phase invokes its agent).
    const r = p.review ? await runReviewPhase(ctx, p, order) : await runAgentPhase(ctx, p, order);
    results.push(r.result);
    if (r.blocked) trip(p.name, r.reason);
  }

  // Terminal final-validation gate — only reached when no phase blocked.
  let finalValidation = null;
  if (!gated) {
    finalValidation = await runFinalValidation(ctx);
    if (finalValidation.ok !== true) {
      const reason = finalValidation.missing ? PHASE_BLOCK_REASONS.VALIDATION_MISSING : PHASE_BLOCK_REASONS.VALIDATION_RED;
      trip(FINAL_VALIDATION, `${reason}:${FINAL_VALIDATION}`);
    }
  }

  // Convergence reconciliation against pipeline-state's conjunction.
  const phaseStates = {};
  for (const r of results) phaseStates[r.name] = r.state; // 'done' | 'skipped' | 'blocked'
  const convFailures = convergenceFailures({
    units: ctx.units,
    phases: phaseStates,
    phaseDefs: ctx.phaseDefs.map((p) => ({ name: p.name, optional: p.optional })),
    openItems: ctx.openItems,
    finalValidation: finalValidation ? { passed: finalValidation.ok === true } : null,
  });

  const status = blockedReasons.length ? 'blocked' : 'ok';
  return {
    status,
    exitCode: status === 'ok' ? EXIT.SUCCESS : EXIT.BLOCKED,
    phases: results,
    order,
    blockedReasons,
    firstBlockedPhase,
    finalValidation,
    convergenceFailures: convFailures,
    converged: status === 'ok' && convFailures.length === 0,
  };
}

/**
 * The ship gate: throws PhaseEngineError(exit=BLOCKED) unless the engine converged clean. A blocked or
 * non-converged run structurally cannot be reported done.
 */
export function assertConverged(result) {
  if (!result || result.converged !== true) {
    const why = (result && Array.isArray(result.blockedReasons) && result.blockedReasons.join(', '))
      || (result && Array.isArray(result.convergenceFailures) && result.convergenceFailures.map((f) => f.code).join(', '))
      || 'unknown';
    fail(`phase engine did NOT converge (${why}) — cannot advance to done`, EXIT.BLOCKED);
  }
  return true;
}
