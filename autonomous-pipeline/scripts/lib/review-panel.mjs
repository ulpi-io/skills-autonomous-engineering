// review-panel.mjs — the REVIEW PANEL for the Codex-native pipeline coordinator.
//
// This owns the review phase's *decision* machinery, kept deliberately SEPARATE from the post-build phase
// runner (which owns process/orchestration). The panel turns "review this change" into a fail-closed,
// evidence-honest verdict that either clears the way to ship prep or BLOCKS it with a typed reason:
//
//   1. DIMENSION DISPATCH under schema + budget. Every REQUIRED review dimension (correctness, security,
//      … — declared by the caller with its own JSON schema) runs, and each dispatch first RESERVES one
//      Codex spawn from the immutable budget ledger. A required dimension that is missing (no function),
//      refused by the budget, dead (threw / null), or malformed → a typed BLOCKED panel. A dimension is
//      NEVER reported "clean" because it failed to run.
//   2. STABLE FINDING IDENTITY. Findings are deduped by a deterministic content id (checkpoint-store's
//      stableId), so the SAME defect surfaced by two lenses collapses to ONE finding that records BOTH
//      originating dimensions (its `origins`). Identity is stable across runs → resume upserts in place.
//   3. SKEPTIC-QUORUM VERIFICATION. Each finding faces a declared panel of INDEPENDENT skeptics prompted
//      to REFUTE it. A finding is REFUTED — dismissed as a false positive — ONLY when the declared
//      independent quorum actually voted and a majority refuted. Dead, duplicate, malformed, or
//      non-independent verifier results are EXCLUDED from the tally (logged in a ledger) and NEVER
//      silently drop the finding: if the independent quorum is not reached, the finding stays
//      UNVERIFIED and OPEN. Fail-closed keeps findings; only a real quorum can kill one.
//   4. EVIDENCE RECONCILIATION. A finding is RESOLVED (cleared as fixed) ONLY by evidence the COORDINATOR
//      itself observed (`observedBy: 'coordinator'`). A dimension's or verifier's self-claim of "fixed"
//      never resolves anything — resolution is the coordinator's observation, not the claimant's word.
//   5. FAIL-CLOSED PANEL OUTCOME. Missing dimensions, budget exhaustion, verifier death, quorum failure,
//      or any unresolved blocker → status:'blocked', exitCode BLOCKED, canAdvanceShipPrep:false. A blocked
//      panel structurally cannot advance ship prep (assertCanAdvanceShipPrep throws).
//
// Imports (does NOT reimplement): pipeline-state (convergence conjunction the ship gate feeds into),
// checkpoint-store (stable ids + the durable open/resolved register), codex-executor (the dimension/
// verifier execution model these fakes stand in for), budget-ledger (per-dimension/per-verifier
// reservation of the immutable termination set). Zero external deps, Node 22+.

import { stableId, item, resolve } from '../../../checkpoint-resume/scripts/lib/checkpoint-store.mjs';
import { reserve, settle } from './budget-ledger.mjs';
import { convergenceFailures } from './pipeline-state.mjs';
import { EXIT } from './cli-contract.mjs';

// ── errors ──────────────────────────────────────────────────────────────────────
export class ReviewPanelError extends Error {
  constructor(message, code = EXIT.USAGE) { super(message); this.name = 'ReviewPanelError'; this.code = code; }
}
const fail = (m, code = EXIT.USAGE) => { throw new ReviewPanelError(m, code); };

// ── typed vocabulary ──────────────────────────────────────────────────────────────
// Per-finding disposition after verification/reconciliation.
export const VERDICTS = Object.freeze(['resolved', 'refuted', 'confirmed', 'unverified']);
// Typed BLOCKED reasons — every path that stops ship prep names itself.
export const PANEL_REASONS = Object.freeze({
  MISSING_DIMENSION: 'missing-dimension',   // a required dimension had no function
  DIMENSION_DEAD: 'dimension-dead',         // a required dimension threw / returned malformed output
  BUDGET_EXHAUSTED: 'budget-exhausted',     // the budget refused a required dimension's reservation
  UNVERIFIED_FINDING: 'unverified-finding', // a finding could not reach an independent quorum (open)
  UNRESOLVED_BLOCKER: 'unresolved-blocker', // a confirmed blocker-severity finding is still open
});
// Why a verifier vote was excluded from the quorum tally (kept in the ledger, never a silent drop).
export const VOTE_EXCLUSIONS = Object.freeze(['dead', 'malformed', 'non-independent', 'duplicate', 'budget']);

const SEVERITY_RANK = Object.freeze({ blocker: 0, concern: 1, nit: 2, fyi: 3 });
// An unknown/absent severity ranks as a blocker — fail-closed: we do not let an unlabeled finding slip.
const rankOf = (sev) => (sev in SEVERITY_RANK ? SEVERITY_RANK[sev] : 0);

// The permissive default dimension schema (callers normally pass a real JSON schema per dimension).
const DEFAULT_SCHEMA = Object.freeze({ type: 'object', required: ['findings'], properties: { findings: { type: 'array' } } });

// ── stable finding identity ─────────────────────────────────────────────────────────
/**
 * The stable content id of a finding. An explicit non-empty `id` wins; otherwise a deterministic hash of
 * the SUBSTANTIVE content (file/line/issue/severity/…) EXCLUDING the reporting dimension — so the same
 * defect seen through two lenses collapses to one identity. Delegates to checkpoint-store.stableId (which
 * already excludes the volatile `at`/`id`), passing content with `dimension`/`origins` stripped.
 */
export function findingId(finding) {
  if (finding && typeof finding === 'object' && typeof finding.id === 'string' && finding.id.trim() !== '') {
    return finding.id;
  }
  const { id, at, dimension, origins, ...content } = finding || {};
  return stableId(content);
}

function isValidDimensionOutput(out) {
  if (!out || typeof out !== 'object' || Array.isArray(out)) return false;
  if (!Array.isArray(out.findings)) return false;
  return out.findings.every((f) => f && typeof f === 'object' && !Array.isArray(f)
    && typeof f.issue === 'string' && f.issue.trim() !== '');
}

function normDimension(d) {
  if (typeof d === 'string') {
    if (d.trim() === '') fail('a dimension name must be a non-empty string');
    return { name: d, required: true, schema: DEFAULT_SCHEMA };
  }
  if (!d || typeof d !== 'object' || typeof d.name !== 'string' || d.name.trim() === '') {
    fail('a dimension spec must be a string name or an object { name, required?, schema? }');
  }
  return { name: d.name, required: d.required !== false, schema: d.schema ?? DEFAULT_SCHEMA };
}

// De-duplicate raw dimension findings by stable identity, merging origins and keeping the MOST SEVERE
// severity (a nit lens must never clobber a blocker lens on the same defect).
function dedupFindings(raws) {
  const byId = new Map();
  for (const f of raws) {
    const id = findingId(f);
    const prev = byId.get(id);
    if (prev) {
      prev.origins.add(f.dimension);
      if (rankOf(f.severity) < rankOf(prev.severity)) prev.severity = f.severity;
    } else {
      byId.set(id, { ...f, id, origins: new Set([f.dimension]) });
    }
  }
  return [...byId.values()];
}

// Strip the internal `origins` Set / redundant `dimension` into a plain serializable record.
function serializeFinding(f) {
  const { origins, dimension, ...rest } = f;
  return { ...rest, id: f.id, origins: [...origins].sort() };
}

// The durable open/resolved-register row for a finding (stable id → idempotent upsert in checkpoint-store).
function toRegisterItem(rec) {
  return {
    id: rec.id, kind: 'review-finding',
    issue: rec.issue, severity: rec.severity ?? 'blocker',
    origins: rec.origins, disposition: rec.disposition,
  };
}

// ── input validation / defaults ─────────────────────────────────────────────────────
function normalizeOptions(opts) {
  const o = opts || {};
  if (typeof o.file !== 'string' || o.file.trim() === '') fail('runReviewPanel requires a checkpoint `file` path (with an initialized budget)');
  if (!Array.isArray(o.dimensions) || o.dimensions.length === 0) {
    fail('runReviewPanel requires a non-empty `dimensions` array — zero dimensions would report a vacuous clean');
  }
  const dimensions = o.dimensions.map(normDimension);
  const dimensionFns = o.dimensionFns;
  if (!dimensionFns || typeof dimensionFns !== 'object' || Array.isArray(dimensionFns)) {
    fail('runReviewPanel requires `dimensionFns` as a map of { <dimension name>: async fn }');
  }
  const verifierPanel = Array.isArray(o.verifierPanel) ? o.verifierPanel : [];
  const verifierFn = typeof o.verifierFn === 'function' ? o.verifierFn : (() => null); // absent verifier ⇒ dead vote ⇒ fail-closed
  const callTimeoutMs = Number.isInteger(o.callTimeoutMs) && o.callTimeoutMs > 0 ? o.callTimeoutMs : 60_000;
  const clock = typeof o.clock === 'function' ? o.clock : () => Date.now();
  const observedEvidence = (o.observedEvidence && typeof o.observedEvidence === 'object' && !Array.isArray(o.observedEvidence)) ? o.observedEvidence : {};
  const phase = typeof o.phase === 'string' && o.phase.trim() !== '' ? o.phase : 'review';
  const persist = o.persist !== false;
  return { file: o.file, phase, dimensions, dimensionFns, verifierPanel, verifierFn, callTimeoutMs, clock, observedEvidence, persist };
}

// ── (1) dimension dispatch under schema + budget ──────────────────────────────────────
async function runDimensions(ctx) {
  const coverage = [];
  const rawFindings = [];
  const blockedReasons = [];
  for (const dim of ctx.dimensions) {
    const fn = ctx.dimensionFns[dim.name];
    if (typeof fn !== 'function') {
      coverage.push({ dimension: dim.name, required: dim.required, ran: false, reason: 'missing' });
      if (dim.required) blockedReasons.push(`${PANEL_REASONS.MISSING_DIMENSION}:${dim.name}`);
      continue;
    }
    // Reserve one Codex spawn BEFORE dispatch — the panel never oversubscribes the immutable budget.
    const r = reserve(ctx.file, { task: `review:${dim.name}`, phase: ctx.phase, callTimeoutMs: ctx.callTimeoutMs });
    if (!r.granted) {
      coverage.push({ dimension: dim.name, required: dim.required, ran: false, reason: 'budget', budget: r.reasons || (r.stopped ? ['budget-stopped'] : []) });
      if (dim.required) blockedReasons.push(`${PANEL_REASONS.BUDGET_EXHAUSTED}:${dim.name}`);
      continue;
    }
    const t0 = ctx.clock();
    let out = null; let dead = false; let error = null;
    try { out = await fn({ name: dim.name, schema: dim.schema, phase: ctx.phase }); }
    catch (e) { dead = true; error = String((e && e.message) || e); }
    settle(ctx.file, r.reservationId, { actualWallMs: Math.max(0, ctx.clock() - t0) });
    if (dead || !isValidDimensionOutput(out)) {
      coverage.push({ dimension: dim.name, required: dim.required, ran: true, ok: false, reason: dead ? 'dead' : 'malformed', error });
      if (dim.required) blockedReasons.push(`${PANEL_REASONS.DIMENSION_DEAD}:${dim.name}`);
      continue;
    }
    coverage.push({ dimension: dim.name, required: dim.required, ran: true, ok: true, count: out.findings.length });
    for (const f of out.findings) rawFindings.push({ ...f, dimension: dim.name });
  }
  return { coverage, rawFindings, blockedReasons };
}

// ── (3) skeptic-quorum verification (independent, adversarial, fail-closed) ─────────────
function isValidVote(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.refuted === 'boolean';
}

async function verifyFinding(ctx, finding) {
  const n = ctx.verifierPanel.length;
  const quorumFloor = Math.max(1, Math.ceil(n / 2)); // majority of the DECLARED panel must actually vote
  const votes = [];
  const ledger = []; // excluded verifier results, with the reason — never a silent drop
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const v = ctx.verifierPanel[i] || {};
    const vid = typeof v.id === 'string' && v.id.trim() !== '' ? v.id : `v${i}`;
    // INDEPENDENCE: a verifier whose origin claimed the finding cannot sit on its own panel.
    if (v.origin !== undefined && finding.origins.has(v.origin)) { ledger.push({ verifier: vid, reason: 'non-independent' }); continue; }
    // DUPLICATE: one identity, one ballot — a repeat cannot pad the quorum.
    if (seen.has(vid)) { ledger.push({ verifier: vid, reason: 'duplicate' }); continue; }
    const r = reserve(ctx.file, { task: `verify:${finding.id}:${vid}`, phase: ctx.phase, callTimeoutMs: ctx.callTimeoutMs });
    if (!r.granted) { ledger.push({ verifier: vid, reason: 'budget', budget: r.reasons }); continue; }
    const t0 = ctx.clock();
    let vote = null; let error = null;
    try { vote = await ctx.verifierFn({ finding, verifier: { ...v, id: vid }, index: i }); }
    catch (e) { error = String((e && e.message) || e); }
    settle(ctx.file, r.reservationId, { actualWallMs: Math.max(0, ctx.clock() - t0) });
    if (!isValidVote(vote)) { ledger.push({ verifier: vid, reason: vote == null ? 'dead' : 'malformed', error }); continue; }
    seen.add(vid);
    votes.push({ verifier: vid, refuted: vote.refuted === true, confidence: vote.confidence, counterexample: vote.counterexample });
  }
  const refutes = votes.filter((x) => x.refuted).length;
  const confirms = votes.length - refutes;
  const quorumReached = votes.length >= quorumFloor;
  let verdict;
  if (!quorumReached) verdict = 'unverified';           // dead/dup/malformed/non-independent starved the quorum
  else if (refutes > confirms) verdict = 'refuted';     // ONLY an independent quorum majority can kill a finding
  else if (confirms > refutes) verdict = 'confirmed';   // a real, still-open finding
  else verdict = 'unverified';                          // tie ⇒ fail-closed: keep the finding
  return { verdict, tally: { valid: votes.length, refutes, confirms, quorumFloor, panel: n }, votes, ledger };
}

// ── (4) evidence reconciliation — ONLY coordinator-observed evidence resolves ────────────
function coordinatorEvidence(finding, observedEvidence) {
  const ev = observedEvidence[finding.id];
  if (ev && typeof ev === 'object' && ev.observedBy === 'coordinator' && ev.evidence != null && ev.evidence !== '') return ev;
  return null;
}

const blocksShipPrep = (rec) => rec.disposition === 'unverified' || (rec.disposition === 'confirmed' && rankOf(rec.severity) === 0);

// ── the panel entrypoint ────────────────────────────────────────────────────────────
/**
 * Run the full review panel and return a typed, fail-closed verdict.
 * @returns {Promise<{status:'ok'|'blocked', canAdvanceShipPrep:boolean, exitCode:number,
 *   blockedReasons:string[], coverage:object[], findings:{resolved,refuted,confirmed,unverified},
 *   open:object[], blocking:object[]}>}
 */
export async function runReviewPanel(opts) {
  const ctx = normalizeOptions(opts);
  const { coverage, rawFindings, blockedReasons } = await runDimensions(ctx);
  const findings = dedupFindings(rawFindings);

  const results = { resolved: [], refuted: [], confirmed: [], unverified: [] };
  for (const f of findings) {
    const ev = coordinatorEvidence(f, ctx.observedEvidence);
    if (ev) { // coordinator observed the fix — resolved WITHOUT spending a verifier reservation
      results.resolved.push({ ...serializeFinding(f), disposition: 'resolved', evidence: ev });
      continue;
    }
    const vr = await verifyFinding(ctx, f);
    const rec = { ...serializeFinding(f), disposition: vr.verdict, tally: vr.tally, votes: vr.votes, ledger: vr.ledger };
    results[vr.verdict].push(rec);
  }

  const open = [...results.confirmed, ...results.unverified];
  const blocking = open.filter(blocksShipPrep);
  for (const rec of blocking) {
    blockedReasons.push(rec.disposition === 'unverified'
      ? `${PANEL_REASONS.UNVERIFIED_FINDING}:${rec.id}`
      : `${PANEL_REASONS.UNRESOLVED_BLOCKER}:${rec.id}`);
  }

  // Durable register: blocking findings land OPEN (they feed convergence's open-register); resolved and
  // refuted findings are recorded then moved to resolvedItems (an audit trail, out of the open register).
  if (ctx.persist) {
    if (blocking.length) item(ctx.file, blocking.map(toRegisterItem));
    const cleared = [...results.resolved, ...results.refuted].map(toRegisterItem);
    if (cleared.length) { item(ctx.file, cleared); resolve(ctx.file, cleared.map((x) => x.id)); }
  }

  const status = blockedReasons.length ? 'blocked' : 'ok';
  return {
    status,
    canAdvanceShipPrep: status === 'ok',
    exitCode: status === 'ok' ? EXIT.SUCCESS : EXIT.BLOCKED,
    blockedReasons,
    coverage,
    findings: results,
    open,
    blocking,
  };
}

/**
 * The ship-prep gate: throws ReviewPanelError(exit=BLOCKED) unless the panel is clean. A blocked panel
 * structurally cannot advance to ship prep.
 */
export function assertCanAdvanceShipPrep(result) {
  if (!result || result.canAdvanceShipPrep !== true) {
    const why = (result && Array.isArray(result.blockedReasons) && result.blockedReasons.join(', ')) || 'unknown';
    fail(`review panel BLOCKED (${why}) — cannot advance ship prep`, EXIT.BLOCKED);
  }
  return true;
}

/**
 * Combined ship-prep readiness: the panel's own blockers PLUS the pipeline's convergence conjunction
 * (imported from pipeline-state). Ship prep is ready only when BOTH are clear. Pure (no I/O).
 * @param {object} panelResult result of runReviewPanel
 * @param {object} [pipelineState] the state passed to pipeline-state.convergenceFailures
 * @returns {{ready:boolean, panelBlockers:string[], convergenceFailures:object[]}}
 */
export function shipPrepReadiness(panelResult, pipelineState = {}) {
  const panelBlockers = (panelResult && Array.isArray(panelResult.blockedReasons)) ? panelResult.blockedReasons : ['no-panel-result'];
  const convFailures = convergenceFailures(pipelineState);
  return {
    ready: panelBlockers.length === 0 && convFailures.length === 0,
    panelBlockers,
    convergenceFailures: convFailures,
  };
}
