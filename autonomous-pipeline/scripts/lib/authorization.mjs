// authorization.mjs — the capability/authorization controller for the Codex-native pipeline
// coordinator. It answers ONE question, fail-closed, for two privileged transitions:
//
//   (1) plan approval  — may the coordinator START executors against THIS intake+plan+config+base?
//   (2) action capability — may the coordinator perform THIS irreversible action (ship / deploy /
//       publish / remote-merge) right now?
//
// ── Trust model (read this first) ────────────────────────────────────────────────────────────────
// The security boundary is the OUTER, user-run coordinator process plus sandbox isolation of its
// executor children. It is NOT designed to resist a same-UID adversary who can already read and
// rewrite arbitrary files owned by the user — that is explicitly out of scope. What it DOES guarantee,
// against mistakes, drift, replay, auto-chaining, and sandboxed children reaching back:
//
//   • Plan approval is a ONE-USE, hash-bound capability, minted ONLY from the PREPARED window (before
//     any executor exists), written as coordinator-private O_EXCL mode-0600 state that a child worktree
//     never receives. `start` CONSUMES it exactly once via a single-winner atomic rename.
//   • Approval is issued ONLY by an INTERACTIVE operator. A non-interactive/piped invocation, or an
//     executor/adapter context, is REFUSED — so the coordinator can never auto-chain approve→start
//     (a human must sit between mint and consume).
//   • An irreversible request first DURABLY HALTS at `awaiting_authorization` with zero live children
//     and a bound (action, evidence, checkpoint-revision) tuple; a FRESH, action-scoped, TTL-limited
//     capability is consumed immediately before the action. A plan approval NEVER satisfies it.
//   • Every refusal (missing / expired / replayed / revoked / mismatched / symlinked / unsafe-mode /
//     child-issued, and issuance while an executor is active) fails BEFORE the action.
//   • A crash AFTER consume but BEFORE observed completion resolves to `outcome_unknown` and is NEVER
//     auto-retried (a consumed capability cannot be re-issued for the same key).
//
// Zero external deps (node: builtins only). Node 22+. Refusals throw `AuthorizationError` carrying a
// pinned exit code and a machine-readable `.reason`; they never call process.exit.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync } from 'node:fs';
import { join, resolve, sep, isAbsolute } from 'node:path';

import { readDoc, writeDoc, withLock, upgradeDoc } from '../../../checkpoint-resume/scripts/lib/checkpoint-store.mjs';
import { AUTHORIZE_ACTIONS, EXIT } from './cli-contract.mjs';

// ── vocabulary ────────────────────────────────────────────────────────────────────────────────────
export const PLAN_KIND = 'plan';
// A capability kind is either the plan approval or one of the irreversible actions (reused from the CLI
// contract so the two lists can never drift apart).
export const CAP_KINDS = Object.freeze([PLAN_KIND, ...AUTHORIZE_ACTIONS]);
// Where a capability may be minted from. Only the coordinator may mint; an executor/adapter never can.
export const CONTEXTS = Object.freeze(['coordinator', 'executor', 'adapter']);
// The lifecycle status a capability can be in, encoded in the on-disk filename suffix (single-winner
// atomic renames drive the transitions).
export const CAP_STATUSES = Object.freeze(['issued', 'consumed', 'completed', 'revoked']);
// Every refusal reason, exported so callers/tests can pin them. Each fails BEFORE any privileged action.
export const REASONS = Object.freeze([
  'missing', 'expired', 'replayed', 'revoked', 'mismatched', 'symlinked', 'unsafe-mode',
  'child-issued', 'not-interactive', 'child-context', 'executor-active', 'wrong-state',
  'wrong-kind', 'already-issued', 'outcome-unknown', 'checkpoint-io',
]);

const SUFFIX = Object.freeze({
  issued: '.cap.json', consumed: '.consumed.json', completed: '.completed.json', revoked: '.revoked.json',
});
const REQUIRED_PLAN_STATUS = 'prepared';
const HALT_STATUS = 'awaiting_authorization';

// ── error type ──────────────────────────────────────────────────────────────────────────────────────
export class AuthorizationError extends Error {
  constructor(reason, message, code = EXIT.PREFLIGHT) {
    super(message || reason);
    this.name = 'AuthorizationError';
    this.reason = reason;       // one of REASONS
    this.code = code;           // pinned EXIT code (default 3 = preflight / approval-refusal)
  }
}
const REASON_CODE = Object.freeze({ 'checkpoint-io': EXIT.CHECKPOINT, 'outcome-unknown': EXIT.CHECKPOINT });
function refuse(reason, message) { throw new AuthorizationError(reason, message, REASON_CODE[reason] ?? EXIT.PREFLIGHT); }

// ── hashing / canonicalization ────────────────────────────────────────────────────────────────────
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]); return o; }
  return v;
}
const canonical = (v) => JSON.stringify(sortKeys(v));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Content hash for a plan/config/evidence payload. A raw string or Buffer is hashed BYTE-FOR-BYTE (the
// exact bytes the operator approved); an object is canonicalized first (sorted keys) so equal content
// hashes equal regardless of key order.
export function contentSha(x) {
  if (Buffer.isBuffer(x) || typeof x === 'string') return sha256(x);
  if (x === null || x === undefined) refuse('mismatched', 'cannot hash null/undefined payload');
  return sha256(canonical(x));
}

// The digest that a capability BINDS to. The bindings object fully determines it; canonical sorting
// makes it order-insensitive, so a caller's `present` tuple need only carry equal content.
export function digestBindings(bindings) { return sha256(canonical(bindings)); }

const nowIso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// ── id / path hygiene ───────────────────────────────────────────────────────────────────────────────
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function assertSafeId(v, label) {
  if (typeof v !== 'string' || !SAFE_ID.test(v) || v.includes('..')) refuse('wrong-state', `${label} is not a safe id: ${JSON.stringify(v)}`);
  return v;
}
function assertKind(kind) {
  if (!CAP_KINDS.includes(kind)) refuse('wrong-kind', `unknown capability kind ${JSON.stringify(kind)} (expected ${CAP_KINDS.join(' | ')})`);
  return kind;
}
function assertSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    refuse('mismatched', `${label} must be a lowercase sha256 digest`);
  }
  return value;
}
function keyFor(run, kind) { assertSafeId(run, '--run'); assertKind(kind); return `${run}.${kind}`; }
function pathFor(capDir, key, status) { return join(capDir, key + SUFFIX[status]); }

// Resolve a capability's on-disk presence. existsSync follows symlinks; a symlink at the issued path is
// caught separately in `verify` (lstat). Returns the earliest lifecycle stage found.
function locate(capDir, key) {
  for (const status of CAP_STATUSES) {
    const p = pathFor(capDir, key, status);
    if (existsSync(p)) return { status, path: p };
  }
  return { status: 'missing', path: pathFor(capDir, key, 'issued') };
}

// A capability dir MUST live outside every executor worktree — a child must never receive writable
// issuance state or capability material. Purely logical (path.resolve) so it works before the worktree
// is materialized.
export function assertCapabilityDirIsolated(capDir, worktreePaths = []) {
  if (typeof capDir !== 'string' || !isAbsolute(capDir)) refuse('child-context', `capability dir must be an absolute path: ${JSON.stringify(capDir)}`);
  const real = resolve(capDir);
  for (const wt of (Array.isArray(worktreePaths) ? worktreePaths : [])) {
    if (typeof wt !== 'string' || wt.length === 0) continue;
    const w = resolve(wt);
    if (real === w || real.startsWith(w + sep)) {
      refuse('child-context', `capability dir ${capDir} is inside worktree ${wt} — children must not receive issuance state`);
    }
  }
  return true;
}

// ── environment probes (defaults; every entry point also accepts an explicit override) ──────────────
export function isInteractiveOperator(env = process.env, streams = process) {
  if (env.ULPI_NONINTERACTIVE === '1') return false;
  if (env.CI) return false;
  return Boolean(streams.stdin && streams.stdin.isTTY && streams.stdout && streams.stdout.isTTY);
}
export function detectContext(env = process.env) {
  if (env.CODEX_SANDBOX || env.ULPI_ROLE === 'executor') return 'executor';
  if (env.ULPI_ROLE === 'adapter') return 'adapter';
  return 'coordinator';
}

// An executor is "active" if the checkpoint records any live child or any unit is mid-flight. Issuance
// is refused while this is true (a capability may only be minted with no executor running).
export function executorActive(doc) {
  if (!doc) return false;
  if (Number(doc.liveChildren) > 0 || Number(doc.activeExecutors) > 0) return true;
  const units = doc.units || {};
  return Object.values(units).some((u) => u && u.status === 'in_progress');
}

function readCheckpoint(file) {
  if (!existsSync(file)) refuse('checkpoint-io', `checkpoint not found: ${file}`);
  try { return readDoc(file); } catch (e) { refuse('checkpoint-io', `cannot read checkpoint ${file}: ${e.message}`); }
}

// ── checkpoint-revision (binds an action capability to the exact halted state) ──────────────────────
// A stable digest over the state-bearing subset of a checkpoint doc, EXCLUDING volatile timestamps and
// the revision field itself. If any real work changes between halt and consume, this changes → the
// action capability no longer matches → the action is refused (drift).
export function checkpointRevisionOf(doc) {
  const subset = {
    status: doc.status ?? null,
    units: doc.units || {},
    phases: doc.phases || {},
    openItems: doc.openItems || [],
    resolvedItems: doc.resolvedItems || [],
    finalValidation: doc.finalValidation || null,
    action: doc.pendingAuthorization?.action ?? null,
    evidenceSha: doc.pendingAuthorization?.evidenceSha ?? null,
  };
  return sha256(canonical(subset));
}

// ── run-lifecycle transitions this controller owns ──────────────────────────────────────────────────
// Move a run into the PREPARED window (the only state plan approval may be minted from). Locked atomic
// write via the shared checkpoint store — never a parallel implementation.
export function markPrepared(checkpointFile) {
  return withLock(checkpointFile, () => {
    const doc = upgradeDoc(readCheckpoint(checkpointFile));
    if (executorActive(doc)) refuse('executor-active', 'cannot enter PREPARED while an executor is active');
    doc.status = REQUIRED_PLAN_STATUS;
    writeDoc(checkpointFile, doc);
    return { status: REQUIRED_PLAN_STATUS };
  });
}

// Durably HALT a run at `awaiting_authorization` for an irreversible action. Refuses unless there are
// ZERO live children (the action must run against a quiesced tree). Records the action, an evidence
// hash, and the checkpoint-revision hash the operator is authorizing against.
export function haltForAuthorization({ checkpointFile, action, evidence, now = Date.now() }) {
  assertKind(action);
  if (action === PLAN_KIND) refuse('wrong-kind', 'plan is not an irreversible action');
  return withLock(checkpointFile, () => {
    const doc = upgradeDoc(readCheckpoint(checkpointFile));
    if (executorActive(doc)) refuse('executor-active', 'cannot halt for authorization while children are live — quiesce first');
    doc.status = HALT_STATUS;
    doc.pendingAuthorization = { action, evidenceSha: contentSha(evidence), at: nowIso(now) };
    doc.pendingAuthorization.checkpointRevision = checkpointRevisionOf(doc); // excluded from its own input
    writeDoc(checkpointFile, doc);
    return {
      status: HALT_STATUS, action,
      evidenceSha: doc.pendingAuthorization.evidenceSha,
      checkpointRevision: doc.pendingAuthorization.checkpointRevision,
      liveChildren: 0,
    };
  });
}

// ── issuance ──────────────────────────────────────────────────────────────────────────────────────
// The single minting primitive. Interactive-operator-only, coordinator-context-only, executor-idle,
// state-gated, one-per-key, written O_EXCL mode-0600. Every wrapper funnels through this.
function issueCapability({
  capDir, run, kind, bindings, ttlMs,
  interactive, context, checkpointFile, requireStatus, worktreePaths, now = Date.now(),
}) {
  const key = keyFor(run, kind);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) refuse('wrong-state', `--ttl must be a positive number of ms (got ${ttlMs})`);

  // WHO may mint: an interactive operator, in the coordinator context, never a child/adapter.
  const isInteractive = interactive ?? isInteractiveOperator();
  const ctx = context ?? detectContext();
  if (ctx !== 'coordinator') refuse('child-context', `capability may be minted only from the coordinator (got ${ctx})`);
  if (isInteractive !== true) refuse('not-interactive', 'plan/action approval requires an interactive operator — a piped/non-TTY invocation is refused (this is what stops an auto-chained approve→start)');

  // WHERE it is stored must be outside any executor worktree.
  assertCapabilityDirIsolated(capDir, worktreePaths);

  // WHEN: only with no executor active, and only from the required run state.
  if (checkpointFile !== undefined) {
    const doc = readCheckpoint(checkpointFile);
    if (executorActive(doc)) refuse('executor-active', 'refusing to mint a capability while an executor is active');
    if (requireStatus && doc.status !== requireStatus) {
      refuse('wrong-state', `capability may be minted only from ${requireStatus} (run is ${doc.status})`);
    }
  }

  // ONE per key: refuse if any capability (in ANY lifecycle stage) already exists for this key. This is
  // what makes a consumed/outcome_unknown capability non-retryable — it can never be re-minted.
  mkdirSync(capDir, { recursive: true, mode: 0o700 });
  const existing = locate(capDir, key);
  if (existing.status !== 'missing') refuse('already-issued', `a capability for ${key} already exists (status=${existing.status})`);

  const record = {
    kind, run, status: 'issued', issuerContext: 'coordinator',
    issuedAt: nowIso(now), expiresAt: nowIso(now + ttlMs),
    nonce: bindings.nonce, bindings, digest: digestBindings(bindings),
  };
  // O_EXCL (flag 'wx') + mode 0600: atomic create-or-fail, owner-only. A concurrent minter loses with
  // EEXIST rather than clobbering.
  try {
    writeFileSync(pathFor(capDir, key, 'issued'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code === 'EEXIST') refuse('already-issued', `a capability for ${key} already exists`);
    throw e;
  }
  return record;
}

// Plan approval: bind the RAW plan hash + config hash (budget lives in config) + independently captured
// intake-file hash + base SHA + target ref + engine version + nonce. Minted only from PREPARED.
export function issuePlanApproval({
  capDir, run, rawPlan, config, intakeSha, baseSha, targetRef, engineVersion,
  ttlMs, nonce = randomUUID(), interactive, context, checkpointFile, worktreePaths, now = Date.now(),
}) {
  const bindings = {
    kind: PLAN_KIND,
    planSha: contentSha(rawPlan),
    configSha: contentSha(config),
    intakeSha: assertSha256(intakeSha, 'intakeSha'),
    baseSha, targetRef, engineVersion, nonce,
  };
  return issueCapability({
    capDir, run, kind: PLAN_KIND, bindings, ttlMs,
    interactive, context, checkpointFile, requireStatus: REQUIRED_PLAN_STATUS, worktreePaths, now,
  });
}

// Action capability: FRESH, action-scoped, TTL-limited. Bound to the evidence + checkpoint-revision the
// halt recorded (pulled straight from the checkpoint so it matches exactly), plus base/target/engine and
// a fresh nonce. Minted only from `awaiting_authorization` for THIS action. A plan approval can never
// satisfy it (different kind, different key, different bindings).
export function issueActionCapability({
  capDir, run, action, baseSha, targetRef, engineVersion,
  ttlMs, nonce = randomUUID(), interactive, context, checkpointFile, worktreePaths, now = Date.now(),
}) {
  assertKind(action);
  if (action === PLAN_KIND) refuse('wrong-kind', 'plan is not an irreversible action');
  const doc = readCheckpoint(checkpointFile);
  if (doc.status !== HALT_STATUS) refuse('wrong-state', `action capability may be minted only from ${HALT_STATUS} (run is ${doc.status})`);
  if (doc.pendingAuthorization?.action !== action) {
    refuse('wrong-state', `run is halted for ${doc.pendingAuthorization?.action ?? 'no action'}, not ${action}`);
  }
  const bindings = {
    kind: action, action,
    evidenceSha: doc.pendingAuthorization.evidenceSha,
    checkpointRevision: doc.pendingAuthorization.checkpointRevision,
    baseSha, targetRef, engineVersion, nonce,
  };
  return issueCapability({
    capDir, run, kind: action, bindings, ttlMs,
    interactive, context, checkpointFile, requireStatus: HALT_STATUS, worktreePaths, now,
  });
}

// ── verification (pure read; no state change) ───────────────────────────────────────────────────────
// Returns { ok:true, record, path } or { ok:false, reason }. Every failure mode maps to a REASON and is
// resolved BEFORE any consume/rename happens.
export function verifyCapability({ capDir, run, kind, present, now = Date.now() }) {
  const key = keyFor(run, kind);
  const loc = locate(capDir, key);
  if (loc.status !== 'issued') {
    if (loc.status === 'consumed' || loc.status === 'completed') return { ok: false, reason: 'replayed' };
    if (loc.status === 'revoked') return { ok: false, reason: 'revoked' };
    return { ok: false, reason: 'missing' };
  }
  let st;
  try { st = lstatSync(loc.path); } catch { return { ok: false, reason: 'missing' }; }
  if (st.isSymbolicLink()) return { ok: false, reason: 'symlinked' };        // never follow a swapped-in link
  if (!st.isFile()) return { ok: false, reason: 'symlinked' };               // not a regular file
  if (st.mode & 0o077) return { ok: false, reason: 'unsafe-mode' };          // group/world readable/writable
  let rec;
  try { rec = JSON.parse(readFileSync(loc.path, 'utf8')); } catch { return { ok: false, reason: 'mismatched' }; }
  if (rec.status !== 'issued') return { ok: false, reason: 'replayed' };
  if (rec.issuerContext !== 'coordinator') return { ok: false, reason: 'child-issued' };
  if (rec.kind !== kind) return { ok: false, reason: 'wrong-kind' };
  if (!rec.expiresAt || now >= Date.parse(rec.expiresAt)) return { ok: false, reason: 'expired' };
  if (typeof rec.digest !== 'string' || digestBindings(present) !== rec.digest) return { ok: false, reason: 'mismatched' };
  return { ok: true, record: rec, path: loc.path };
}

// ── consume (single-winner, one-use) ────────────────────────────────────────────────────────────────
// Verify, then atomically CONSUME via rename issued→consumed (the single-winner arbiter: a replay or a
// concurrent second consumer loses the rename with ENOENT → `replayed`). The action runs AFTER this.
function consumeCapability({ capDir, run, kind, present, now = Date.now() }) {
  const v = verifyCapability({ capDir, run, kind, present, now });
  if (!v.ok) refuse(v.reason, `capability refused for ${run}.${kind}: ${v.reason}`);
  const key = keyFor(run, kind);
  const consumedPath = pathFor(capDir, key, 'consumed');
  try { renameSync(v.path, consumedPath); }
  catch (e) { if (e.code === 'ENOENT') refuse('replayed', 'capability was consumed concurrently'); throw e; }
  const rec = { ...v.record, status: 'consumed', consumedAt: nowIso(now), present };
  // Post-rename the filename alone already marks it consumed; stamping content is best-effort (a crash
  // here still leaves a consumed-not-completed capability → outcome_unknown on reconcile).
  try { writeFileSync(consumedPath, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 }); } catch { /* filename is authoritative */ }
  return { record: rec, consumedAt: rec.consumedAt };
}

// `start` consumes the plan approval. The coordinator presents freshly-recomputed intake/plan/config
// hashes (so any edited authority/payload no longer matches) plus base/target/engine/nonce.
export function consumePlanApproval({
  capDir, run, rawPlan, config, intakeSha, baseSha, targetRef, engineVersion, nonce, now = Date.now(),
}) {
  const present = {
    kind: PLAN_KIND, planSha: contentSha(rawPlan), configSha: contentSha(config),
    intakeSha: assertSha256(intakeSha, 'intakeSha'),
    baseSha, targetRef, engineVersion, nonce,
  };
  return consumeCapability({ capDir, run, kind: PLAN_KIND, present, now });
}

// Consume the action capability IMMEDIATELY before the irreversible action. The checkpoint-revision is
// recomputed LIVE from the current checkpoint, so any drift since the halt makes it mismatch. A plan
// approval can never satisfy this (kind=action, distinct key). Requires the run still halted for `action`.
export function consumeActionCapability({
  capDir, run, action, checkpointFile, baseSha, targetRef, engineVersion, nonce, now = Date.now(),
}) {
  assertKind(action);
  const doc = readCheckpoint(checkpointFile);
  if (doc.status !== HALT_STATUS) refuse('wrong-state', `run is not awaiting authorization (status=${doc.status})`);
  if (doc.pendingAuthorization?.action !== action) refuse('wrong-state', `run is halted for ${doc.pendingAuthorization?.action ?? 'no action'}, not ${action}`);
  const present = {
    kind: action, action,
    evidenceSha: doc.pendingAuthorization.evidenceSha,
    checkpointRevision: checkpointRevisionOf(doc), // LIVE — drift since halt ⇒ mismatch
    baseSha, targetRef, engineVersion, nonce,
  };
  return consumeCapability({ capDir, run, kind: action, present, now });
}

// ── post-consume lifecycle ────────────────────────────────────────────────────────────────────────
// Mark a consumed capability's action OBSERVED-COMPLETE. Only a consumed capability may be completed.
export function completeCapability({ capDir, run, kind, outcome = 'completed', now = Date.now() }) {
  const key = keyFor(run, kind);
  const loc = locate(capDir, key);
  if (loc.status !== 'consumed') refuse('wrong-state', `cannot complete ${key}: status is ${loc.status} (expected consumed)`);
  let rec;
  try { rec = JSON.parse(readFileSync(loc.path, 'utf8')); } catch { rec = { kind, run }; }
  rec.status = 'completed'; rec.outcome = outcome; rec.completedAt = nowIso(now);
  const completedPath = pathFor(capDir, key, 'completed');
  renameSync(loc.path, completedPath); // atomic consumed→completed; the filename is authoritative
  try { writeFileSync(completedPath, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 }); } catch { /* filename authoritative */ }
  return { status: 'completed', outcome, completedAt: rec.completedAt };
}

// Revoke an unconsumed (issued) capability: rename issued→revoked so a later consume fails `revoked`.
export function revokeCapability({ capDir, run, kind, reason = 'revoked', now = Date.now() }) {
  const key = keyFor(run, kind);
  const loc = locate(capDir, key);
  if (loc.status !== 'issued') refuse('wrong-state', `cannot revoke ${key}: status is ${loc.status} (only an issued capability may be revoked)`);
  let rec;
  try { rec = JSON.parse(readFileSync(loc.path, 'utf8')); } catch { rec = { kind, run }; }
  rec.status = 'revoked'; rec.revokedAt = nowIso(now); rec.revokeReason = reason;
  const revokedPath = pathFor(capDir, key, 'revoked');
  renameSync(loc.path, revokedPath);
  try { writeFileSync(revokedPath, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 }); } catch { /* filename authoritative */ }
  return { status: 'revoked', reason };
}

// Reconcile a capability's true outcome. A consumed-but-never-completed capability is the crash-after-
// consume case: its real-world outcome is UNKNOWN and it is NEVER auto-retried (a consumed capability
// cannot be re-minted for the same key — see issueCapability's one-per-key rule).
export function reconcileCapability({ capDir, run, kind }) {
  const key = keyFor(run, kind);
  const loc = locate(capDir, key);
  if (loc.status === 'consumed') {
    let rec = {};
    try { rec = JSON.parse(readFileSync(loc.path, 'utf8')); } catch { /* filename authoritative */ }
    if (!rec.completedAt) {
      return { status: 'outcome_unknown', retryable: false, consumedAt: rec.consumedAt ?? null, kind, run };
    }
  }
  return { status: loc.status, retryable: false, kind, run };
}
