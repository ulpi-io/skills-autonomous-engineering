#!/usr/bin/env node
// test-git-integration.mjs — behavior contract for autonomous-pipeline/scripts/lib/git-integration.mjs.
//
// git-integration.mjs is the coordinator's MUTATING integration + local-publication engine (distinct from
// the read-only worktree controller in git-workspaces.mjs). These tests drive the ACTUAL module against a
// REAL throwaway git repo (a temp fixture — never the project repo) and assert each load-bearing guarantee:
//   - the git choke point forbids remote / history-rewrite ops and `git add -A`/`.`/flags (explicit paths only)
//   - the coordinator INDEPENDENTLY runs the slice validate; a red run refuses (nothing staged/committed)
//   - integration stages ONLY explicit in-scope paths and commits with Run-Id/Task-Id/Plan-Id trailers
//   - integrations are SERIALIZED onto the integration branch (linear chain) via an atomic lock
//   - final publication is ONE fast-forward CAS update, gated on convergence + validation + durability +
//     an independently-observed unchanged target/base
//   - EVERY failure mode (red validation, empty/out-of-scope, missing trailers, conflict, stale target,
//     race, failed precondition) leaves the TARGET ref byte-for-byte untouched and returns typed evidence
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  INTEGRATION_GIT_SUBCOMMANDS, FORBIDDEN_INTEGRATION_SUBCOMMANDS,
  git, gitTry, runValidation,
  TRAILER_KEYS, buildCommitMessage, parseTrailers,
  stageInScope, commitIntegration, withIntegrationLock,
  integrateTask, publishToTarget, IntegrationError,
} from '../autonomous-pipeline/scripts/lib/git-integration.mjs';

// ── fixture helpers ─────────────────────────────────────────────────────────────────────────────────
function raw(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// A repo with `main` (target) and `ulpi-int-run1` (integration branch) both at the base commit. HEAD is
// checked out ON the integration branch, so `main` is NOT the current worktree branch — the publication
// CAS `update-ref refs/heads/main …` is therefore clean (no checked-out-branch desync).
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ulpi-gi-'));
  const root = join(dir, 'repo');
  mkdirSync(root, { recursive: true });
  raw(root, ['init', '-q', '-b', 'main']);
  raw(root, ['config', 'user.email', 'test@example.com']);
  raw(root, ['config', 'user.name', 'Test']);
  raw(root, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.js'), 'export const x = 1;\n');
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  raw(root, ['add', '-A']);
  raw(root, ['commit', '-qm', 'base']);
  const base = raw(root, ['rev-parse', 'HEAD']).trim();
  raw(root, ['branch', 'ulpi-int-run1', base]);
  raw(root, ['checkout', '-q', 'ulpi-int-run1']);
  return { dir, root, base, integRef: 'refs/heads/ulpi-int-run1', targetRef: 'refs/heads/main' };
}

const refSha = (root, ref) => raw(root, ['rev-parse', ref]).trim();

// A durable, converged checkpoint (finalize `done` is fail-closed → done ⇒ converged + green validation).
function writeCheckpoint(dir, over = {}) {
  const f = join(dir, 'run.json');
  writeFileSync(f, JSON.stringify({ status: 'done', finalValidation: { status: 'green' }, ...over }));
  return f;
}

// A validate command that exits 0 (green) / non-zero (red), without touching the fixture.
const GREEN = { command: 'node', args: ['-e', 'process.exit(0)'] };
const RED = { command: 'node', args: ['-e', 'process.exit(1)'] };

// Standard integration args for a task that edits src/app.js in scope ['src'].
function taskArgs(root, over = {}) {
  return {
    repoDir: root, validate: GREEN, writeScope: ['src'],
    subject: 'integrate task', runId: 'run1', taskId: 'T1', planId: 'plan9',
    lockOptions: { waitMs: 500, staleMs: 60000 },
    ...over,
  };
}

// ── 1. git choke point ────────────────────────────────────────────────────────────────────────────────
test('the integration git allowlist permits only observation + stage/commit/update-ref', () => {
  assert.deepEqual([...INTEGRATION_GIT_SUBCOMMANDS].sort(),
    ['add', 'commit', 'merge-base', 'rev-parse', 'status', 'update-ref']);
  for (const forbidden of ['push', 'pull', 'fetch', 'merge', 'rebase', 'reset', 'cherry-pick', 'checkout', 'branch', 'worktree']) {
    assert.ok(FORBIDDEN_INTEGRATION_SUBCOMMANDS.has(forbidden), `must forbid ${forbidden}`);
    assert.ok(!INTEGRATION_GIT_SUBCOMMANDS.has(forbidden), `must not allow ${forbidden}`);
  }
});

test('git() refuses forbidden and unknown subcommands before spawning', () => {
  const { root } = makeRepo();
  assert.throws(() => git(root, ['push', 'origin', 'main']), /forbidden/);
  assert.throws(() => git(root, ['merge', 'x']), /forbidden/);
  assert.throws(() => git(root, ['reset', '--hard']), /forbidden/);
  assert.throws(() => git(root, ['log']), /not permitted/);
});

test('git add is structurally explicit-paths-only (never -A / . / flags)', () => {
  const { root } = makeRepo();
  writeFileSync(join(root, 'src', 'app.js'), 'export const x = 2;\n');
  assert.throws(() => git(root, ['add', '-A']), /--.*separator|explicit/);
  assert.throws(() => git(root, ['add', '.']), /separator/);
  assert.throws(() => git(root, ['add', '-u', '--', 'src/app.js']), /no flags/);
  assert.throws(() => git(root, ['add', '--', '-rf']), /option-like|unsafe/);
  assert.throws(() => git(root, ['add', '--', '../escape']), /unsafe/);
  assert.throws(() => git(root, ['add', '--', '.git/config']), /unsafe/);
  assert.throws(() => git(root, ['add', '--']), /at least one/);
  // an explicit in-scope path is accepted
  assert.doesNotThrow(() => git(root, ['add', '--', 'src/app.js']));
});

// ── 2. independent validation ─────────────────────────────────────────────────────────────────────────
test('runValidation reports the REAL exit result (coordinator-observed truth)', () => {
  const { root } = makeRepo();
  const green = runValidation({ cwd: root, ...GREEN });
  assert.equal(green.ok, true);
  assert.equal(green.code, 0);
  const red = runValidation({ cwd: root, ...RED });
  assert.equal(red.ok, false);
  assert.equal(red.code, 1);
  // a config error (flag-like command) refuses
  assert.throws(() => runValidation({ cwd: root, command: '--evil' }), IntegrationError);
});

// ── 3. trailers ─────────────────────────────────────────────────────────────────────────────────────
test('buildCommitMessage embeds all three trailers and parseTrailers reads them back', () => {
  const msg = buildCommitMessage({ subject: 'do a thing', runId: 'run1', taskId: 'T7', planId: 'plan2' });
  const t = parseTrailers(msg);
  assert.deepEqual(t, { 'Run-Id': 'run1', 'Task-Id': 'T7', 'Plan-Id': 'plan2' });
  assert.deepEqual(TRAILER_KEYS, ['Run-Id', 'Task-Id', 'Plan-Id']);
});

test('buildCommitMessage refuses a missing/unsafe trailer or multiline subject', () => {
  assert.throws(() => buildCommitMessage({ subject: 's', runId: 'run1', taskId: '', planId: 'p' }), /missing-trailer|Task/i);
  assert.throws(() => buildCommitMessage({ subject: 's', runId: 'run1', taskId: '../evil', planId: 'p' }), IntegrationError);
  assert.throws(() => buildCommitMessage({ subject: 'a\nb', runId: 'run1', taskId: 'T1', planId: 'p' }), /single line/);
});

// ── 4. integrate happy path: explicit-in-scope staging + trailered commit ─────────────────────────────
test('integrateTask stages ONLY the explicit in-scope change and commits with trailers', () => {
  const { root, integRef } = makeRepo();
  const beforeTip = refSha(root, 'HEAD');
  writeFileSync(join(root, 'src', 'app.js'), 'export const x = 42;\n');

  const res = integrateTask(taskArgs(root));
  assert.ok(res.ok, `expected ok, got ${JSON.stringify(res)}`);
  assert.deepEqual(res.staged, ['src/app.js']);
  assert.notEqual(res.sha, beforeTip, 'integration branch tip advanced');

  // the landed commit carries the trailers and touched ONLY src/app.js
  const msg = raw(root, ['log', '-1', '--pretty=%B', integRef]);
  assert.deepEqual(parseTrailers(msg), { 'Run-Id': 'run1', 'Task-Id': 'T1', 'Plan-Id': 'plan9' });
  const files = raw(root, ['show', '--name-only', '--pretty=format:', 'HEAD']).trim().split('\n').filter(Boolean);
  assert.deepEqual(files, ['src/app.js']);
  // worktree is clean (nothing left staged/unstaged) — nothing was wholesale-added
  assert.equal(raw(root, ['status', '--porcelain']).trim(), '');
});

// ── 5. serialized integration → linear chain ──────────────────────────────────────────────────────────
test('two integrations serialize into a linear base ← T1 ← T2 chain, each trailered', () => {
  const { root, base, integRef } = makeRepo();

  writeFileSync(join(root, 'src', 'app.js'), 'export const x = 2;\n');
  const a = integrateTask(taskArgs(root, { taskId: 'T1' }));
  assert.ok(a.ok);

  writeFileSync(join(root, 'src', 'feature.js'), 'export const y = 3;\n');
  const b = integrateTask(taskArgs(root, { taskId: 'T2', subject: 'add feature' }));
  assert.ok(b.ok, `expected ok, got ${JSON.stringify(b)}`);
  assert.deepEqual(b.staged, ['src/feature.js']);

  // linear history: base + T1 + T2 = 3 commits, base is an ancestor of the tip
  assert.equal(raw(root, ['rev-list', '--count', integRef]).trim(), '3');
  assert.equal(gitTry(root, ['merge-base', '--is-ancestor', base, refSha(root, integRef)]).status, 0);
  assert.equal(b.preTip, a.sha, 'T2 was committed on top of T1 (no lost update / interleave)');
  assert.deepEqual(parseTrailers(raw(root, ['log', '-1', '--pretty=%B', 'HEAD'])),
    { 'Run-Id': 'run1', 'Task-Id': 'T2', 'Plan-Id': 'plan9' });
});

test('withIntegrationLock serializes: a held (non-stale) lock yields a bounded integration-locked refusal', () => {
  const { root } = makeRepo();
  const lp = join(root, '.git', 'held.lock');
  mkdirSync(lp); // simulate another integration holding the lock
  writeFileSync(join(root, 'src', 'app.js'), 'export const x = 9;\n');
  const res = integrateTask(taskArgs(root, { lockPath: lp, lockOptions: { waitMs: 150, staleMs: 60000 } }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'integration-locked');
  rmdirSync(lp);
});

// ── 6. failure modes leave the integration tip (and target) untouched ─────────────────────────────────
test('red validation refuses; nothing is staged or committed', () => {
  const { root } = makeRepo();
  const tip = refSha(root, 'HEAD');
  writeFileSync(join(root, 'src', 'app.js'), 'export const x = 5;\n');
  const res = integrateTask(taskArgs(root, { validate: RED }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'validation-red');
  assert.equal(refSha(root, 'HEAD'), tip, 'integration tip unchanged');
  // the change was neither staged nor committed
  assert.ok(raw(root, ['status', '--porcelain']).includes('src/app.js'));
});

test('an out-of-scope edit refuses with typed violations; tip unchanged', () => {
  const { root } = makeRepo();
  const tip = refSha(root, 'HEAD');
  writeFileSync(join(root, 'src', 'app.js'), 'export const x = 6;\n');
  writeFileSync(join(root, 'README.md'), '# hacked\n'); // out of scope ['src']
  const res = integrateTask(taskArgs(root));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'out-of-scope');
  assert.ok(res.evidence.violations.some((v) => v.path === 'README.md'));
  assert.equal(refSha(root, 'HEAD'), tip, 'integration tip unchanged');
});

test('an empty changeset refuses; tip unchanged', () => {
  const { root } = makeRepo();
  const tip = refSha(root, 'HEAD');
  const res = integrateTask(taskArgs(root));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'empty-changeset');
  assert.equal(refSha(root, 'HEAD'), tip);
});

test('a missing trailer refuses before validation/staging; tip unchanged', () => {
  const { root } = makeRepo();
  const tip = refSha(root, 'HEAD');
  writeFileSync(join(root, 'src', 'app.js'), 'export const x = 7;\n');
  const res = integrateTask(taskArgs(root, { planId: '' }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'missing-trailer');
  assert.ok(res.evidence.missing.includes('planId'));
  assert.equal(refSha(root, 'HEAD'), tip);
  // validation never ran / nothing staged — the change is still just an unstaged working edit
  assert.ok(raw(root, ['status', '--porcelain']).includes('src/app.js'));
});

// ── 7. publication: single fast-forward CAS, fully gated ──────────────────────────────────────────────
test('publishToTarget fast-forwards the target ONCE when every precondition holds', () => {
  const { dir, root, base, integRef, targetRef } = makeRepo();
  writeFileSync(join(root, 'src', 'app.js'), 'export const x = 11;\n');
  const a = integrateTask(taskArgs(root));
  assert.ok(a.ok);
  const cp = writeCheckpoint(dir);

  const res = publishToTarget({ repoDir: root, targetRef, integrationRef: integRef, baseSha: base, checkpointFile: cp });
  assert.ok(res.published, `expected published, got ${JSON.stringify(res)}`);
  assert.equal(res.from, base);
  assert.equal(res.to, a.sha);
  assert.equal(refSha(root, targetRef), a.sha, 'target fast-forwarded to the integration tip');
  // true fast-forward: base is an ancestor of the new target
  assert.equal(gitTry(root, ['merge-base', '--is-ancestor', base, a.sha]).status, 0);
});

test('publication refuses on a non-durable / non-converged / non-green checkpoint; target untouched', () => {
  const { dir, root, base, integRef, targetRef } = makeRepo();
  writeFileSync(join(root, 'src', 'app.js'), 'export const x = 12;\n');
  integrateTask(taskArgs(root));

  const running = publishToTarget({ repoDir: root, targetRef, integrationRef: integRef, baseSha: base, checkpointFile: writeCheckpoint(dir, { status: 'running' }) });
  assert.equal(running.published, false);
  assert.equal(running.reason, 'not-durable');
  assert.equal(refSha(root, targetRef), base, 'target untouched');

  const redVal = publishToTarget({ repoDir: root, targetRef, integrationRef: integRef, baseSha: base, checkpointFile: writeCheckpoint(dir, { finalValidation: { status: 'red' } }) });
  assert.equal(redVal.published, false);
  assert.equal(redVal.reason, 'not-converged');
  assert.equal(refSha(root, targetRef), base, 'target untouched');
});

test('publication refuses when cleanup did not succeed; target untouched', () => {
  const { dir, root, base, integRef, targetRef } = makeRepo();
  writeFileSync(join(root, 'src', 'app.js'), 'export const x = 13;\n');
  integrateTask(taskArgs(root));
  const res = publishToTarget({ repoDir: root, targetRef, integrationRef: integRef, baseSha: base, checkpointFile: writeCheckpoint(dir), cleanupOk: false });
  assert.equal(res.published, false);
  assert.equal(res.reason, 'cleanup-failed');
  assert.equal(refSha(root, targetRef), base, 'target untouched');
});

test('publication refuses a STALE target (drifted from recorded base); target untouched', () => {
  const { dir, root, base, integRef, targetRef } = makeRepo();
  writeFileSync(join(root, 'src', 'app.js'), 'export const x = 14;\n');
  const a = integrateTask(taskArgs(root));
  // someone moved main off the recorded base (to the integration tip, a distinct commit)
  raw(root, ['update-ref', targetRef, a.sha]);
  const drifted = refSha(root, targetRef);

  const res = publishToTarget({ repoDir: root, targetRef, integrationRef: integRef, baseSha: base, checkpointFile: writeCheckpoint(dir) });
  assert.equal(res.published, false);
  assert.equal(res.reason, 'stale-target');
  assert.equal(res.evidence.targetSha, drifted);
  assert.equal(refSha(root, targetRef), drifted, 'target left exactly as the drift set it');
});

test('publication refuses a NON-fast-forward integration ref (diverged histories); target untouched', () => {
  const { dir, root, base, targetRef } = makeRepo();
  // build an orphan commit (no parent) → not a descendant of base
  const tree = raw(root, ['write-tree']).trim();
  const orphan = raw(root, ['commit-tree', tree, '-m', 'orphan']).trim();
  raw(root, ['update-ref', 'refs/heads/orphan', orphan]);

  const res = publishToTarget({ repoDir: root, targetRef, integrationRef: 'refs/heads/orphan', baseSha: base, checkpointFile: writeCheckpoint(dir) });
  assert.equal(res.published, false);
  assert.equal(res.reason, 'not-fast-forward');
  assert.equal(refSha(root, targetRef), base, 'target untouched');
});

test('publication refuses a RACE: a concurrent writer wins the CAS window; our value is never forced', () => {
  const { dir, root, base, integRef, targetRef } = makeRepo();
  writeFileSync(join(root, 'src', 'app.js'), 'export const x = 15;\n');
  const a = integrateTask(taskArgs(root));
  // a distinct commit a racer will publish while we are mid-flight
  const tree = raw(root, ['write-tree']).trim();
  const racer = raw(root, ['commit-tree', tree, '-p', base, '-m', 'racer']).trim();
  const cp = writeCheckpoint(dir);

  const res = publishToTarget({
    repoDir: root, targetRef, integrationRef: integRef, baseSha: base, checkpointFile: cp,
    beforeUpdateHook: () => { raw(root, ['update-ref', targetRef, racer, base]); }, // racer wins the window
  });
  assert.equal(res.published, false);
  assert.equal(res.reason, 'publication-race');
  assert.equal(refSha(root, targetRef), racer, 'target holds the racer value, not our integration tip');
  assert.notEqual(refSha(root, targetRef), a.sha);
});

// ── 8. stageInScope / commitIntegration direct contract ───────────────────────────────────────────────
test('stageInScope refuses an empty path list and stages explicit paths otherwise', () => {
  const { root } = makeRepo();
  assert.throws(() => stageInScope({ cwd: root, paths: [] }), /empty-changeset|no explicit/);
  writeFileSync(join(root, 'src', 'app.js'), 'export const x = 21;\n');
  const r = stageInScope({ cwd: root, paths: ['src/app.js'] });
  assert.deepEqual(r.staged, ['src/app.js']);
  assert.ok(raw(root, ['diff', '--cached', '--name-only']).includes('src/app.js'));
});

test('commitIntegration commits the staged index with trailers and returns the new sha', () => {
  const { root } = makeRepo();
  const before = refSha(root, 'HEAD');
  writeFileSync(join(root, 'src', 'app.js'), 'export const x = 22;\n');
  stageInScope({ cwd: root, paths: ['src/app.js'] });
  const { sha } = commitIntegration({ cwd: root, subject: 'commit it', runId: 'run1', taskId: 'T3', planId: 'plan1' });
  assert.notEqual(sha, before);
  assert.equal(sha, refSha(root, 'HEAD'));
  assert.deepEqual(parseTrailers(raw(root, ['log', '-1', '--pretty=%B', 'HEAD'])),
    { 'Run-Id': 'run1', 'Task-Id': 'T3', 'Plan-Id': 'plan1' });
});
