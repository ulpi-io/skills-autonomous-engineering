#!/usr/bin/env node
// test-pipeline-cli.mjs — behavior contract for the pipeline ENGINE (lib/pipeline-engine.mjs) and its
// public CLI (scripts/pipeline.mjs). These drive the ACTUAL modules with FAKE agents/executors — no real
// Codex, no git remote, no network — and pin every load-bearing guarantee of TASK-011:
//
//   AC1  approve/start/resume/status/authorize implement the exact versioned argv/JSON/exit-code contract,
//        and EVERY preflight + capability refusal fires BEFORE any Codex executor is spawned.
//   AC2  a budget stop / durable-convergence gate stops the run (never a fabricated done); child executors
//        get NO capability material; publication is fast-forward-only, ONLY after the convergence conjunction
//        AND a durable finalize `done`.
//   AC3  resume continues from durable state without re-running done units, preserves reservations +
//        no-progress counters, rejects a replayed/never-consumed approval, and never treats budget
//        exhaustion or an agent's self-assertion as completion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as engine from '../autonomous-pipeline/scripts/lib/pipeline-engine.mjs';
import { main } from '../autonomous-pipeline/scripts/pipeline.mjs';
import { EXIT, assertSingleStdoutObject } from '../autonomous-pipeline/scripts/lib/cli-contract.mjs';
import { reconcileCapability } from '../autonomous-pipeline/scripts/lib/authorization.mjs';
import {
  readDoc, writeDoc, withLock, upgradeDoc,
  unit as ckUnit, phase as ckPhase, validation as ckValidation,
} from '../checkpoint-resume/scripts/lib/checkpoint-store.mjs';
import { reserve as budgetReserve, evaluate as budgetEvaluate } from '../autonomous-pipeline/scripts/lib/budget-ledger.mjs';

const FIXED_BASE = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────
let counter = 0;
function setup(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ulpi-pe-'));
  const root = join(dir, 'root'); mkdirSync(root, { recursive: true });
  const stateDir = join(dir, 'runs'); mkdirSync(stateDir, { recursive: true });
  const capDir = join(dir, 'caps');            // created by issuance
  const worktreesDir = join(dir, 'wt'); mkdirSync(worktreesDir, { recursive: true });
  const run = `run${++counter}`;
  const targetRef = 'refs/heads/main';
  const budget = {
    maxCodexCalls: 5, maxActiveWallMs: 60000, maxAttemptsPerTask: 3,
    maxAttemptsPerPhase: 3, maxNoProgressBarriers: 3, escalationTriggers: ['test-escalation'],
  };
  const config = {
    run, root, stateDir, capDir, worktreesDir, targetRef, base: 'HEAD', budget,
    skip: ['simplify', 'performance', 'ship_prep'], ...over.config,
  };
  const plan = {
    planId: 'plan-1', base: { approvalReady: true },
    tasks: [{ id: 'TASK-001', writeScope: ['src/a.js'] }], layers: [['TASK-001']],
    ...over.plan,
  };
  const planPath = join(dir, 'plan.json'); writeFileSync(planPath, JSON.stringify(plan));
  const configPath = join(dir, 'config.json'); writeFileSync(configPath, JSON.stringify(config));
  const checkpointFile = join(stateDir, `${run}.json`);
  return { dir, root, stateDir, capDir, worktreesDir, run, targetRef, budget, config, plan, planPath, configPath, checkpointFile };
}

function approveRun(s, over = {}) {
  return engine.approve({
    rawPlan: readFileSync(s.planPath, 'utf8'), rawConfig: readFileSync(s.configPath, 'utf8'),
    planPath: s.planPath, configPath: s.configPath, checkpointFile: s.checkpointFile,
    resolveBase: () => FIXED_BASE, interactive: true, context: 'coordinator', ...over,
  });
}

// Seams whose fake build+phase drive the DURABLE checkpoint all the way to convergence.
function successfulSeams(s, spies = {}) {
  spies.execArgs = spies.execArgs || [];
  return {
    resolveBase: () => FIXED_BASE,
    gitStatus: () => [],
    interactive: true, context: 'coordinator',
    prepareWorkspace: async () => ({ integrationDir: join(s.dir, 'integ') }),
    executor: async (childArg) => { spies.execArgs.push(childArg); return { built: true }; },
    validateFor: () => ({ command: 'true', args: [] }),
    runBuildFn: async (opts) => {
      spies.buildOpts = opts;
      for (const layer of opts.plan.layers) for (const id of layer) ckUnit(opts.checkpointFile, id, 'done', { note: 'faked-integrated' });
      ckPhase(opts.checkpointFile, 'build', 'done');
      // Spawn a child through the coordinator-provided (capability-free) executor to prove the boundary.
      if (typeof opts.executor === 'function') {
        await opts.executor({ taskId: 'TASK-001', spec: { writeScope: ['src/a.js'] }, worktree: join(s.dir, 'wt', 'task-TASK-001'), baseSha: opts.baseSha });
      }
      return { status: 'ok', converged: true };
    },
    runPhaseEngineFn: async (opts) => {
      spies.phaseOpts = opts;
      ckPhase(opts.file, 'test', 'done'); ckPhase(opts.file, 'review', 'done');
      for (const p of ['simplify', 'performance', 'ship_prep']) ckPhase(opts.file, p, 'skipped');
      ckValidation(opts.file, 'green');
      return { status: 'ok', converged: true, finalValidation: { ok: true } };
    },
    publishFn: (opts) => { spies.publishOpts = opts; return { published: true, targetRef: opts.targetRef, from: opts.baseSha, to: 'f'.repeat(40) }; },
  };
}

function forceStatus(checkpointFile, status) {
  withLock(checkpointFile, () => { const d = upgradeDoc(readDoc(checkpointFile)); d.status = status; writeDoc(checkpointFile, d); });
}

// A collectable stream for CLI stdout/stderr assertions.
function sink() { const c = []; return { write: (s) => { c.push(s); return true; }, text: () => c.join('') }; }

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// AC1 — grammar + exit codes (CLI)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
test('CLI: unknown command → exit 2 (usage), one JSON error object on stdout', async () => {
  const out = sink(); const err = sink();
  const code = await main(['frobnicate', '--json'], { stdout: out, stderr: err });
  assert.equal(code, EXIT.USAGE);
  const obj = assertSingleStdoutObject(out.text().trim());
  assert.equal(obj.ok, false);
  assert.ok(err.text().length > 0, 'diagnostics go to stderr');
});

test('CLI: missing required flag → exit 2', async () => {
  const out = sink(); const err = sink();
  const code = await main(['start'], { stdout: out, stderr: err }); // missing --run
  assert.equal(code, EXIT.USAGE);
});

test('CLI: authorize rejects an unauthorized --action → exit 2', async () => {
  const out = sink(); const err = sink();
  const code = await main(['authorize', '--run', 'x', '--action', 'rm-rf'], { stdout: out, stderr: err });
  assert.equal(code, EXIT.USAGE);
});

test('CLI: approve happy path → exit 0, exactly one JSON object on stdout, status prepared', async () => {
  const s = setup();
  const out = sink(); const err = sink();
  const code = await main(['approve', '--plan', s.planPath, '--config', s.configPath, '--json'], {
    stdout: out, stderr: err, env: { ULPI_RUNS_DIR: s.stateDir }, cwd: s.dir,
    seams: { resolveBase: () => FIXED_BASE, interactive: true, context: 'coordinator' },
  });
  assert.equal(code, EXIT.SUCCESS);
  const obj = assertSingleStdoutObject(out.text().trim());
  assert.equal(obj.ok, true);
  assert.equal(obj.status, 'prepared');
  assert.equal(readDoc(s.checkpointFile).status, 'prepared');
});

test('CLI: status after approve → exit 0, one JSON object, converged=false', async () => {
  const s = setup(); approveRun(s);
  const out = sink(); const err = sink();
  const code = await main(['status', '--run', s.run, '--json'], {
    stdout: out, stderr: err, env: { ULPI_RUNS_DIR: s.stateDir }, cwd: s.dir,
  });
  assert.equal(code, EXIT.SUCCESS);
  const obj = assertSingleStdoutObject(out.text().trim());
  assert.equal(obj.command, 'status');
  assert.equal(obj.converged, false);
  assert.equal(obj.run, s.run);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// AC1 — approve refuses a non-approval-ready base
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
test('approve: refuses plan.base.approvalReady=false (exit 3) before any state is minted', async () => {
  const s = setup({ plan: { base: { approvalReady: false } } });
  await assert.rejects(
    async () => approveRun(s),
    (e) => { assert.equal(e.code, EXIT.PREFLIGHT); assert.equal(e.reason, 'approval-not-ready'); return true; },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// AC1 — every preflight refusal fires BEFORE any executor (start)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
test('start: dirty tree refuses (exit 3) and never invokes the build driver', async () => {
  const s = setup(); approveRun(s);
  const spies = {}; const seams = successfulSeams(s, spies); seams.gitStatus = () => ['M src/x.js'];
  await assert.rejects(
    () => engine.start({ checkpointFile: s.checkpointFile, ...seams }),
    (e) => { assert.equal(e.code, EXIT.PREFLIGHT); assert.equal(e.reason, 'dirty-tree'); return true; },
  );
  assert.equal(spies.buildOpts, undefined, 'runBuild must not run when preflight refuses');
  assert.equal(spies.execArgs.length, 0, 'no executor spawned');
});

test('start: base drift refuses (exit 3) before the build driver', async () => {
  const s = setup(); approveRun(s);
  const spies = {}; const seams = successfulSeams(s, spies); seams.resolveBase = () => OTHER_SHA;
  await assert.rejects(
    () => engine.start({ checkpointFile: s.checkpointFile, ...seams }),
    (e) => { assert.equal(e.code, EXIT.PREFLIGHT); assert.equal(e.reason, 'base-drift'); return true; },
  );
  assert.equal(spies.buildOpts, undefined);
});

test('start: config drift (edited config file) refuses (exit 3)', async () => {
  const s = setup(); approveRun(s);
  writeFileSync(s.configPath, JSON.stringify({ ...s.config, note: 'edited-after-approval' }));
  const spies = {}; const seams = successfulSeams(s, spies);
  await assert.rejects(
    () => engine.start({ checkpointFile: s.checkpointFile, ...seams }),
    (e) => { assert.equal(e.code, EXIT.PREFLIGHT); assert.equal(e.reason, 'config-drift'); return true; },
  );
  assert.equal(spies.buildOpts, undefined);
});

test('start: plan drift (edited plan file) refuses (exit 3)', async () => {
  const s = setup(); approveRun(s);
  writeFileSync(s.planPath, JSON.stringify({ ...s.plan, note: 'edited-after-approval' }));
  const spies = {}; const seams = successfulSeams(s, spies);
  await assert.rejects(
    () => engine.start({ checkpointFile: s.checkpointFile, ...seams }),
    (e) => { assert.equal(e.code, EXIT.PREFLIGHT); assert.equal(e.reason, 'plan-drift'); return true; },
  );
  assert.equal(spies.buildOpts, undefined);
});

test('start: checkpoint-mismatch when the run is not in PREPARED (exit 3)', async () => {
  const s = setup(); approveRun(s);
  forceStatus(s.checkpointFile, 'running'); // not 'prepared'
  const spies = {}; const seams = successfulSeams(s, spies);
  await assert.rejects(
    () => engine.start({ checkpointFile: s.checkpointFile, ...seams }),
    (e) => { assert.equal(e.code, EXIT.PREFLIGHT); assert.equal(e.reason, 'checkpoint-mismatch'); return true; },
  );
  assert.equal(spies.buildOpts, undefined);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// AC1 — capability gating (start consumes the one-use plan approval; refuses missing/replayed)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
test('start: a missing plan-approval capability refuses (exit 3) before the build driver', async () => {
  const s = setup(); approveRun(s);
  const spies = {}; const seams = successfulSeams(s, spies);
  // Point start at an EMPTY capability dir → the approval is missing.
  await assert.rejects(
    () => engine.start({ checkpointFile: s.checkpointFile, capDir: join(s.dir, 'empty-caps'), ...seams }),
    (e) => { assert.equal(e.code, EXIT.PREFLIGHT); assert.equal(e.reason, 'missing'); return true; },
  );
  assert.equal(spies.buildOpts, undefined);
});

test('start: a REPLAYED plan approval (second consume) refuses (exit 3)', async () => {
  const s = setup(); approveRun(s);
  const spies = {}; const seams = successfulSeams(s, spies);
  const first = await engine.start({ checkpointFile: s.checkpointFile, ...seams });
  assert.equal(first.published, true);
  // Force the run back to PREPARED so preflight passes, then re-consume the (now consumed) approval.
  forceStatus(s.checkpointFile, 'prepared');
  await assert.rejects(
    () => engine.start({ checkpointFile: s.checkpointFile, ...successfulSeams(s, {}) }),
    (e) => { assert.equal(e.code, EXIT.PREFLIGHT); assert.equal(e.reason, 'replayed'); return true; },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// AC2 — happy path: converge, publish ff-only, children get no capability material
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
test('start: converges → durable done → single ff-only publication; child executors get NO capability material', async () => {
  const s = setup(); approveRun(s);
  const spies = {};
  const res = await engine.start({ checkpointFile: s.checkpointFile, ...successfulSeams(s, spies) });
  assert.equal(res.exitCode, EXIT.SUCCESS);
  assert.equal(res.status, 'done');
  assert.equal(res.published, true);
  assert.equal(res.converged, true);
  // durable finalize done happened BEFORE publication (publish is gated on the durable checkpoint).
  assert.equal(readDoc(s.checkpointFile).status, 'done');
  // publication called exactly with the fast-forward CAS argument set.
  assert.deepEqual(Object.keys(spies.publishOpts).sort(), ['baseSha', 'checkpointFile', 'integrationRef', 'repoDir', 'targetRef']);
  assert.equal(spies.publishOpts.baseSha, FIXED_BASE);
  assert.equal(spies.publishOpts.targetRef, s.targetRef);
  // child executors received ONLY worktree-safe fields — never capDir/capability/nonce.
  assert.ok(spies.execArgs.length >= 1);
  for (const arg of spies.execArgs) {
    assert.deepEqual(Object.keys(arg).sort(), ['baseSha', 'spec', 'taskId', 'worktree']);
    assert.ok(!('capDir' in arg) && !('capability' in arg) && !('nonce' in arg) && !('capabilityDir' in arg));
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// AC2 — publication is gated: a blocked build never publishes and never reports done
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
test('start: a blocked build stops the run (exit 4), never publishes, never finalizes done', async () => {
  const s = setup(); approveRun(s);
  const spies = {}; const seams = successfulSeams(s, spies);
  seams.runBuildFn = async (opts) => { spies.buildOpts = opts; return { status: 'blocked', converged: false, blocked: [{ taskId: 'TASK-001' }] }; };
  const res = await engine.start({ checkpointFile: s.checkpointFile, ...seams });
  assert.equal(res.exitCode, EXIT.BLOCKED);
  assert.equal(res.published, undefined);
  assert.equal(spies.publishOpts, undefined, 'publication must not be attempted on a blocked run');
  assert.notEqual(readDoc(s.checkpointFile).status, 'done');
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// AC2/AC3 — the DURABLE convergence conjunction overrides an agent's advisory converged:true
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
test('start: engines claim converged but a durable unit is unfinished → blocked (exit 4), no publish, no done', async () => {
  const s = setup(); approveRun(s);
  const spies = {}; const seams = successfulSeams(s, spies);
  // Build claims success but leaves the unit NOT done (its self-assertion must not count as completion).
  seams.runBuildFn = async (opts) => { spies.buildOpts = opts; ckPhase(opts.checkpointFile, 'build', 'done'); return { status: 'ok', converged: true }; };
  const res = await engine.start({ checkpointFile: s.checkpointFile, ...seams });
  assert.equal(res.exitCode, EXIT.BLOCKED);
  assert.equal(res.blockedStage, 'convergence');
  assert.ok(Array.isArray(res.convergenceFailures) && res.convergenceFailures.some((f) => f.code === 'unit-unfinished'));
  assert.equal(spies.publishOpts, undefined);
  assert.notEqual(readDoc(s.checkpointFile).status, 'done');
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// AC2/AC3 — a budget stop halts the run and is NEVER treated as completion
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
test('start: a budget stop after build → exit 5, no publish, not done', async () => {
  const s = setup(); approveRun(s);
  const spies = {}; const seams = successfulSeams(s, spies);
  seams.runBuildFn = async (opts) => {
    spies.buildOpts = opts;
    for (const layer of opts.plan.layers) for (const id of layer) ckUnit(opts.checkpointFile, id, 'done');
    ckPhase(opts.checkpointFile, 'build', 'done');
    budgetEvaluate(opts.checkpointFile, { escalation: 'test-escalation' }); // durably stop the run
    return { status: 'ok', converged: true }; // agent still claims success — must be ignored
  };
  const res = await engine.start({ checkpointFile: s.checkpointFile, ...seams });
  assert.equal(res.exitCode, EXIT.BUDGET);
  assert.equal(res.status, 'budget-stopped');
  assert.equal(spies.publishOpts, undefined);
  assert.notEqual(readDoc(s.checkpointFile).status, 'done');
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// AC3 — resume invariants
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
test('resume: a run that never consumed its approval (still issued) is refused (exit 3)', async () => {
  const s = setup(); approveRun(s); // approval issued, never started
  await assert.rejects(
    () => engine.resume({ checkpointFile: s.checkpointFile, resolveBase: () => FIXED_BASE, gitStatus: () => [] }),
    (e) => { assert.equal(e.code, EXIT.PREFLIGHT); assert.equal(e.reason, 'approval-replayed'); return true; },
  );
});

test('resume: continues from durable state, preserves spend + no-progress barriers, skips done units, completes', async () => {
  const s = setup(); approveRun(s);
  // First run: build integrates TASK-001 (durable done) then the phase engine BLOCKS → needs_attention.
  const spies1 = {}; const seams1 = successfulSeams(s, spies1);
  seams1.runPhaseEngineFn = async (opts) => { spies1.phaseOpts = opts; ckPhase(opts.file, 'test', 'blocked'); return { status: 'blocked', converged: false, blockedReasons: ['x'] }; };
  const first = await engine.start({ checkpointFile: s.checkpointFile, ...seams1 });
  assert.equal(first.exitCode, EXIT.BLOCKED);
  assert.equal(reconcileCapability({ capDir: s.capDir, run: s.run, kind: 'plan' }).status, 'outcome_unknown', 'approval is consumed');
  assert.equal(readDoc(s.checkpointFile).units['TASK-001'].status, 'done', 'the integrated unit is durably done');

  // Simulate a crashed child (an open reservation) + record a progress barrier BEFORE resume.
  budgetReserve(s.checkpointFile, { task: 'TASK-001', phase: 'build', callTimeoutMs: 1000 });
  budgetEvaluate(s.checkpointFile, { fingerprint: 'fp-preserve-me' });
  const beforeBudget = readDoc(s.checkpointFile).budget;
  const barriersBefore = beforeBudget.barriers.length;

  // Resume: fake build asserts it SEES the unit already done (never resets it); phase engine now completes.
  const spies2 = {}; const seams2 = successfulSeams(s, spies2);
  seams2.runBuildFn = async (opts) => {
    spies2.buildOpts = opts;
    spies2.seenUnitStatus = readDoc(opts.checkpointFile).units['TASK-001'].status; // durable state on entry
    ckPhase(opts.checkpointFile, 'build', 'done');
    return { status: 'ok', converged: true };
  };
  const res = await engine.resume({ checkpointFile: s.checkpointFile, ...seams2 });
  assert.equal(res.exitCode, EXIT.SUCCESS);
  assert.equal(res.published, true);
  assert.equal(spies2.seenUnitStatus, 'done', 'resume did not re-run / reset the already-done unit');

  const afterBudget = readDoc(s.checkpointFile).budget;
  // reconcileOpenSegments charged the crashed reservation — spend only ever ADDED to, never erased.
  assert.equal(afterBudget.spend.crashCharges, 1, 'the crashed open reservation was conservatively charged on resume');
  assert.ok(afterBudget.spend.activeWallMs >= beforeBudget.spend.activeWallMs, 'active wall spend preserved/increased');
  // the no-progress barrier recorded before resume is preserved (counters not reset).
  assert.ok(afterBudget.barriers.length >= barriersBefore, 'no-progress barriers preserved across resume');
  assert.ok(afterBudget.barriers.some((b) => b.fingerprint === 'fp-preserve-me'));
});

test('resume: a durably budget-stopped run is reported as a budget stop (exit 5), never completion', async () => {
  const s = setup(); approveRun(s);
  // Start and block so the approval is consumed and the run is mid-flight.
  const spies1 = {}; const seams1 = successfulSeams(s, spies1);
  seams1.runPhaseEngineFn = async (opts) => { ckPhase(opts.file, 'test', 'blocked'); return { status: 'blocked', converged: false }; };
  await engine.start({ checkpointFile: s.checkpointFile, ...seams1 });
  // Durably stop the budget (a named escalation).
  budgetEvaluate(s.checkpointFile, { escalation: 'test-escalation' });
  const spies2 = {}; const seams2 = successfulSeams(s, spies2);
  const res = await engine.resume({ checkpointFile: s.checkpointFile, ...seams2 });
  assert.equal(res.exitCode, EXIT.BUDGET);
  assert.equal(spies2.buildOpts, undefined, 'a budget-stopped resume never re-invokes the build driver');
  assert.notEqual(readDoc(s.checkpointFile).status, 'done');
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// AC1 — authorize only mints an action capability on a CONVERGED run
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
test('authorize: refuses a non-converged run (exit 4)', async () => {
  const s = setup(); approveRun(s); // status prepared, not done
  await assert.rejects(
    async () => engine.authorize({ checkpointFile: s.checkpointFile, action: 'ship', interactive: true, context: 'coordinator' }),
    (e) => { assert.equal(e.code, EXIT.BLOCKED); assert.equal(e.reason, 'not-converged'); return true; },
  );
});

test('authorize: on a converged run halts + mints a FRESH action capability (exit 0, awaiting_authorization)', async () => {
  const s = setup(); approveRun(s);
  await engine.start({ checkpointFile: s.checkpointFile, ...successfulSeams(s, {}) });
  assert.equal(readDoc(s.checkpointFile).status, 'done');
  const res = engine.authorize({ checkpointFile: s.checkpointFile, action: 'ship', interactive: true, context: 'coordinator' });
  assert.equal(res.exitCode, EXIT.SUCCESS);
  assert.equal(res.status, 'awaiting_authorization');
  assert.equal(res.action, 'ship');
  assert.equal(res.capability.kind, 'ship');
  assert.equal(readDoc(s.checkpointFile).status, 'awaiting_authorization');
  // a fresh, action-scoped capability now exists (ISSUED, unconsumed) — distinct from the plan approval.
  assert.equal(reconcileCapability({ capDir: s.capDir, run: s.run, kind: 'ship' }).status, 'issued', 'action capability issued (unconsumed)');
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// AC1 — full CLI dispatch end-to-end (JSON discipline + exit codes)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
test('CLI: approve → start → status → authorize end-to-end, each emits exactly one JSON object', async () => {
  const s = setup();
  const io = (seams) => ({ env: { ULPI_RUNS_DIR: s.stateDir }, cwd: s.dir, seams });

  // approve
  let out = sink();
  let code = await main(['approve', '--plan', s.planPath, '--config', s.configPath, '--json'], {
    ...io({ resolveBase: () => FIXED_BASE, interactive: true, context: 'coordinator' }), stdout: out, stderr: sink(),
  });
  assert.equal(code, EXIT.SUCCESS);
  assert.equal(assertSingleStdoutObject(out.text().trim()).status, 'prepared');

  // start (fakes drive convergence + publication)
  out = sink();
  code = await main(['start', '--run', s.run, '--json'], { ...io(successfulSeams(s, {})), stdout: out, stderr: sink() });
  assert.equal(code, EXIT.SUCCESS);
  const started = assertSingleStdoutObject(out.text().trim());
  assert.equal(started.published, true);
  assert.equal(started.status, 'done');

  // status
  out = sink();
  code = await main(['status', '--run', s.run, '--json'], { ...io(), stdout: out, stderr: sink() });
  assert.equal(code, EXIT.SUCCESS);
  assert.equal(assertSingleStdoutObject(out.text().trim()).converged, true);

  // authorize
  out = sink();
  code = await main(['authorize', '--run', s.run, '--action', 'ship', '--json'], {
    ...io({ interactive: true, context: 'coordinator' }), stdout: out, stderr: sink(),
  });
  assert.equal(code, EXIT.SUCCESS);
  assert.equal(assertSingleStdoutObject(out.text().trim()).status, 'awaiting_authorization');
});

test('CLI: a start preflight refusal surfaces the pinned exit code + JSON error object', async () => {
  const s = setup(); approveRun(s);
  const spies = {}; const seams = successfulSeams(s, spies); seams.gitStatus = () => ['M dirty'];
  const out = sink(); const err = sink();
  const code = await main(['start', '--run', s.run, '--json'], {
    env: { ULPI_RUNS_DIR: s.stateDir }, cwd: s.dir, seams, stdout: out, stderr: err,
  });
  assert.equal(code, EXIT.PREFLIGHT);
  const obj = assertSingleStdoutObject(out.text().trim());
  assert.equal(obj.ok, false);
  assert.equal(obj.reason, 'dirty-tree');
  assert.equal(spies.buildOpts, undefined);
});
