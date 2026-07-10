// budget-ledger.mjs — the immutable termination-set enforcer for the Codex-native pipeline coordinator.
//
// A pipeline run is autonomous, which means it MUST be bounded: it declares a termination set at init and
// can never quietly grow it. This module owns that contract. It does NOT re-implement a state store — it
// imports the ONE locked, atomic checkpoint store (checkpoint-store.mjs) and keeps all budget state in a
// `budget` block inside the same checkpoint file, so every mutation is serialized by the SAME mkdir lock
// and is crash-atomic (tmp + rename). The exit code for a budget stop is pinned by cli-contract.mjs
// (EXIT.BUDGET === 5) — this module never invents an exit meaning.
//
// The immutable termination set, bound into a config hash at init and refused thereafter:
//   • doneCondition            — always 'convergence-v1' (the pipeline-state convergence conjunction)
//   • maxCodexCalls            — hard cap on total Codex executor spawns
//   • maxActiveWallMs          — hard cap on ACTIVE wall time (paused-authorization time excluded)
//   • maxAttemptsPerTask       — per-task attempt cap
//   • maxAttemptsPerPhase      — per-phase attempt cap
//   • maxNoProgressBarriers    — how many consecutive unchanged progress fingerprints are tolerated
//   • escalationTriggers       — the NAMED escalation conditions that force a stop
//
// Honesty about tokens: the Codex CLI cannot bound tokens BEFORE a turn (there is no pre-turn token
// ceiling flag), so a requested HARD TOKEN CEILING is REJECTED as unsupported. We only OBSERVE and report
// token usage from the Codex `--json` JSONL stream after the fact — never enforce it.
//
// Reservation discipline (the anti-oversubscription core): before every spawn the coordinator calls
// reserve(), which ATOMICALLY under the checkpoint lock (a) refuses if any limit is exhausted, else (b)
// consumes one call + one task-attempt + one phase-attempt and HOLDS a slice of the remaining active wall
// as an open segment. Because the read-modify-write is serialized, concurrent reservations can NEVER
// oversubscribe. Each child's timeout = min(call timeout, remaining active wall). A crash leaves the open
// segment behind; reconcileOpenSegments() then CONSERVATIVELY charges the full reserved slice (assume it
// ran to its timeout) — spend is only ever added to, never erased. Resume re-attaches with the SAME limits
// (a different hash is refused) so resume can neither raise a limit nor erase prior spend.

import { readDoc, writeDoc, upgradeDoc, withLock, now } from '../../../checkpoint-resume/scripts/lib/checkpoint-store.mjs';
import { EXIT } from './cli-contract.mjs';
import { createHash } from 'node:crypto';

// ── errors ──────────────────────────────────────────────────────────────────────
export class BudgetError extends Error {
  constructor(message, code = EXIT.USAGE) { super(message); this.name = 'BudgetError'; this.code = code; }
}
const fail = (m, code = EXIT.USAGE) => { throw new BudgetError(m, code); };

// ── the immutable termination-set schema ──────────────────────────────────────────
export const DONE_CONDITION = 'convergence-v1';
export const TERMINATION_KEYS = Object.freeze([
  'doneCondition', 'maxCodexCalls', 'maxActiveWallMs',
  'maxAttemptsPerTask', 'maxAttemptsPerPhase', 'maxNoProgressBarriers', 'escalationTriggers',
]);
// Keys that request a HARD, pre-turn token ceiling. Codex cannot enforce these, so we refuse them loudly
// rather than pretend to honor a bound we cannot keep.
export const FORBIDDEN_TOKEN_KEYS = Object.freeze([
  'maxTokens', 'tokenCeiling', 'maxTokenBudget', 'hardTokenCeiling',
  'tokenLimit', 'maxTokensPerTurn', 'maxTokensTotal', 'maxTokenSpend',
]);
const POSITIVE_INT_KEYS = Object.freeze([
  'maxCodexCalls', 'maxActiveWallMs', 'maxAttemptsPerTask', 'maxAttemptsPerPhase', 'maxNoProgressBarriers',
]);

function isPositiveInt(v) { return Number.isInteger(v) && v > 0; }

// Canonical, key-sorted JSON so the config hash is stable regardless of input key order.
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Validate + normalize a requested termination set into the immutable frozen limits object. Throws a
 * BudgetError (exit=USAGE) on any malformed value, an unknown key, or a forbidden hard-token-ceiling key.
 */
export function normalizeLimits(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('budget limits must be a JSON object');
  }
  // Reject a hard token ceiling FIRST and specifically — this is an honesty guarantee, not a typo.
  for (const k of FORBIDDEN_TOKEN_KEYS) {
    if (k in input) {
      fail(`hard token ceiling '${k}' is UNSUPPORTED: the Codex CLI cannot bound tokens before a turn. ` +
        'Token usage is OBSERVED from the JSONL stream and reported, never enforced. Remove this key.');
    }
  }
  for (const k of Object.keys(input)) {
    if (!TERMINATION_KEYS.includes(k)) fail(`unknown budget limit key '${k}' (allowed: ${TERMINATION_KEYS.join(', ')})`);
  }
  const doneCondition = input.doneCondition ?? DONE_CONDITION;
  if (doneCondition !== DONE_CONDITION) fail(`doneCondition must be '${DONE_CONDITION}' (got ${JSON.stringify(doneCondition)})`);
  for (const k of POSITIVE_INT_KEYS) {
    if (!isPositiveInt(input[k])) fail(`${k} must be a positive integer (got ${JSON.stringify(input[k])})`);
  }
  const triggers = input.escalationTriggers ?? [];
  if (!Array.isArray(triggers) || triggers.some((t) => typeof t !== 'string' || t.trim() === '')) {
    fail('escalationTriggers must be an array of non-empty strings (the NAMED stop conditions)');
  }
  const dedup = [...new Set(triggers)];
  if (dedup.length !== triggers.length) fail('escalationTriggers must not contain duplicates');
  return Object.freeze({
    doneCondition,
    maxCodexCalls: input.maxCodexCalls,
    maxActiveWallMs: input.maxActiveWallMs,
    maxAttemptsPerTask: input.maxAttemptsPerTask,
    maxAttemptsPerPhase: input.maxAttemptsPerPhase,
    maxNoProgressBarriers: input.maxNoProgressBarriers,
    escalationTriggers: Object.freeze([...dedup].sort()),
  });
}

/** The deterministic config hash that BINDS the termination set. Any change of any limit changes it. */
export function computeConfigHash(limits) {
  return 'cfg-' + sha256(JSON.stringify(canonical(limits))).slice(0, 32);
}

// ── budget block accessors ─────────────────────────────────────────────────────────
function freshBudget(limits, at) {
  return {
    configHash: computeConfigHash(limits),
    limits,
    spend: { codexCalls: 0, settledCalls: 0, crashCharges: 0, activeWallMs: 0, attemptsByTask: {}, attemptsByPhase: {} },
    openReservations: {},
    barriers: [],
    observedTokens: { input: 0, output: 0, total: 0, reports: 0 },
    pausedMs: 0,
    pause: null,
    stopped: null,
    createdAt: at,
    updatedAt: at,
  };
}

/** Read the budget block; throws (exit=CHECKPOINT) if it was never initialized. */
export function readBudget(file) {
  const doc = readDoc(file);
  if (!doc.budget) fail(`no budget block in ${file} — call initBudget first`, EXIT.CHECKPOINT);
  return doc.budget;
}

// Read-modify-write the budget block under the shared checkpoint lock. `mutate(budget, doc)` may return a
// value to hand back to the caller; if it returns { __noWrite: true } the doc is NOT rewritten.
function withBudget(file, mutate) {
  return withLock(file, () => {
    const doc = upgradeDoc(readDoc(file));
    if (!doc.budget) fail(`no budget block in ${file} — call initBudget first`, EXIT.CHECKPOINT);
    const ret = mutate(doc.budget, doc);
    if (ret && ret.__noWrite) return ret.value;
    doc.budget.updatedAt = now();
    writeDoc(file, doc);
    return ret;
  });
}

const sumOpenReserved = (b) => Object.values(b.openReservations).reduce((s, seg) => s + seg.reservedMs, 0);

// ── init / immutability ─────────────────────────────────────────────────────────────
/**
 * Bind the immutable termination set into the checkpoint at init. Idempotent for the SAME limits (returns
 * the existing block, spend untouched). A DIFFERENT config hash is refused — that is how "resume cannot
 * raise (or lower) a limit" is enforced. Requires the checkpoint file to already exist (store.init).
 * @returns {{configHash:string, limits:object, created:boolean}}
 */
export function initBudget(file, limitsInput, { at = now() } = {}) {
  const limits = normalizeLimits(limitsInput);
  const hash = computeConfigHash(limits);
  return withLock(file, () => {
    const doc = upgradeDoc(readDoc(file));
    if (doc.budget) {
      if (doc.budget.configHash !== hash) {
        fail(`budget termination set is IMMUTABLE: this run was bound to ${doc.budget.configHash}, ` +
          `refusing to re-bind to ${hash} (resume cannot raise, lower, or otherwise change a limit).`, EXIT.USAGE);
      }
      return { configHash: hash, limits: doc.budget.limits, created: false }; // idempotent — spend preserved
    }
    doc.budget = freshBudget(limits, at);
    writeDoc(file, doc);
    return { configHash: hash, limits, created: true };
  });
}

// ── atomic reservation ────────────────────────────────────────────────────────────
/**
 * Atomically reserve one Codex spawn BEFORE launching it. Under the checkpoint lock: refuse if the run is
 * stopped or any relevant limit is exhausted (NO state change on refusal), else consume one call + one
 * task-attempt + one phase-attempt and HOLD a slice of the remaining active wall as an open segment.
 * @returns {{granted:boolean, reservationId?:string, childTimeoutMs?:number, reasons?:string[], ...}}
 */
export function reserve(file, { task, phase, callTimeoutMs, at = now() } = {}) {
  if (typeof task !== 'string' || task.trim() === '') fail('reserve requires a non-empty task id');
  if (typeof phase !== 'string' || phase.trim() === '') fail('reserve requires a non-empty phase name');
  if (!isPositiveInt(callTimeoutMs)) fail('reserve requires callTimeoutMs as a positive integer (ms)');
  return withBudget(file, (b) => {
    if (b.stopped) {
      return { __noWrite: true, value: { granted: false, stopped: true, reasons: ['budget-stopped'] } };
    }
    const L = b.limits;
    const s = b.spend;
    const tAtt = s.attemptsByTask[task] || 0;
    const pAtt = s.attemptsByPhase[phase] || 0;
    const openMs = sumOpenReserved(b);
    const remainingWall = L.maxActiveWallMs - s.activeWallMs - openMs;
    const reasons = [];
    if (s.codexCalls >= L.maxCodexCalls) reasons.push('max-codex-calls');
    if (tAtt >= L.maxAttemptsPerTask) reasons.push('max-attempts-per-task');
    if (pAtt >= L.maxAttemptsPerPhase) reasons.push('max-attempts-per-phase');
    if (remainingWall <= 0) reasons.push('max-active-wall');
    if (reasons.length) {
      return { __noWrite: true, value: { granted: false, reasons } }; // refusal never mutates state
    }
    // grant: consume the discrete counters and hold a wall slice.
    s.codexCalls += 1;
    s.attemptsByTask[task] = tAtt + 1;
    s.attemptsByPhase[phase] = pAtt + 1;
    const childTimeoutMs = Math.min(callTimeoutMs, remainingWall);
    const reservationId = `r-${s.codexCalls}`; // codexCalls is monotonic under the lock → unique
    b.openReservations[reservationId] = {
      id: reservationId, task, phase, reservedMs: childTimeoutMs, callTimeoutMs, startedAt: at,
    };
    return {
      granted: true,
      reservationId,
      childTimeoutMs,
      remainingCalls: L.maxCodexCalls - s.codexCalls,
      remainingWallMs: remainingWall - childTimeoutMs,
      taskAttempts: s.attemptsByTask[task],
      phaseAttempts: s.attemptsByPhase[phase],
    };
  });
}

/**
 * Settle a completed reservation with its MEASURED active wall. The charge is clamped to the reserved
 * slice (a call can never spend more wall than it reserved). Missing/invalid actualWallMs charges the full
 * reserved slice (conservative). Optional observed `tokens` are accumulated (reported, never enforced).
 */
export function settle(file, reservationId, { actualWallMs, tokens, at = now() } = {}) {
  if (typeof reservationId !== 'string' || reservationId.trim() === '') fail('settle requires a reservationId');
  return withBudget(file, (b) => {
    const seg = b.openReservations[reservationId];
    if (!seg) fail(`unknown or already-settled reservation '${reservationId}'`, EXIT.CHECKPOINT);
    const measured = Number.isFinite(actualWallMs) && actualWallMs >= 0 ? actualWallMs : seg.reservedMs;
    const charged = Math.min(measured, seg.reservedMs);
    b.spend.activeWallMs += charged;
    b.spend.settledCalls += 1;
    delete b.openReservations[reservationId];
    if (tokens) addTokens(b, tokens);
    return { charged, reservedMs: seg.reservedMs, activeWallMs: b.spend.activeWallMs, settledAt: at };
  });
}

/**
 * Reconcile crashed open segments. Any reservation still open (its child never settled — a crash) is
 * CONSERVATIVELY charged its full reserved slice (assume it ran to its timeout) and removed. This only
 * ever ADDS to spend, so a crash-then-resume can never under-count and resume can never erase spend.
 * Call this on resume BEFORE reserving again.
 */
export function reconcileOpenSegments(file, { at = now() } = {}) {
  return withBudget(file, (b) => {
    const charged = [];
    for (const [id, seg] of Object.entries(b.openReservations)) {
      b.spend.activeWallMs += seg.reservedMs;
      b.spend.crashCharges += 1;
      charged.push({ id, task: seg.task, phase: seg.phase, chargedMs: seg.reservedMs });
    }
    b.openReservations = {};
    return { charged, activeWallMs: b.spend.activeWallMs, at };
  });
}

// ── observed tokens (report only, NEVER enforce) ─────────────────────────────────────
function addTokens(b, t) {
  const n = (x) => (Number.isFinite(x) && x >= 0 ? x : 0);
  b.observedTokens.input += n(t.input);
  b.observedTokens.output += n(t.output);
  b.observedTokens.total += n(t.total ?? (n(t.input) + n(t.output)));
  b.observedTokens.reports += 1;
}

/** Accumulate observed token usage (from the Codex JSONL stream). Reported for visibility, not enforced. */
export function reportTokens(file, tokens, { at = now() } = {}) {
  if (tokens === null || typeof tokens !== 'object') fail('reportTokens requires a { input, output, total } object');
  return withBudget(file, (b) => { addTokens(b, tokens); return { observedTokens: { ...b.observedTokens }, at }; });
}

/**
 * Best-effort parse of observed token usage from a Codex `--json` JSONL blob. Pure (no I/O). Sums any
 * `usage`/`token_usage` objects or top-level input_tokens/output_tokens/total_tokens fields it finds.
 * This is OBSERVATION only — there is no pre-turn ceiling to enforce.
 */
export function parseObservedTokensFromJsonl(text) {
  const out = { input: 0, output: 0, total: 0, reports: 0 };
  if (typeof text !== 'string') return out;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let ev; try { ev = JSON.parse(s); } catch { continue; }
    const u = (ev && (ev.usage || ev.token_usage)) || ev;
    if (!u || typeof u !== 'object') continue;
    const i = u.input_tokens ?? u.inputTokens ?? u.prompt_tokens;
    const o = u.output_tokens ?? u.outputTokens ?? u.completion_tokens;
    const t = u.total_tokens ?? u.totalTokens;
    if (i == null && o == null && t == null) continue;
    const num = (x) => (Number.isFinite(x) && x >= 0 ? x : 0);
    out.input += num(i); out.output += num(o);
    out.total += num(t) || (num(i) + num(o));
    out.reports += 1;
  }
  return out;
}

// ── paused-authorization time (excluded from active wall, only at a safe boundary) ───
/**
 * Pause the run for out-of-band authorization (e.g. a human ship approval). ONLY permitted at a durable
 * safe boundary — no open reservations may be in flight — because paused time is EXCLUDED from active
 * wall and we may only exclude time we can prove no child was consuming.
 */
export function pauseForAuthorization(file, { at = now() } = {}) {
  return withBudget(file, (b) => {
    if (Object.keys(b.openReservations).length > 0) {
      fail('cannot pause for authorization with open reservations — not a safe boundary (settle/reconcile first)', EXIT.BLOCKED);
    }
    if (b.pause) fail('already paused for authorization', EXIT.USAGE);
    b.pause = { startedAt: at };
    return { paused: true, at };
  });
}

/**
 * Resume from an authorization pause. The elapsed paused time is RECORDED (pausedMs) and excluded from the
 * active-wall budget — active wall is only ever the sum of charged reservation slices, so idle/paused time
 * is inherently never counted against maxActiveWallMs.
 */
export function resumeFromAuthorization(file, { elapsedMs, at = now() } = {}) {
  return withBudget(file, (b) => {
    if (!b.pause) fail('not paused for authorization', EXIT.USAGE);
    const ms = Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : 0;
    b.pausedMs += ms;
    b.pause = null;
    return { pausedMs: b.pausedMs, excludedMs: ms, at };
  });
}

// ── progress fingerprint + barriers ──────────────────────────────────────────────────
/**
 * The progress fingerprint = integration HEAD + completed unit/phase IDs + resolved finding IDs +
 * validation signature. Two consecutive identical fingerprints mean the run made NO progress across a
 * barrier. Pure, deterministic (order-independent).
 */
export function progressFingerprint({
  integrationHead = '', completedUnits = [], completedPhases = [],
  resolvedFindings = [], validationSignature = '',
} = {}) {
  const canon = {
    integrationHead: String(integrationHead),
    completedUnits: [...completedUnits].map(String).sort(),
    completedPhases: [...completedPhases].map(String).sort(),
    resolvedFindings: [...resolvedFindings].map(String).sort(),
    validationSignature: String(validationSignature),
  };
  return 'fp-' + sha256(JSON.stringify(canon)).slice(0, 24);
}

// The exhausted-limit reasons for the CURRENT budget state (open reserved wall counted against the cap).
function exhaustedReasons(b) {
  const L = b.limits, s = b.spend;
  const reasons = [];
  if (s.codexCalls >= L.maxCodexCalls) reasons.push('max-codex-calls');
  if (s.activeWallMs + sumOpenReserved(b) >= L.maxActiveWallMs) reasons.push('max-active-wall');
  for (const [t, n] of Object.entries(s.attemptsByTask)) if (n >= L.maxAttemptsPerTask) reasons.push(`max-attempts-per-task:${t}`);
  for (const [p, n] of Object.entries(s.attemptsByPhase)) if (n >= L.maxAttemptsPerPhase) reasons.push(`max-attempts-per-phase:${p}`);
  return reasons;
}

/** Read-only: is any limit currently exhausted? Returns the (possibly empty) reason list. */
export function checkExhausted(file) {
  return exhaustedReasons(readBudget(file));
}

/** Read-only durable stop status (null when not stopped). */
export function stopStatus(file) {
  return readBudget(file).stopped;
}

/** Throws (exit=BUDGET) when the run is durably stopped — the gate that blocks any downstream work. */
export function assertNotStopped(file) {
  const st = readBudget(file).stopped;
  if (st) fail(`budget-stopped: ${(st.reasons || []).join(', ')} — no downstream execution/publication/finalization`, EXIT.BUDGET);
}

/**
 * The single budget-gate decision. Records the progress barrier (if a fingerprint is given), then decides
 * whether the run must durably STOP: any exhausted limit, OR maxNoProgressBarriers consecutive unchanged
 * fingerprints, OR a NAMED escalation trigger. A stop is written durably (budget.stopped) and reports
 * converged:false with exit 5 (EXIT.BUDGET). The coordinator must honor this at a safe boundary and run
 * NO downstream execution, publication, or done-finalization.
 *
 * @returns {{stop:boolean, converged:false, exitCode:number, reasons:string[], noProgressStreak:number, safeBoundary:boolean}}
 */
export function evaluate(file, { fingerprint, escalation, at = now() } = {}) {
  return withBudget(file, (b) => {
    if (escalation !== undefined && !b.limits.escalationTriggers.includes(escalation)) {
      fail(`unknown escalation trigger '${escalation}' (immutable set: ${b.limits.escalationTriggers.join(', ') || '<none>'})`, EXIT.USAGE);
    }
    let noProgressStreak = 0;
    if (fingerprint !== undefined) {
      if (typeof fingerprint !== 'string' || fingerprint.trim() === '') fail('fingerprint must be a non-empty string');
      b.barriers.push({ fingerprint, at });
      for (let i = b.barriers.length - 1; i >= 0 && b.barriers[i].fingerprint === fingerprint; i--) noProgressStreak++;
    }
    const reasons = exhaustedReasons(b);
    if (fingerprint !== undefined && noProgressStreak >= b.limits.maxNoProgressBarriers) reasons.push('max-no-progress-barriers');
    if (escalation !== undefined) reasons.push(`escalation:${escalation}`);
    const stop = reasons.length > 0;
    const safeBoundary = Object.keys(b.openReservations).length === 0;
    if (stop && !b.stopped) {
      b.stopped = { at, reasons, converged: false, exitCode: EXIT.BUDGET, safeBoundary };
    }
    return {
      stop,
      converged: false, // the BUDGET gate never asserts convergence — that is pipeline-state's job
      exitCode: stop ? EXIT.BUDGET : EXIT.SUCCESS,
      reasons,
      noProgressStreak,
      safeBoundary,
    };
  });
}
