#!/usr/bin/env node
// test-build-engine.mjs — behavior contract for autonomous-pipeline/scripts/lib/build-engine.mjs.
//
// build-engine.mjs is the deterministic DAG build driver: it runs an approved topological plan layer by
// layer, executing each layer's independent tasks CONCURRENTLY but only in DISTINCT task worktrees, and it
// integrates a task ONLY when the COORDINATOR independently confirms the work (never on the agent's word).
// These tests drive the ACTUAL module against a REAL throwaway git repo + checkpoint (never the project
// state) with a FAKE executor (no real codex / network) and prove each load-bearing guarantee:
//   1. independent tasks in a layer run concurrently in distinct worktrees; layers form a barrier.
//   2. the agent's built:true CANNOT override a red coordinator validation, empty/out-of-scope changes,
//      a blocked/missing review, or a failed integration.
//   3. resume skips only commits reachable from the integration branch, reconciles a missing write from the
//      commit trailer, and treats a stale `done` record (no reachable commit) as a durable blocker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { init as ckInit, unit as ckUnit, readDoc } from '../checkpoint-resume/scripts/lib/checkpoint-store.mjs';
import { initBudget } from '../autonomous-pipeline/scripts/lib/budget-ledger.mjs';
import { integrateTask } from '../autonomous-pipeline/scripts/lib/git-integration.mjs';
import {
  runBuild, runTask, reconcileResume, integratedTaskIds, BuildEngineError,
} from '../autonomous-pipeline/scripts/lib/build-engine.mjs';

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────────
function raw(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// A repo where the MAIN checkout sits ON the integration branch (ulpi-int-run1). The integration worktree
// IS this main checkout (integrationDir === root); task worktrees are added detached off it. This mirrors
// git-integration's fixture but also serves as the worktree host for git-workspaces.
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ulpi-be-'));
  const root = join(dir, 'repo');
  mkdirSync(root, { recursive: true });
  raw(root, ['init', '-q', '-b', 'main']);
  raw(root, ['config', 'user.email', 'test@example.com']);
  raw(root, ['config', 'user.name', 'Test']);
  raw(root, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'base.js'), 'export const base = 1;\n');
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  raw(root, ['add', '-A']);
  raw(root, ['commit', '-qm', 'base']);
  const base = raw(root, ['rev-parse', 'HEAD']).trim();
  raw(root, ['branch', 'ulpi-int-run1', base]);
  raw(root, ['checkout', '-q', 'ulpi-int-run1']);
  const worktreesDir = join(dir, 'wt');
  return { dir, root, base, worktreesDir, integrationRef: 'refs/heads/ulpi-int-run1', targetRef: 'refs/heads/main' };
}

const refSha = (root, ref) => raw(root, ['rev-parse', ref]).trim();
const commitCount = (root, ref) => Number(raw(root, ['rev-list', '--count', ref]).trim());

// A validate command that exits 0 (green) / non-zero (red) without touching the fixture.
const GREEN = { command: 'node', args: ['-e', 'process.exit(0)'] };
const RED = { command: 'node', args: ['-e', 'process.exit(1)'] };

// Initialize a locked checkpoint with a budget generous enough for the plan.
function makeCheckpoint(dir, units) {
  const file = join(dir, 'run.json');
  ckInit(file, { task: 'build-engine test', id: 'run1', units });
  initBudget(file, {
    maxCodexCalls: 100, maxActiveWallMs: 10 * 60 * 1000,
    maxAttemptsPerTask: 10, maxAttemptsPerPhase: 100, maxNoProgressBarriers: 10,
    escalationTriggers: [],
  });
  return file;
}

// A fake executor that writes each task's declared path (spec.paths[0]) with unique content. Optional
// `onEnter` lets a test observe/gate concurrency; `mutate` overrides what is written (empty / out of scope).
function makeExecutor({ onEnter, mutate } = {}) {
  return async ({ taskId, spec, worktree, baseSha }) => {
    if (onEnter) await onEnter({ taskId, worktree, baseSha });
    if (mutate) { await mutate({ taskId, spec, worktree }); return { built: true }; }
    const rel = spec.paths[0];
    const abs = join(worktree, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `export const ${taskId} = ${JSON.stringify(taskId)};\n`);
    return { built: true };
  };
}

const okReview = async () => ({ canAdvance: true });

function baseOpts(fx, file, plan, over = {}) {
  return {
    root: fx.root, integrationDir: fx.root, integrationRef: fx.integrationRef, targetRef: fx.targetRef,
    worktreesDir: fx.worktreesDir, baseSha: fx.base, checkpointFile: file,
    runId: 'run1', planId: 'plan9', plan,
    validateFor: () => GREEN, review: okReview,
    lockOptions: { waitMs: 1000, staleMs: 60000 },
    ...over,
  };
}

// ── 1. concurrency in DISTINCT worktrees + layer barrier ──────────────────────────────────────────────
test('a layer runs independent tasks concurrently in distinct worktrees; layers form a barrier', async () => {
  const fx = makeRepo();
  const plan = {
    layers: [['A', 'B'], ['C']],
    tasks: {
      A: { writeScope: ['src'], paths: ['src/a.js'] },
      B: { writeScope: ['lib'], paths: ['lib/b.js'] },
      C: { writeScope: ['app'], paths: ['app/c.js'] },
    },
  };
  const file = makeCheckpoint(fx.dir, ['A', 'B', 'C']);

  const events = [];
  const worktreeOf = new Map();
  // Concurrency latch: A and B must BOTH enter the executor before either proceeds. If the driver ran them
  // serially, the second never enters and the gate rejects (fast, deterministic — no hang).
  let entered = 0; let release;
  const gate = new Promise((res, rej) => {
    release = res;
    const t = setTimeout(() => rej(new Error('no concurrency: layer-1 tasks did not run in parallel')), 5000);
    if (t.unref) t.unref();
  });
  const onEnter = async ({ taskId, worktree }) => {
    worktreeOf.set(taskId, worktree);
    events.push({ taskId, ev: 'enter', t: process.hrtime.bigint() });
    if (taskId === 'A' || taskId === 'B') {
      if (++entered === 2) release();
      await gate;
    }
    events.push({ taskId, ev: 'work', t: process.hrtime.bigint() });
  };

  const res = await runBuild(baseOpts(fx, file, plan, { executor: makeExecutor({ onEnter }) }));

  assert.equal(res.status, 'ok', `expected ok, got ${JSON.stringify(res.blocked)}`);
  assert.deepEqual([...res.integrated].sort(), ['A', 'B', 'C']);

  // DISTINCT worktrees: every task got its own, none equal to the integration worktree.
  const paths = [...worktreeOf.values()];
  assert.equal(new Set(paths).size, 3, 'each task ran in a distinct worktree');
  for (const [id, p] of worktreeOf) {
    assert.notEqual(p, fx.root, `${id} must not run in the integration worktree`);
    assert.ok(p.includes(`task-${id}`), `${id} worktree path is its own task dir`);
  }

  // BARRIER: C entered only after BOTH layer-1 tasks were integrated (their runTask fully resolved). C's
  // enter timestamp is strictly after the last layer-1 'work' event.
  const enterC = events.find((e) => e.taskId === 'C' && e.ev === 'enter').t;
  const lastLayer1Work = events.filter((e) => (e.taskId === 'A' || e.taskId === 'B') && e.ev === 'work')
    .reduce((m, e) => (e.t > m ? e.t : m), 0n);
  assert.ok(enterC > lastLayer1Work, 'layer-2 task started only after the layer-1 barrier');

  // Integration branch grew linearly: base + A + B + C = 4 commits.
  assert.equal(commitCount(fx.root, fx.integrationRef), 4);
});

// ── 2. built:true cannot override the coordinator's independent gates ─────────────────────────────────
test('built:true cannot override a RED coordinator validation', async () => {
  const fx = makeRepo();
  const plan = { layers: [['A']], tasks: { A: { writeScope: ['src'], paths: ['src/a.js'] } } };
  const file = makeCheckpoint(fx.dir, ['A']);
  const tip = refSha(fx.root, fx.integrationRef);

  const res = await runBuild(baseOpts(fx, file, plan, { executor: makeExecutor(), validateFor: () => RED }));

  assert.equal(res.status, 'blocked');
  const a = res.blocked.find((r) => r.taskId === 'A');
  assert.equal(a.reason, 'integration-failed');
  assert.equal(a.evidence.reason, 'validation-red');
  assert.equal(a.claimedBuilt, true, 'the agent DID claim built:true');
  assert.equal(refSha(fx.root, fx.integrationRef), tip, 'integration tip unchanged');
  assert.equal(readDoc(file).units.A.status, 'blocked');
});

test('built:true cannot override an OUT-OF-SCOPE change', async () => {
  const fx = makeRepo();
  const plan = { layers: [['A']], tasks: { A: { writeScope: ['src'], paths: ['src/a.js'] } } };
  const file = makeCheckpoint(fx.dir, ['A']);
  const tip = refSha(fx.root, fx.integrationRef);

  // executor writes README.md — outside the declared scope ['src'].
  const mutate = async ({ worktree }) => writeFileSync(join(worktree, 'README.md'), '# hacked\n');
  const res = await runBuild(baseOpts(fx, file, plan, { executor: makeExecutor({ mutate }) }));

  assert.equal(res.status, 'blocked');
  const a = res.blocked.find((r) => r.taskId === 'A');
  assert.equal(a.reason, 'out-of-scope');
  assert.ok(a.evidence.violations.some((v) => v.path === 'README.md'));
  assert.equal(a.claimedBuilt, true);
  assert.equal(refSha(fx.root, fx.integrationRef), tip, 'integration tip unchanged');
});

test('built:true cannot override an EMPTY changeset', async () => {
  const fx = makeRepo();
  const plan = { layers: [['A']], tasks: { A: { writeScope: ['src'], paths: ['src/a.js'] } } };
  const file = makeCheckpoint(fx.dir, ['A']);
  const tip = refSha(fx.root, fx.integrationRef);

  const mutate = async () => { /* claim built:true but write nothing */ };
  const res = await runBuild(baseOpts(fx, file, plan, { executor: makeExecutor({ mutate }) }));

  assert.equal(res.status, 'blocked');
  const a = res.blocked.find((r) => r.taskId === 'A');
  assert.equal(a.reason, 'empty-changeset');
  assert.equal(a.claimedBuilt, true);
  assert.equal(refSha(fx.root, fx.integrationRef), tip, 'integration tip unchanged');
});

test('built:true cannot override a BLOCKED review (review runs BEFORE integration)', async () => {
  const fx = makeRepo();
  const plan = { layers: [['A']], tasks: { A: { writeScope: ['src'], paths: ['src/a.js'] } } };
  const file = makeCheckpoint(fx.dir, ['A']);
  const tip = refSha(fx.root, fx.integrationRef);

  let integrationAttempted = false;
  const validateFor = () => ({ command: 'node', args: ['-e', `require('fs')` /* noop, but flag if run */] });
  const review = async () => ({ canAdvance: false, result: { blockedReasons: ['unresolved-blocker'] } });
  const res = await runBuild(baseOpts(fx, file, plan, {
    executor: makeExecutor(),
    review,
    validateFor: () => { integrationAttempted = true; return GREEN; },
  }));

  assert.equal(res.status, 'blocked');
  const a = res.blocked.find((r) => r.taskId === 'A');
  assert.equal(a.reason, 'review-blocked');
  assert.equal(a.claimedBuilt, true);
  assert.equal(integrationAttempted, false, 'integration/validation must NOT run once review blocks');
  assert.equal(refSha(fx.root, fx.integrationRef), tip, 'integration tip unchanged');
});

test('a MISSING reviewer is fail-closed (no review evidence ⇒ blocked)', async () => {
  const fx = makeRepo();
  const plan = { layers: [['A']], tasks: { A: { writeScope: ['src'], paths: ['src/a.js'] } } };
  const file = makeCheckpoint(fx.dir, ['A']);
  const opts = baseOpts(fx, file, plan, { executor: makeExecutor() });
  delete opts.review; // no reviewer configured at all
  const res = await runBuild(opts);
  assert.equal(res.status, 'blocked');
  assert.equal(res.blocked.find((r) => r.taskId === 'A').reason, 'missing-review');
});

// ── 3. resume reconciliation ──────────────────────────────────────────────────────────────────────────
test('integratedTaskIds maps only trailered commits reachable from the integration branch', () => {
  const fx = makeRepo();
  writeFileSync(join(fx.root, 'src', 'a.js'), 'export const a = 1;\n');
  const r = integrateTask({
    repoDir: fx.root, validate: GREEN, writeScope: ['src'], subject: 'add a',
    runId: 'run1', taskId: 'A', planId: 'plan9', lockOptions: { waitMs: 500, staleMs: 60000 },
  });
  assert.ok(r.ok, JSON.stringify(r));
  const m = integratedTaskIds(fx.root, fx.integrationRef);
  assert.equal(m.get('A'), r.sha);
  assert.equal(m.has('B'), false, 'a task with no reachable commit is absent');
});

test('resume reconciles a MISSING write from the commit trailer and SKIPS the reachable task', async () => {
  const fx = makeRepo();
  // Really integrate A (a durable commit with a Task-Id trailer)...
  writeFileSync(join(fx.root, 'src', 'a.js'), 'export const a = 1;\n');
  const ra = integrateTask({
    repoDir: fx.root, validate: GREEN, writeScope: ['src'], subject: 'add a',
    runId: 'run1', taskId: 'A', planId: 'plan9', lockOptions: { waitMs: 500, staleMs: 60000 },
  });
  assert.ok(ra.ok);
  // ...but the checkpoint LOST the write (A still pending — e.g. a crash after commit, before checkpoint).
  const file = makeCheckpoint(fx.dir, ['A', 'B']);
  assert.equal(readDoc(file).units.A.status, 'pending');

  const rec = reconcileResume({ repoDir: fx.root, integrationRef: fx.integrationRef, checkpointFile: file, taskIds: ['A', 'B'] });
  assert.deepEqual(rec.integrated, ['A']);
  assert.deepEqual(rec.reconciled, ['A'], 'the missing write was reconciled from the trailer');
  assert.deepEqual(rec.runnable, ['B']);
  assert.equal(readDoc(file).units.A.status, 'done', 'A is now durably done (skipped on the next run)');

  // A full runBuild must SKIP A (already integrated) and only run B — no re-integration of A.
  const plan = { layers: [['A', 'B']], tasks: { A: { writeScope: ['src'], paths: ['src/a.js'] }, B: { writeScope: ['lib'], paths: ['lib/b.js'] } } };
  let ranA = false;
  const executor = async ({ taskId, spec, worktree }) => {
    if (taskId === 'A') ranA = true;
    const abs = join(worktree, spec.paths[0]); mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `export const ${taskId} = 1;\n`);
    return { built: true };
  };
  const res = await runBuild(baseOpts(fx, file, plan, { executor }));
  assert.equal(ranA, false, 'A was skipped (reachable commit) — not re-executed');
  assert.equal(res.status, 'ok');
  assert.equal(commitCount(fx.root, fx.integrationRef), 3, 'base + A + B (A integrated exactly once)');
});

test('resume treats a STALE done (marked done, no reachable commit) as a durable blocker', async () => {
  const fx = makeRepo();
  const file = makeCheckpoint(fx.dir, ['S', 'U']);
  ckUnit(file, 'S', 'done'); // checkpoint claims S is done, but NO commit for S exists on the branch

  const rec = reconcileResume({ repoDir: fx.root, integrationRef: fx.integrationRef, checkpointFile: file, taskIds: ['S', 'U'] });
  assert.deepEqual(rec.staleDone, ['S']);
  assert.deepEqual(rec.runnable, ['U']);
  assert.ok(!rec.integrated.includes('S'), 'a stale done is NOT counted as integrated/skipped');

  // The inconsistency is recorded as a durable blocking open item (blocks convergence/finalize).
  const doc = readDoc(file);
  assert.ok(doc.openItems.some((i) => i.kind === 'stale-done' && i.id === 'stale-done:S'));

  // runBuild stops on the stale-done inconsistency rather than racing ahead.
  const plan = { layers: [['S', 'U']], tasks: { S: { writeScope: ['src'], paths: ['src/s.js'] }, U: { writeScope: ['lib'], paths: ['lib/u.js'] } } };
  const res = await runBuild(baseOpts(fx, file, plan, { executor: makeExecutor() }));
  assert.equal(res.status, 'blocked');
  assert.deepEqual(res.staleDone, ['S']);
});

// ── 4. options validation ─────────────────────────────────────────────────────────────────────────────
test('runBuild rejects a malformed plan / missing required option', async () => {
  const fx = makeRepo();
  const file = makeCheckpoint(fx.dir, []);
  await assert.rejects(() => runBuild(baseOpts(fx, file, { layers: 'nope', tasks: {} })), BuildEngineError);
  const opts = baseOpts(fx, file, { layers: [], tasks: {} });
  delete opts.executor;
  await assert.rejects(() => runBuild(opts), BuildEngineError);
});
