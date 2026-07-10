// git-workspaces.mjs — the Git worktree + scope controller for the Codex-native pipeline coordinator.
//
// This module OWNS worktree lifecycle (create at a recorded base SHA, verify a task's edits are inside
// its declared write scope, quarantine on failure, clean up) but is DELIBERATELY read-only toward refs:
// it NEVER stages, commits, merges, rebases, resets, or otherwise mutates a branch. Integration is the
// coordinator's job — this controller's only mutation is `git worktree add/remove/prune` (isolated
// checkouts) plus filesystem moves into a quarantine dir. Every git call funnels through `git()`, which
// enforces an ALLOWLIST of subcommands so a refactor cannot silently introduce a commit/merge.
//
// All paths are treated as untrusted: task/run IDs are validated (no traversal, no leading-dash option
// injection, no separators); changed paths and their RESOLVED symlink targets are checked against the
// write scope and rejected for traversal, `.git` metadata, or out-of-scope escape BEFORE a result can be
// integrated. child_process runs git plumbing directly (execFileSync, no shell → no word-splitting).
//
// Zero dependencies (node: builtins only). Node 22+.

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, renameSync, writeFileSync,
  realpathSync, lstatSync, readlinkSync,
} from 'node:fs';
import {
  join, dirname, basename, resolve, relative, isAbsolute, sep,
} from 'node:path';

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// ── git choke point ───────────────────────────────────────────────────────────────────────────────
// The ONLY git subcommands this controller may ever run. `worktree` covers add/remove/prune/list; the
// rest are strictly read-only (rev-parse/diff/ls-files/status). commit, merge, add, rebase, reset,
// cherry-pick, am, apply, push, pull, branch, checkout, switch, stash, tag, restore — all ABSENT by
// design, so the module structurally cannot stage/commit/merge/mutate a ref.
export const ALLOWED_GIT_SUBCOMMANDS = Object.freeze(
  new Set(['rev-parse', 'worktree', 'diff', 'ls-files', 'status']),
);

export function git(cwd, args) {
  if (!Array.isArray(args) || !args.length) throw new Error('git: no subcommand given');
  const sub = args[0];
  if (!ALLOWED_GIT_SUBCOMMANDS.has(sub)) {
    throw new Error(
      `git subcommand not permitted by git-workspaces: ${sub} ` +
      '(this controller never stages/commits/merges/mutates refs)',
    );
  }
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const stderr = e && e.stderr ? String(e.stderr).trim() : '';
    throw new Error(`git ${sub} failed: ${stderr || (e && e.message) || 'unknown'}`);
  }
}

// ── id / path hygiene ─────────────────────────────────────────────────────────────────────────────
// A safe id is what we splice into filesystem paths (worktree dir names). Must start AND end with an
// alphanumeric (blocks leading `-` option-injection and leading `.`), separators/`..` rejected.
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function assertSafeId(id, kind = 'id') {
  if (typeof id !== 'string' || id.length === 0) throw new Error(`unsafe ${kind}: empty`);
  if (id.length > 128) throw new Error(`unsafe ${kind}: too long (${id.length})`);
  if (id.includes('..')) throw new Error(`unsafe ${kind}: traversal in ${JSON.stringify(id)}`);
  if (id.includes('/') || id.includes('\\')) throw new Error(`unsafe ${kind}: separator in ${JSON.stringify(id)}`);
  if (!SAFE_ID.test(id)) throw new Error(`unsafe ${kind}: ${JSON.stringify(id)}`);
  return id;
}

// A write-scope entry only GRANTS scope if it is itself benign: relative, no `..`, no `.git`, not a
// bare `.`. A poisoned scope entry can therefore never authorize an escape — it is simply inert.
function safeScopeEntry(s) {
  if (typeof s !== 'string' || s.length === 0) return false;
  if (isAbsolute(s)) return false;
  const parts = normalizeRel(s).split('/');
  if (parts.includes('..') || parts.includes('.git') || parts.includes('.') || parts.includes('')) return false;
  return true;
}

function normalizeRel(p) {
  return String(p).split(sep).join('/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function inScope(p, writeScope) {
  const path = normalizeRel(p);
  if (path === '') return false;
  return (Array.isArray(writeScope) ? writeScope : []).some((raw) => {
    if (!safeScopeEntry(raw)) return false;
    const s = normalizeRel(raw);
    return path === s || path.startsWith(`${s}/`);
  });
}

// ── base SHA ──────────────────────────────────────────────────────────────────────────────────────
// Record the immutable commit a worktree is rooted at. `ref` may be a SHA, a branch, or omitted (HEAD).
export function resolveBaseSha(root, ref) {
  if (ref != null) {
    if (typeof ref !== 'string' || ref.length === 0) throw new Error('base ref: empty');
    if (ref.startsWith('-')) throw new Error(`base ref: refuses option-like value ${JSON.stringify(ref)}`);
    // `--end-of-options` stops any remaining value being parsed as a flag; ^{commit} peels tags.
    return git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  }
  return git(root, ['rev-parse', 'HEAD']).trim();
}

// ── worktree creation ─────────────────────────────────────────────────────────────────────────────
// Detached checkout at the recorded base SHA — NO branch ref is created (nothing to mutate/leak). The
// coordinator, which owns integration, layers its own refs on top when it merges results.
function addWorktree({ root, path: wtPath, sha, quarantineDir, label }) {
  try {
    if (existsSync(wtPath)) throw new Error(`worktree path already exists: ${wtPath}`);
    mkdirSync(dirname(wtPath), { recursive: true });
    git(root, ['worktree', 'add', '--detach', wtPath, sha]);
    return { path: wtPath, baseSha: sha, detached: true };
  } catch (err) {
    // Create failure must never leave a half-materialized checkout in place: quarantine (with
    // evidence) and re-throw so the caller can decide, carrying the evidence on the error.
    const q = quarantineWorktree({
      root, worktreePath: wtPath, quarantineDir,
      reason: `create-failed:${label}`, error: err.message,
    });
    const e = new Error(`worktree create failed (${label}): ${err.message}`);
    e.quarantine = q;
    throw e;
  }
}

export function createIntegrationWorktree({ root, runId, baseSha, worktreesDir, quarantineDir }) {
  assertSafeId(runId, 'runId');
  const sha = resolveBaseSha(root, baseSha);
  const wtPath = join(worktreesDir, `integration-${runId}`);
  const qDir = quarantineDir || join(worktreesDir, '.quarantine');
  const res = addWorktree({ root, path: wtPath, sha, quarantineDir: qDir, label: `integration:${runId}` });
  return { ...res, runId, role: 'integration' };
}

export function createTaskWorktree({ root, taskId, baseSha, worktreesDir, quarantineDir }) {
  assertSafeId(taskId, 'taskId');
  const sha = resolveBaseSha(root, baseSha);
  const wtPath = join(worktreesDir, `task-${taskId}`);
  const qDir = quarantineDir || join(worktreesDir, '.quarantine');
  const res = addWorktree({ root, path: wtPath, sha, quarantineDir: qDir, label: `task:${taskId}` });
  return { ...res, taskId, role: 'task' };
}

// ── scope + symlink verification ────────────────────────────────────────────────────────────────────
// List every path that changed in the worktree relative to its base SHA: tracked diffs (committed,
// staged, or unstaged — `git diff <base>` compares base→worktree) plus untracked files. `-z` keeps
// paths with odd bytes intact.
function listChangedPaths(worktreePath, baseSha) {
  const split = (s) => (s ? s.split('\0').filter(Boolean) : []);
  const tracked = git(worktreePath, ['diff', '--name-only', '-z', '--end-of-options', baseSha, '--']);
  const untracked = git(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set([...split(tracked), ...split(untracked)])];
}

// Verify a task's edits are integrable: every changed path AND every resolved symlink target must sit
// inside the declared write scope. Rejects traversal, `.git` metadata, and out-of-scope escapes. Pure
// (read-only git + fs stat) — returns a verdict, never throws for a policy violation.
export function verifyScope({ worktreePath, baseSha, writeScope }) {
  const real = realpathSync(worktreePath); // canonical worktree root for containment math
  const changed = listChangedPaths(worktreePath, baseSha);
  const violations = [];

  for (const p of changed) {
    const norm = normalizeRel(p);
    const parts = norm.split('/');

    if (isAbsolute(p) || norm === '') { violations.push({ path: p, reason: 'malformed' }); continue; }
    if (parts.includes('.git')) { violations.push({ path: p, reason: 'git-metadata' }); continue; }
    if (parts.includes('..')) { violations.push({ path: p, reason: 'traversal' }); continue; }
    if (!inScope(norm, writeScope)) { violations.push({ path: p, reason: 'out-of-scope' }); continue; }

    // Symlink escape: an in-scope symlink whose TARGET leaves the worktree, points at `.git`, or lands
    // outside the write scope is a scope breakout dressed as an in-scope edit. Resolve LOGICALLY (via
    // path.resolve) so dangling links (target does not exist yet) are still caught.
    const abs = join(real, norm);
    let st;
    try { st = lstatSync(abs); } catch { st = null; }
    if (st && st.isSymbolicLink()) {
      let target;
      try { target = readlinkSync(abs); } catch { target = ''; }
      const resolvedAbs = resolve(dirname(abs), target);
      const rel = relative(real, resolvedAbs);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        violations.push({ path: p, reason: 'symlink-escape', target }); continue;
      }
      const resolvedRel = normalizeRel(rel);
      if (resolvedRel.split('/').includes('.git')) {
        violations.push({ path: p, reason: 'symlink-git-metadata', target: resolvedRel }); continue;
      }
      if (!inScope(resolvedRel, writeScope)) {
        violations.push({ path: p, reason: 'symlink-out-of-scope', target: resolvedRel }); continue;
      }
    }
  }

  return { ok: violations.length === 0, violations, changed };
}

// ── quarantine + cleanup ────────────────────────────────────────────────────────────────────────────
// Move a (possibly half-broken) worktree aside into a timestamped quarantine dir and drop an
// evidence.json describing what happened. Best-effort and NON-THROWING: if the move itself fails
// (cross-device / busy) it records that in the evidence rather than exploding.
export function quarantineWorktree({ root, worktreePath, quarantineDir, reason = '', error = '' }) {
  const qRoot = quarantineDir || join(dirname(worktreePath), '.quarantine');
  mkdirSync(qRoot, { recursive: true });
  const stamp = now().replace(/[:.]/g, '-');
  const base = basename(worktreePath) || 'worktree';
  const dest = join(qRoot, `${base}.${stamp}.${process.pid}`);
  mkdirSync(dest, { recursive: true });

  let movedPath = null;
  let moveError = '';
  if (existsSync(worktreePath)) {
    const target = join(dest, base);
    try { renameSync(worktreePath, target); movedPath = target; }
    catch (e) { moveError = `move-failed:${e.message}`; }
  }
  // Prune the worktree admin metadata git may still hold for the moved/broken path (best-effort).
  try { git(root, ['worktree', 'prune']); } catch { /* non-fatal */ }

  const evidence = {
    at: now(), worktreePath, quarantinePath: dest, movedPath, reason,
    error: [error, moveError].filter(Boolean).join('; '),
  };
  writeFileSync(join(dest, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

// Remove a worktree. On failure, quarantine (with evidence) rather than leave a wedged checkout.
export function cleanupWorktree({ root, worktreePath, quarantineDir }) {
  try {
    git(root, ['worktree', 'remove', '--force', worktreePath]);
    return { removed: true, path: worktreePath };
  } catch (err) {
    const q = quarantineWorktree({
      root, worktreePath, quarantineDir, reason: 'cleanup-failed', error: err.message,
    });
    return { removed: false, path: worktreePath, quarantine: q };
  }
}
