#!/usr/bin/env node
// test-git-workspaces.mjs — behavior contract for autonomous-pipeline/scripts/lib/git-workspaces.mjs.
//
// The controller OWNS worktree creation + scope verification but must be provably read-only toward refs
// (never stages/commits/merges/mutates a branch). These tests drive the ACTUAL module against a REAL
// throwaway git repo (a temp fixture — never the project repo) and assert each load-bearing guarantee:
//   - a run gets an integration worktree; each safe task id gets a task worktree at the recorded base SHA
//   - changed-path + resolved-symlink checks reject traversal, .git metadata, and out-of-scope edits
//   - create/cleanup failure quarantines WITH evidence
//   - the module performs NO staging/commit/merge/branch mutation (HEAD, branches, log, status unchanged;
//     the git allowlist structurally excludes commit/merge/add/reset/…)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ALLOWED_GIT_SUBCOMMANDS, git, assertSafeId, resolveBaseSha,
  createIntegrationWorktree, createTaskWorktree, verifyScope,
  quarantineWorktree, cleanupWorktree,
} from '../autonomous-pipeline/scripts/lib/git-workspaces.mjs';

// ── fixture helpers ─────────────────────────────────────────────────────────────────────────────────
function rawGit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ulpi-gw-'));
  const root = join(dir, 'repo');
  mkdirSync(root, { recursive: true });
  rawGit(root, ['init', '-q', '-b', 'main']);
  rawGit(root, ['config', 'user.email', 'test@example.com']);
  rawGit(root, ['config', 'user.name', 'Test']);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.js'), 'export const x = 1;\n');
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  rawGit(root, ['add', '-A']);
  rawGit(root, ['commit', '-qm', 'base']);
  const baseSha = rawGit(root, ['rev-parse', 'HEAD']).trim();
  const worktreesDir = join(dir, 'worktrees');
  const quarantineDir = join(dir, 'quarantine');
  return { dir, root, baseSha, worktreesDir, quarantineDir };
}

const snapshot = (root) => ({
  head: rawGit(root, ['rev-parse', 'HEAD']).trim(),
  branches: rawGit(root, ['branch', '--list']).trim(),
  logCount: rawGit(root, ['rev-list', '--count', '--all']).trim(),
  status: rawGit(root, ['status', '--porcelain']).trim(),
});

// ── 1. allowlist: the module structurally cannot stage/commit/merge/mutate refs ───────────────────────
test('git allowlist excludes every mutating subcommand', () => {
  for (const forbidden of [
    'commit', 'merge', 'add', 'rebase', 'reset', 'cherry-pick', 'am', 'apply',
    'push', 'pull', 'branch', 'checkout', 'switch', 'stash', 'tag', 'restore',
  ]) {
    assert.ok(!ALLOWED_GIT_SUBCOMMANDS.has(forbidden), `allowlist must not contain ${forbidden}`);
  }
  // and only read-only + worktree subcommands remain
  assert.deepEqual([...ALLOWED_GIT_SUBCOMMANDS].sort(), ['diff', 'ls-files', 'rev-parse', 'status', 'worktree']);
});

test('git() refuses a forbidden subcommand before spawning', () => {
  const { root } = makeRepo();
  assert.throws(() => git(root, ['commit', '-m', 'nope']), /not permitted/);
  assert.throws(() => git(root, ['merge', 'other']), /not permitted/);
  assert.throws(() => git(root, ['add', '.']), /not permitted/);
});

// ── 2. id hygiene ────────────────────────────────────────────────────────────────────────────────────
test('assertSafeId rejects traversal, separators, and option-injection ids', () => {
  for (const good of ['T1', 'TASK-006', 'a.b_c-9']) assert.equal(assertSafeId(good), good);
  for (const bad of ['', '..', '../evil', 'a/b', 'a\\b', '-rf', '.hidden', 'ends-', 'a..b']) {
    assert.throws(() => assertSafeId(bad), /unsafe/, `should reject ${JSON.stringify(bad)}`);
  }
});

// ── 3. creation at recorded base SHA ──────────────────────────────────────────────────────────────────
test('createIntegrationWorktree + createTaskWorktree materialize detached checkouts at the base SHA', () => {
  const { root, baseSha, worktreesDir, quarantineDir } = makeRepo();

  const integ = createIntegrationWorktree({ root, runId: 'run42', baseSha, worktreesDir, quarantineDir });
  assert.equal(integ.role, 'integration');
  assert.equal(integ.baseSha, baseSha);
  assert.ok(existsSync(integ.path), 'integration worktree dir exists');
  assert.equal(rawGit(integ.path, ['rev-parse', 'HEAD']).trim(), baseSha, 'integration rooted at base SHA');

  const t1 = createTaskWorktree({ root, taskId: 'T1', baseSha, worktreesDir, quarantineDir });
  const t2 = createTaskWorktree({ root, taskId: 'T2', baseSha, worktreesDir, quarantineDir });
  for (const t of [t1, t2]) {
    assert.equal(t.role, 'task');
    assert.equal(rawGit(t.path, ['rev-parse', 'HEAD']).trim(), baseSha, `${t.taskId} rooted at base SHA`);
    // detached — no branch ref created for the checkout (abbrev-ref prints HEAD when detached)
    assert.equal(rawGit(t.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'HEAD', `${t.taskId} is detached`);
  }
  assert.notEqual(t1.path, t2.path, 'each task id gets its own worktree');
});

test('createTaskWorktree rejects unsafe ids', () => {
  const { root, baseSha, worktreesDir, quarantineDir } = makeRepo();
  assert.throws(() => createTaskWorktree({ root, taskId: '../escape', baseSha, worktreesDir, quarantineDir }), /unsafe/);
});

// ── 4. scope + symlink verification ───────────────────────────────────────────────────────────────────
test('verifyScope accepts in-scope edits and rejects traversal / .git / out-of-scope / symlink escapes', () => {
  const { root, baseSha, worktreesDir, quarantineDir } = makeRepo();
  const wt = createTaskWorktree({ root, taskId: 'T1', baseSha, worktreesDir, quarantineDir });
  const writeScope = ['src'];

  // clean in-scope edit → ok
  writeFileSync(join(wt.path, 'src', 'app.js'), 'export const x = 2;\n');
  writeFileSync(join(wt.path, 'src', 'new.js'), 'export const y = 3;\n');
  let v = verifyScope({ worktreePath: wt.path, baseSha, writeScope });
  assert.ok(v.ok, `expected clean scope, got ${JSON.stringify(v.violations)}`);
  assert.ok(v.changed.includes('src/new.js'));

  // out-of-scope edit → rejected
  writeFileSync(join(wt.path, 'README.md'), '# hacked\n');
  v = verifyScope({ worktreePath: wt.path, baseSha, writeScope });
  assert.ok(!v.ok);
  assert.ok(v.violations.some((x) => x.path === 'README.md' && x.reason === 'out-of-scope'));

  // symlink escaping the worktree (traversal) → rejected, even though its OWN path is in-scope
  symlinkSync('/etc/passwd', join(wt.path, 'src', 'escape'));
  v = verifyScope({ worktreePath: wt.path, baseSha, writeScope: ['src'] });
  assert.ok(v.violations.some((x) => x.path === 'src/escape' && x.reason === 'symlink-escape'),
    `expected symlink-escape, got ${JSON.stringify(v.violations)}`);

  // dangling relative symlink climbing out of the tree → still caught (logical resolution)
  const { root: r2, baseSha: b2, worktreesDir: w2, quarantineDir: q2 } = makeRepo();
  const wt2 = createTaskWorktree({ root: r2, taskId: 'T1', baseSha: b2, worktreesDir: w2, quarantineDir: q2 });
  symlinkSync('../../../../secret', join(wt2.path, 'src', 'climb'));
  const v2 = verifyScope({ worktreePath: wt2.path, baseSha: b2, writeScope: ['src'] });
  assert.ok(v2.violations.some((x) => x.path === 'src/climb' && x.reason === 'symlink-escape'));
});

test('verifyScope rejects an in-tree symlink pointing at .git metadata', () => {
  const { root, baseSha, worktreesDir, quarantineDir } = makeRepo();
  const wt = createTaskWorktree({ root, taskId: 'T1', baseSha, worktreesDir, quarantineDir });
  // in a linked worktree `.git` is a file, but a symlink whose target resolves to a `.git` component
  // must be refused regardless of existence
  symlinkSync('.git/config', join(wt.path, 'src', 'peek'));
  const v = verifyScope({ worktreePath: wt.path, baseSha, writeScope: ['src'] });
  assert.ok(v.violations.some((x) => x.path === 'src/peek'
    && (x.reason === 'symlink-git-metadata' || x.reason === 'symlink-out-of-scope')),
    `expected git-metadata symlink rejection, got ${JSON.stringify(v.violations)}`);
});

test('verifyScope rejects an in-tree symlink whose target is inside the tree but out of scope', () => {
  const { root, baseSha, worktreesDir, quarantineDir } = makeRepo();
  const wt = createTaskWorktree({ root, taskId: 'T1', baseSha, worktreesDir, quarantineDir });
  symlinkSync('../README.md', join(wt.path, 'src', 'readme-link'));
  const v = verifyScope({ worktreePath: wt.path, baseSha, writeScope: ['src'] });
  assert.ok(v.violations.some((x) => x.path === 'src/readme-link' && x.reason === 'symlink-out-of-scope'),
    `expected symlink-out-of-scope, got ${JSON.stringify(v.violations)}`);
});

test('verifyScope: a poisoned write-scope entry never authorizes an escape', () => {
  const { root, baseSha, worktreesDir, quarantineDir } = makeRepo();
  const wt = createTaskWorktree({ root, taskId: 'T1', baseSha, worktreesDir, quarantineDir });
  writeFileSync(join(wt.path, 'README.md'), '# out\n');
  // '..' / absolute / '.git' entries are inert — the out-of-scope edit stays rejected
  const v = verifyScope({ worktreePath: wt.path, baseSha, writeScope: ['..', '/', '.git', '.'] });
  assert.ok(!v.ok);
  assert.ok(v.violations.some((x) => x.path === 'README.md' && x.reason === 'out-of-scope'));
});

// ── 5. quarantine on failure ──────────────────────────────────────────────────────────────────────────
test('create failure quarantines the blocking path with evidence', () => {
  const { root, baseSha, worktreesDir, quarantineDir } = makeRepo();
  // pre-occupy the target worktree path so `git worktree add` fails
  mkdirSync(worktreesDir, { recursive: true });
  const blocked = join(worktreesDir, 'task-T1');
  writeFileSync(blocked, 'blocker\n');

  let err;
  try { createTaskWorktree({ root, taskId: 'T1', baseSha, worktreesDir, quarantineDir }); }
  catch (e) { err = e; }
  assert.ok(err, 'create must throw on failure');
  assert.ok(err.quarantine, 'error carries quarantine evidence');
  assert.ok(existsSync(err.quarantine.quarantinePath), 'quarantine dir exists');
  const ev = JSON.parse(readFileSync(join(err.quarantine.quarantinePath, 'evidence.json'), 'utf8'));
  assert.match(ev.reason, /create-failed/);
  assert.ok(ev.error.length > 0, 'evidence records the underlying error');
  assert.ok(!existsSync(blocked), 'blocking path was moved into quarantine');
  assert.ok(existsSync(ev.movedPath), 'moved blocker present in quarantine');
});

test('cleanupWorktree quarantines when git worktree remove fails', () => {
  const { root, quarantineDir } = makeRepo();
  const bogus = join(root, 'not-a-registered-worktree');
  const res = cleanupWorktree({ root, worktreePath: bogus, quarantineDir });
  assert.equal(res.removed, false);
  assert.ok(res.quarantine, 'cleanup failure produced quarantine evidence');
  assert.ok(existsSync(join(res.quarantine.quarantinePath, 'evidence.json')));
});

test('quarantineWorktree moves an existing worktree aside and writes evidence', () => {
  const { root, baseSha, worktreesDir, quarantineDir } = makeRepo();
  const wt = createTaskWorktree({ root, taskId: 'T9', baseSha, worktreesDir, quarantineDir });
  const ev = quarantineWorktree({ root, worktreePath: wt.path, quarantineDir, reason: 'manual', error: 'x' });
  assert.ok(!existsSync(wt.path), 'original worktree path moved');
  assert.ok(existsSync(ev.movedPath), 'worktree contents relocated to quarantine');
  assert.ok(existsSync(join(ev.quarantinePath, 'evidence.json')));
});

// ── 6. clean cleanup ──────────────────────────────────────────────────────────────────────────────────
test('cleanupWorktree removes a live worktree', () => {
  const { root, baseSha, worktreesDir, quarantineDir } = makeRepo();
  const wt = createTaskWorktree({ root, taskId: 'T1', baseSha, worktreesDir, quarantineDir });
  assert.ok(existsSync(wt.path));
  const res = cleanupWorktree({ root, worktreePath: wt.path, quarantineDir });
  assert.equal(res.removed, true);
  assert.ok(!existsSync(wt.path));
});

// ── 7. NO ref mutation across the full lifecycle ──────────────────────────────────────────────────────
test('the full create→verify→cleanup lifecycle mutates NO ref, branch, or commit on the target', () => {
  const { root, baseSha, worktreesDir, quarantineDir } = makeRepo();
  const before = snapshot(root);

  const integ = createIntegrationWorktree({ root, runId: 'run1', baseSha, worktreesDir, quarantineDir });
  const t1 = createTaskWorktree({ root, taskId: 'T1', baseSha, worktreesDir, quarantineDir });
  // engineer-style edits happen inside the task worktree — the controller must not react by committing
  writeFileSync(join(t1.path, 'src', 'app.js'), 'export const x = 99;\n');
  verifyScope({ worktreePath: t1.path, baseSha, writeScope: ['src'] });
  cleanupWorktree({ root, worktreePath: t1.path, quarantineDir });
  cleanupWorktree({ root, worktreePath: integ.path, quarantineDir });

  const after = snapshot(root);
  assert.equal(after.head, before.head, 'HEAD unchanged');
  assert.equal(after.branches, before.branches, 'no new/changed branches');
  assert.equal(after.logCount, before.logCount, 'no new commits anywhere');
  assert.equal(after.status, before.status, 'main working tree untouched');
});

// ── 8. resolveBaseSha records a real commit and refuses option-like refs ──────────────────────────────
test('resolveBaseSha resolves HEAD/refs and refuses option-like input', () => {
  const { root, baseSha } = makeRepo();
  assert.equal(resolveBaseSha(root, baseSha), baseSha);
  assert.equal(resolveBaseSha(root, 'main'), baseSha);
  assert.equal(resolveBaseSha(root), baseSha);
  assert.throws(() => resolveBaseSha(root, '--upload-pack=evil'), /option-like/);
});
