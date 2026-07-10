// git-integration.mjs — the coordinator's INTEGRATION + local PUBLICATION engine for the Codex-native
// pipeline. This is the mutating counterpart to git-workspaces.mjs: where the workspace controller is
// provably read-only toward refs (it only adds/removes worktrees), THIS module is the ONE place allowed
// to stage, commit, and advance a ref — and it does so under a strict contract.
//
// Guarantees (each is enforced structurally, not by convention):
//   1. INDEPENDENT validation. The coordinator re-runs the task's slice validate command itself
//      (`runValidation`) — the engineer's self-reported green is never trusted. A red result refuses
//      integration with typed evidence; nothing is staged or committed.
//   2. STAGE ONLY EXPLICIT IN-SCOPE PATHS. Staging goes through `git add -- <p1> <p2> …`; the git() choke
//      point STRUCTURALLY rejects `git add -A`/`.`/`-u`/any flag, so a whole-tree stage is impossible.
//      Scope + symlink-escape are verified with git-workspaces.verifyScope BEFORE staging.
//   3. TRAILERED COMMITS. Every integration commit carries Run-Id / Task-Id / Plan-Id trailers; a missing
//      or unsafe trailer refuses the commit (nothing lands).
//   4. SERIALIZED INTEGRATION. Integrations onto the recorded integration branch are serialized by an
//      atomic mkdir lock (stale locks stolen via atomic rename), so two tasks never interleave / lose an
//      update — the branch grows as a linear chain.
//   5. FAST-FORWARD-ONLY PUBLICATION, ONCE. The final target ref moves exactly once, via a single
//      compare-and-swap `update-ref <target> <new> <old>`. It is allowed ONLY after convergence + final
//      validation + checkpoint durability, and ONLY when the target is INDEPENDENTLY OBSERVED to still
//      equal the recorded base (unchanged target/base). A stale target, a non-fast-forward relation, or a
//      lost CAS race refuses — leaving the target byte-for-byte untouched — and returns typed evidence.
//
// Every EXPECTED failure mode (red validation, empty / out-of-scope changes, missing trailers, conflict,
// stale target, publication race, failed precondition/cleanup) is returned as a typed `{ ok:false, reason,
// evidence, code }` refusal by the orchestrators (`integrateTask`, `publishToTarget`) — never a silent
// success, never a mutated target. Only truly unexpected git errors propagate as throws.
//
// Zero dependencies (node: builtins only). Node 22+.

import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, statSync, renameSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

import { EXIT } from './cli-contract.mjs';
import { verifyScope, assertSafeId } from './git-workspaces.mjs';

// ── typed error ─────────────────────────────────────────────────────────────────────────────────────
// Carries a stable `reason` slug, structured `evidence`, and a pinned EXIT `code` so a refusal can be
// surfaced verbatim by the coordinator (and mapped to a process exit status).
export class IntegrationError extends Error {
  constructor(reason, { message, evidence = {}, code = EXIT.USAGE } = {}) {
    super(message || reason);
    this.name = 'IntegrationError';
    this.reason = reason;
    this.evidence = evidence;
    this.code = code;
  }
}

// Convert a thrown IntegrationError into a typed refusal object; rethrow anything else (a real bug).
function toRefusal(err) {
  if (err instanceof IntegrationError) {
    return { ok: false, reason: err.reason, evidence: err.evidence, code: err.code, message: err.message };
  }
  throw err;
}

// ── git choke point ─────────────────────────────────────────────────────────────────────────────────
// Unlike git-workspaces (read-only toward refs), this module MUST stage/commit/advance a ref — but only
// via an explicit, minimal allowlist. Network/remote ops and history-rewriting ops are FORBIDDEN by name
// so a refactor cannot smuggle a push/rebase/reset/merge in. `add` is additionally constrained (below):
// it may carry NO flags and MUST use an explicit `--` pathspec, so `git add -A`/`.` is structurally out.
export const INTEGRATION_GIT_SUBCOMMANDS = Object.freeze(new Set([
  'rev-parse', 'merge-base', 'status', // read-only observation
  'add', 'commit', 'update-ref',       // the only mutations: stage explicit paths, commit, CAS ref move
]));

export const FORBIDDEN_INTEGRATION_SUBCOMMANDS = Object.freeze(new Set([
  'push', 'pull', 'fetch', 'remote', 'clone',           // network / remote — local publication only
  'rebase', 'reset', 'cherry-pick', 'revert', 'am',      // history rewriting
  'apply', 'merge', 'stash', 'filter-branch',
  'checkout', 'switch', 'branch', 'tag', 'restore', 'worktree', // ref/worktree lifecycle (workspaces owns it)
]));

function gitSpawn(cwd, args) {
  if (!Array.isArray(args) || args.length === 0) throw new Error('git: no subcommand given');
  const sub = args[0];
  if (FORBIDDEN_INTEGRATION_SUBCOMMANDS.has(sub)) {
    throw new Error(`git subcommand forbidden in integration: ${sub} (no remote / history-rewrite / ref-lifecycle ops)`);
  }
  if (!INTEGRATION_GIT_SUBCOMMANDS.has(sub)) {
    throw new Error(`git subcommand not permitted by git-integration: ${sub}`);
  }
  if (sub === 'add') assertSafeAddArgs(args);
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`git ${sub} spawn failed: ${r.error.message}`);
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Throwing wrapper: non-zero exit is an error. Use for mutations/observations where any failure is fatal.
export function git(cwd, args) {
  const r = gitSpawn(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout || `exit ${r.status}`).trim()}`);
  return r.stdout;
}

// Non-throwing wrapper: returns { status, stdout, stderr } so a caller can branch on a specific exit code
// (e.g. `merge-base --is-ancestor` → 0/1, or an `update-ref` CAS mismatch).
export function gitTry(cwd, args) {
  return gitSpawn(cwd, args);
}

// `git add` is the highest-risk call here — enforce EXPLICIT-PATHS-ONLY structurally:
//   * a `--` pathspec separator is REQUIRED,
//   * NO flags may appear before it (so `-A`/`--all`/`-u`/`--update`/`-p` etc. are all rejected),
//   * every pathspec after `--` must be a safe relative path (no `.`/`..`/`.git`/absolute/option-like).
function assertSafeAddArgs(args) {
  const rest = args.slice(1);
  const dd = rest.indexOf('--');
  if (dd === -1) throw new Error("git add must use an explicit '--' pathspec separator (never `git add -A`/`.`)");
  const flags = rest.slice(0, dd);
  if (flags.length) throw new Error(`git add permits no flags before '--' (got ${JSON.stringify(flags)}); stage explicit in-scope paths only`);
  const paths = rest.slice(dd + 1);
  if (paths.length === 0) throw new Error('git add requires at least one explicit path after --');
  for (const p of paths) assertSafeRelPath(p);
}

// ── path / ref / sha hygiene ──────────────────────────────────────────────────────────────────────────
function normRel(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function assertSafeRelPath(p) {
  if (typeof p !== 'string' || p.length === 0) throw new Error('unsafe path: empty');
  if (p.startsWith('-')) throw new Error(`unsafe path: option-like ${JSON.stringify(p)}`);
  if (p.startsWith('/')) throw new Error(`unsafe path: absolute ${JSON.stringify(p)}`);
  if (/[\0\n\r]/.test(p)) throw new Error(`unsafe path: control character in ${JSON.stringify(p)}`);
  const parts = normRel(p).split('/');
  if (parts.includes('..') || parts.includes('.git') || parts.includes('.') || parts.includes('')) {
    throw new Error(`unsafe path: ${JSON.stringify(p)}`);
  }
}

const REF_RE = /^refs\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
function assertSafeRef(ref, label) {
  if (typeof ref !== 'string' || !REF_RE.test(ref) || ref.includes('..') || ref.endsWith('/') || ref.endsWith('.lock')) {
    throw new IntegrationError('bad-ref', { message: `${label} is not a safe fully-qualified ref: ${JSON.stringify(ref)}`, code: EXIT.USAGE });
  }
  return ref;
}

const SHA_RE = /^[0-9a-f]{7,64}$/;
function assertSha(s, label) {
  if (typeof s !== 'string' || !SHA_RE.test(s)) {
    throw new IntegrationError('bad-sha', { message: `${label} is not a git object id: ${JSON.stringify(s)}`, code: EXIT.USAGE });
  }
  return s;
}

// ── independent validation (coordinator-observed truth) ───────────────────────────────────────────────
// Run the task's slice validate command IN the working directory and report its REAL result. This is the
// coordinator's own observation, independent of whatever the engineer subagent claimed. Never throws for a
// red run — a red result is a first-class value the caller gates on.
export function runValidation({ cwd, command, args = [], timeoutMs = 10 * 60 * 1000, env } = {}) {
  if (typeof command !== 'string' || command.length === 0 || command.startsWith('-')) {
    throw new IntegrationError('validation-config', { message: 'validate command must be a non-empty, non-flag string', code: EXIT.USAGE });
  }
  if (!Array.isArray(args)) {
    throw new IntegrationError('validation-config', { message: 'validate args must be an array', code: EXIT.USAGE });
  }
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: env || process.env });
  const stdout = (r.stdout || '').toString();
  const stderr = (r.stderr || '').toString();
  if (r.error) {
    return { ok: false, code: r.status ?? null, signal: r.signal ?? null, stdout, stderr: stderr || r.error.message, command, args };
  }
  return { ok: r.status === 0, code: r.status, signal: r.signal ?? null, stdout, stderr, command, args };
}

// ── commit trailers ───────────────────────────────────────────────────────────────────────────────────
export const TRAILER_KEYS = Object.freeze(['Run-Id', 'Task-Id', 'Plan-Id']);

// Every id trailer must be present AND a safe id (assertSafeId from git-workspaces — no traversal / option
// injection / separators). A missing or unsafe trailer refuses BEFORE any commit is made.
function assertTrailers({ runId, taskId, planId }) {
  const missing = [];
  for (const [k, v] of [['runId', runId], ['taskId', taskId], ['planId', planId]]) {
    if (typeof v !== 'string' || v.trim() === '') { missing.push(k); continue; }
    try { assertSafeId(v, k); } catch { missing.push(k); }
  }
  if (missing.length) throw new IntegrationError('missing-trailer', { evidence: { missing }, code: EXIT.USAGE });
  return { runId, taskId, planId };
}

export function buildCommitMessage({ subject, runId, taskId, planId }) {
  assertTrailers({ runId, taskId, planId });
  if (typeof subject !== 'string' || subject.trim() === '') {
    throw new IntegrationError('missing-subject', { message: 'commit subject is required', code: EXIT.USAGE });
  }
  if (/[\n\r]/.test(subject)) {
    throw new IntegrationError('missing-subject', { message: 'commit subject must be a single line', code: EXIT.USAGE });
  }
  return `${subject}\n\nRun-Id: ${runId}\nTask-Id: ${taskId}\nPlan-Id: ${planId}\n`;
}

// Parse the id trailers back out of a commit message (used to VERIFY a landed commit carries them).
export function parseTrailers(message) {
  const out = {};
  for (const k of TRAILER_KEYS) {
    const m = String(message).match(new RegExp(`^${k}:[ \\t]*(.+?)\\s*$`, 'm'));
    if (m) out[k] = m[1].trim();
  }
  return out;
}

// ── staging (explicit in-scope paths only) ────────────────────────────────────────────────────────────
export function stageInScope({ cwd, paths }) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new IntegrationError('empty-changeset', { message: 'no explicit paths to stage', code: EXIT.USAGE });
  }
  const clean = [...new Set(paths.map((p) => normRel(p)))];
  for (const p of clean) assertSafeRelPath(p);
  git(cwd, ['add', '--', ...clean]); // choke point additionally forbids -A / . / flags
  return { staged: clean };
}

// ── commit ────────────────────────────────────────────────────────────────────────────────────────────
export function commitIntegration({ cwd, subject, runId, taskId, planId }) {
  const message = buildCommitMessage({ subject, runId, taskId, planId }); // throws missing-trailer / missing-subject
  const trailerBlock = `Run-Id: ${runId}\nTask-Id: ${taskId}\nPlan-Id: ${planId}`;
  // Two `-m` args → subject, blank line, trailer block. Commits the INDEX (only what stageInScope staged);
  // never `-a`. `--no-verify` keeps a hostile repo hook out of the coordinator's path.
  git(cwd, ['commit', '--no-verify', '-m', subject, '-m', trailerBlock]);
  const sha = git(cwd, ['rev-parse', 'HEAD']).trim();
  return { sha, message };
}

// ── serialization lock ────────────────────────────────────────────────────────────────────────────────
// Atomic mkdir lock (mkdir is atomic on POSIX). A crashed holder leaves a stale lock (> staleMs); it is
// stolen via an ATOMIC RENAME (single-winner arbiter), never a bare rmdir. Bounded wait, then a typed
// `integration-locked` refusal — the loop never spins forever.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function withIntegrationLock(lockPath, fn, { waitMs = 8000, staleMs = 5000, stepMs = 10 } = {}) {
  const steps = Math.max(1, Math.ceil(waitMs / stepMs));
  for (let i = 0; i < steps; i++) {
    try {
      mkdirSync(lockPath);
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new IntegrationError('integration-locked', { message: `lock parent directory missing: ${lockPath}`, code: EXIT.CHECKPOINT });
      }
      // Held. Steal ONLY if stale, and ONLY via atomic rename (the single-winner arbiter).
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          const tomb = `${lockPath}.dead.${process.pid}.${i}`;
          renameSync(lockPath, tomb); // throws ENOENT for every stealer but the one that wins
          try { rmdirSync(tomb); } catch { /* best effort */ }
        }
      } catch { /* lost the steal race or not stale → wait and retry */ }
      sleep(stepMs);
      continue;
    }
    try { return fn(); }
    finally { try { rmdirSync(lockPath); } catch { /* released even if fn threw */ } }
  }
  throw new IntegrationError('integration-locked', { message: `could not acquire integration lock ${lockPath}`, code: EXIT.CHECKPOINT });
}

// ── integrate one task onto the recorded integration branch (serialized) ──────────────────────────────
// `repoDir` is a working tree checked out ON the integration branch, with THIS task's in-scope changes
// already materialized into it. The call is serialized by the integration lock, so the branch grows as a
// linear chain (base ← task₁ ← task₂ ← …). Every expected failure mode returns a typed refusal and leaves
// the integration branch tip (and therefore the eventual target) untouched.
export function integrateTask(opts) {
  const { repoDir, runId, taskId, planId, lockPath, lockOptions } = opts;
  // Fail fast on trailers so a missing-trailer never even acquires the lock or runs validation.
  try { assertTrailers({ runId, taskId, planId }); } catch (e) { return toRefusal(e); }
  const lp = lockPath || join(repoDir, '.git', 'ulpi-integration.lock');
  try {
    return withIntegrationLock(lp, () => integrateLocked(opts), lockOptions || {});
  } catch (e) {
    return toRefusal(e);
  }
}

function integrateLocked({ repoDir, validate, writeScope, paths, subject, runId, taskId, planId }) {
  const preTip = git(repoDir, ['rev-parse', 'HEAD']).trim();

  // 1. INDEPENDENT validation — the coordinator's own observation, not the engineer's claim.
  const val = runValidation(validate || {});
  if (!val.ok) {
    throw new IntegrationError('validation-red', { evidence: { code: val.code, signal: val.signal, stderr: val.stderr.slice(-2000) }, code: EXIT.BLOCKED });
  }

  // 2. scope + symlink-escape enforcement (reuse git-workspaces.verifyScope, diffing against the PRE-TASK
  //    integration tip so we see exactly THIS task's changes even as the branch accumulates prior tasks).
  const scope = verifyScope({ worktreePath: repoDir, baseSha: preTip, writeScope: writeScope || [] });
  const changed = scope.changed || [];
  if (changed.length === 0) {
    throw new IntegrationError('empty-changeset', { evidence: { preTip }, code: EXIT.USAGE });
  }
  if (!scope.ok) {
    throw new IntegrationError('out-of-scope', { evidence: { violations: scope.violations }, code: EXIT.PREFLIGHT });
  }

  // 3. optional declared-paths allowlist: every observed change must sit within the task's declared paths.
  if (Array.isArray(paths) && paths.length) {
    const declared = paths.map(normRel);
    const stray = changed.filter((c) => !declared.some((d) => c === d || c.startsWith(`${d}/`)));
    if (stray.length) {
      throw new IntegrationError('out-of-scope', { evidence: { stray, declared }, code: EXIT.PREFLIGHT });
    }
  }

  // 4. stage ONLY these explicit in-scope paths (never git add -A), then 5. commit with trailers.
  const { staged } = stageInScope({ cwd: repoDir, paths: changed });
  const { sha, message } = commitIntegration({ cwd: repoDir, subject, runId, taskId, planId });

  return { ok: true, integrated: true, sha, preTip, staged, validation: { code: val.code }, message };
}

// ── precondition gate for publication ─────────────────────────────────────────────────────────────────
// Convergence + final validation + checkpoint durability. When a `checkpointFile` is given these are read
// INDEPENDENTLY from the durable checkpoint (finalize `done` is fail-closed in checkpoint-store, so a
// durable `status:done` already implies convergence + green validation); otherwise explicit booleans are
// used. Caller booleans may only TIGHTEN a checkpoint-derived value, never loosen it.
function gatherPreconditions({ checkpointFile, preconditions = {}, cleanupOk }) {
  const evidence = {};
  let converged;
  let finalValidationGreen;
  let checkpointDurable;

  if (checkpointFile) {
    let doc;
    try { doc = JSON.parse(readFileSync(checkpointFile, 'utf8')); }
    catch (e) { throw new IntegrationError('not-durable', { evidence: { checkpointFile, error: e.message }, code: EXIT.CHECKPOINT }); }
    evidence.checkpointStatus = doc.status;
    evidence.finalValidation = doc.finalValidation || null;
    checkpointDurable = doc.status === 'done';
    converged = checkpointDurable; // done ⇒ converged per checkpoint-store's fail-closed finalize
    finalValidationGreen = (doc.finalValidation && doc.finalValidation.status === 'green') === true;
    if (preconditions.converged === false) converged = false;
    if (preconditions.finalValidationGreen === false) finalValidationGreen = false;
    if (preconditions.checkpointDurable === false) checkpointDurable = false;
  } else {
    converged = preconditions.converged === true;
    finalValidationGreen = preconditions.finalValidationGreen === true;
    checkpointDurable = preconditions.checkpointDurable === true;
    evidence.preconditions = { converged, finalValidationGreen, checkpointDurable };
  }

  return { converged, finalValidationGreen, checkpointDurable, cleanupOk: cleanupOk !== false, evidence };
}

// ── single fast-forward-only publication (compare-and-swap) ────────────────────────────────────────────
// Move the target ref to the integration tip EXACTLY ONCE, and only if every precondition holds AND the
// target is independently observed to still equal the recorded base. The `update-ref <ref> <new> <old>`
// CAS makes the move atomic: if a concurrent writer moved the target after our observation, the CAS fails
// and we report `publication-race` — the target is left exactly as the racer set it, never our value.
export function publishToTarget(opts) {
  try { return publishChecked(opts); }
  catch (e) { return { published: false, ...toRefusal(e) }; }
}

function publishChecked({ repoDir, targetRef, integrationRef, baseSha, checkpointFile, preconditions = {}, cleanupOk = true, beforeUpdateHook }) {
  assertSafeRef(targetRef, 'targetRef');
  assertSafeRef(integrationRef, 'integrationRef');
  assertSha(baseSha, 'baseSha');

  // ── precondition gate ──
  const pc = gatherPreconditions({ checkpointFile, preconditions, cleanupOk });
  if (!pc.checkpointDurable) throw new IntegrationError('not-durable', { evidence: pc.evidence, code: EXIT.CHECKPOINT });
  if (!pc.converged) throw new IntegrationError('not-converged', { evidence: pc.evidence, code: EXIT.BLOCKED });
  if (!pc.finalValidationGreen) throw new IntegrationError('not-converged', { evidence: { ...pc.evidence, detail: 'final-validation-not-green' }, code: EXIT.BLOCKED });
  if (!pc.cleanupOk) throw new IntegrationError('cleanup-failed', { evidence: pc.evidence, code: EXIT.BLOCKED });

  // ── independent target/base observation ──
  const targetSha = git(repoDir, ['rev-parse', '--verify', '--end-of-options', targetRef]).trim();
  if (targetSha !== baseSha) {
    throw new IntegrationError('stale-target', { evidence: { targetSha, baseSha }, code: EXIT.DRIFT });
  }
  const integrationSha = git(repoDir, ['rev-parse', '--verify', '--end-of-options', integrationRef]).trim();
  if (integrationSha === targetSha) {
    throw new IntegrationError('nothing-to-publish', { evidence: { targetSha }, code: EXIT.USAGE });
  }

  // Fast-forward-only: the target must be an ancestor of the integration tip. Otherwise the histories have
  // diverged and a fast-forward is impossible — refuse rather than force.
  const anc = gitTry(repoDir, ['merge-base', '--is-ancestor', targetSha, integrationSha]);
  if (anc.status === 1) {
    throw new IntegrationError('not-fast-forward', { evidence: { targetSha, integrationSha }, code: EXIT.DRIFT });
  }
  if (anc.status !== 0) {
    throw new Error(`git merge-base --is-ancestor failed: ${(anc.stderr || '').trim()}`);
  }

  // Test seam / concurrent-writer window: lets a test simulate a racer winning between observation and CAS.
  if (typeof beforeUpdateHook === 'function') beforeUpdateHook({ repoDir, targetRef, targetSha, integrationSha });

  // ── the single fast-forward move, guarded by a compare-and-swap on the old value ──
  const cas = gitTry(repoDir, ['update-ref', targetRef, integrationSha, baseSha]);
  if (cas.status !== 0) {
    throw new IntegrationError('publication-race', { evidence: { expected: baseSha, stderr: (cas.stderr || '').trim() }, code: EXIT.DRIFT });
  }

  return { published: true, targetRef, integrationRef, from: baseSha, to: integrationSha };
}
