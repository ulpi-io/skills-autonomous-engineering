#!/usr/bin/env node
// test-pipeline-security.mjs — the ADVERSARIAL, fail-closed counterpart to the happy-path E2E harness
// (scripts/test-pipeline-e2e.mjs). Where the E2E proves the pipeline PUBLISHES when everything is honest,
// THIS harness proves the pipeline REFUSES — with no downstream phase and no target mutation — when
// anything is hostile, broken, or under-resourced. It drives the SAME real coordinator (pipeline.mjs →
// pipeline-engine → build-engine, phase-engine, git-workspaces, git-integration, budget-ledger,
// authorization, checkpoint-store) over the SAME temporary-git + fake-codex fixtures, and NEVER duplicates
// the happy-path scenarios (distinct-worktree isolation, resume-repairs-only-the-failure, exactly-once
// publication) — those belong to the E2E file.
//
//   AC1  SECURITY BLOCKS. Malformed executor output, an UNSAFE task id, a path/symlink scope escape, a
//        missing integration commit, agent DEATH, red/missing coordinator validation, checkpoint
//        CORRUPTION, a STALE `done` record, and a SURVIVING child each BLOCK: no downstream phase runs and
//        the publication target ref stays byte-identical to the approved base (never mutated).
//   AC2  BUDGET / TERMINATION. Concurrent reservations can never OVERSUBSCRIBE; active-wall / call /
//        attempt / retry / no-progress / resume-exhaustion each persist converged:false with EXIT 5 and can
//        never be raised on resume (the termination set is immutable).
//   AC3  AUTHORIZATION. A missing / mismatched / expired / replayed / revoked / child-minted / action-wrong
//        approval FAILS BEFORE any work; a crash AFTER irreversible capability consumption resolves to
//        outcome_unknown and is NEVER automatically retried.
//
// Zero network, zero real codex. Node 22, node:test, no new deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { main } from '../autonomous-pipeline/scripts/pipeline.mjs';
import { EXIT, assertSingleStdoutObject } from '../autonomous-pipeline/scripts/lib/cli-contract.mjs';
import { runCodexTask } from '../autonomous-pipeline/scripts/lib/codex-executor.mjs';
import { publishToTarget } from '../autonomous-pipeline/scripts/lib/git-integration.mjs';
import { runBuild, integratedTaskIds } from '../autonomous-pipeline/scripts/lib/build-engine.mjs';
import { assertSafeId, createTaskWorktree, verifyScope } from '../autonomous-pipeline/scripts/lib/git-workspaces.mjs';
import {
  reserve, settle, evaluate, initBudget, reconcileOpenSegments, stopStatus, readBudget, BudgetError,
} from '../autonomous-pipeline/scripts/lib/budget-ledger.mjs';
import {
  markPrepared, haltForAuthorization,
  issuePlanApproval, consumePlanApproval, issueActionCapability, consumeActionCapability,
  verifyCapability, revokeCapability, reconcileCapability, completeCapability,
  digestBindings, AuthorizationError,
} from '../autonomous-pipeline/scripts/lib/authorization.mjs';
import {
  init as ckInit, unit, readDoc, writeDoc,
} from '../checkpoint-resume/scripts/lib/checkpoint-store.mjs';
import { makeGitRepo, refSha } from './fixtures/git-repo-fixture.mjs';

const fakeCodexPath = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

// The coordinator's INDEPENDENT per-task slice-validate (identical to the E2E contract): read the in-scope
// file and go RED iff a MODE:RED marker is present. Never trusts the agent's self-report.
const VALIDATOR = "const fs=require('fs');let s='';try{s=fs.readFileSync(process.argv[1],'utf8')}catch(e){process.exit(2)}process.exit(/MODE:RED/.test(s)?1:0);";

function sink() { const c = []; return { write: (s) => { c.push(s); return true; }, text: () => c.join('') }; }
function newSpies() { return { execCalls: [], events: [] }; }
function realGreen(cwd) { const r = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { cwd }); return { ok: r.status === 0 }; }

// The engineer executor seam that runs the FAKE codex through the REAL codex-executor (the honest baseline
// used when a test wants the BUILD to succeed and blocks LATER). Records enter/exit for downstream asserts.
function makeFakeExecutor(fx, spies) {
  return async ({ taskId, worktree }) => {
    spies.execCalls.push(taskId);
    spies.events.push({ id: taskId, kind: 'enter', worktree });
    const res = await runCodexTask({
      prompt: `implement ${taskId}`, sandbox: 'workspace-write', cd: worktree,
      schemaFile: fx.schemaPath, outputLastMessage: join(fx.controlDir, `out-${taskId}.json`),
      bin: process.execPath, program: fakeCodexPath, skipPreflight: true,
      env: { ...process.env, FAKE_CODEX_TASK: taskId, FAKE_CODEX_CONTROL: fx.controlPath },
    });
    spies.events.push({ id: taskId, kind: 'exit' });
    return { built: res.ok === true, codex: res };
  };
}

// The full green seam set: build succeeds, every post-build gate passes, publication is the REAL
// fast-forward (counted). A test overrides EXACTLY ONE seam to inject its failure, so the block is isolated.
function baseSeams(fx, spies) {
  return {
    prepareWorkspace: async () => ({ integrationDir: fx.root }),
    executor: makeFakeExecutor(fx, spies),
    validateFor: (id) => ({ command: process.execPath, args: ['-e', VALIDATOR, join(fx.root, 'src', `${id}.js`)] }),
    review: async () => ({ canAdvance: true }),
    phaseFns: {
      test: async () => { spies.phaseTestRan = true; return { ok: true, tokens: { input: 1, output: 1 } }; },
      auto_learn: async () => { spies.autoLearnRan = true; return { ok: true, tokens: { input: 1, output: 1 } }; },
      auto_map: async () => { spies.autoMapRan = true; return { ok: true, tokens: { input: 1, output: 1 } }; },
    },
    validateFn: async ({ phase }) => ({ ok: realGreen(fx.root).ok, head: '', signature: phase }),
    finalValidateFn: async () => { spies.finalValidateRan = true; return realGreen(fx.root); },
    reviewOptions: {
      dimensions: ['correctness'],
      dimensionFns: { correctness: async () => { spies.reviewDimRan = true; return { findings: [] }; } },
      verifierPanel: [], verifierFn: () => null,
    },
    publishFn: (o) => { spies.publishCount = (spies.publishCount || 0) + 1; return publishToTarget(o); },
  };
}

const approveIo = (fx, out) => ({ env: { ULPI_RUNS_DIR: fx.stateDir }, cwd: fx.dir, stdout: out, stderr: sink(), seams: { interactive: true, context: 'coordinator' } });
const driveIo = (fx, seams, out) => ({ env: { ULPI_RUNS_DIR: fx.stateDir }, cwd: fx.dir, stdout: out, stderr: sink(), seams });

async function approveRun(fx) {
  const out = sink();
  const code = await main(['approve', '--plan', fx.planPath, '--config', fx.configPath, '--json'], approveIo(fx, out));
  assert.equal(code, EXIT.SUCCESS, out.text());
  assert.equal(assertSingleStdoutObject(out.text().trim()).status, 'prepared');
}

async function runVerb(fx, argv, seams) {
  const out = sink();
  const code = await main(argv, driveIo(fx, seams, out));
  return { code, obj: assertSingleStdoutObject(out.text().trim()), out };
}

// The one invariant every AC1 block must satisfy: the publication TARGET is byte-identical to the approved
// base (never moved) and nothing was published.
function assertTargetUnmoved(fx, spies) {
  assert.equal(refSha(fx.root, 'refs/heads/main'), fx.base, 'the publication target ref is byte-identical to the approved base (never mutated)');
  assert.equal(spies.publishCount || 0, 0, 'no publication was attempted/performed');
}

// A temp checkpoint with an initialized, immutable budget — for the pure budget-ledger cases (AC2).
const FULL_LIMITS = {
  doneCondition: 'convergence-v1', maxCodexCalls: 1000, maxActiveWallMs: 1000000,
  maxAttemptsPerTask: 1000, maxAttemptsPerPhase: 1000, maxNoProgressBarriers: 1000, escalationTriggers: [],
};
function freshBudgetCk(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ulpi-sec-bud-'));
  const file = join(dir, 'ck.json');
  ckInit(file, { task: 'sec', id: 'r', units: ['u'] });
  initBudget(file, { ...FULL_LIMITS, ...overrides });
  return { dir, file, cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

// A temp capability env with an issued plan approval — for the pure authorization cases (AC3).
function freshAuthEnv(run) {
  const dir = mkdtempSync(join(tmpdir(), 'ulpi-sec-auth-'));
  const capDir = join(dir, 'caps');
  const file = join(dir, 'ck.json');
  ckInit(file, { task: 'sec', id: run, units: ['u'] });
  markPrepared(file);
  const T0 = Date.parse('2026-01-01T00:00:00Z');
  const bind = {
    rawPlan: 'PLAN-BYTES', config: 'CONFIG-BYTES', intakeSha: shaOf('INTAKE-SNAPSHOT-BYTES'),
    baseSha: 'abc1234def', targetRef: 'refs/heads/main', engineVersion: '1.1.0',
  };
  const rec = issuePlanApproval({
    capDir, run, ...bind, ttlMs: 10 * 60 * 1000,
    interactive: true, context: 'coordinator', checkpointFile: file, worktreePaths: [], now: T0,
  });
  return { dir, capDir, file, run, T0, bind, nonce: rec.nonce, cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}
const capIssuedPath = (capDir, run) => join(capDir, `${run}.plan.cap.json`);
const shaOf = (s) => createHash('sha256').update(s).digest('hex');
// The exact `present` tuple issuePlanApproval bound (so verify's digest matches).
function bindPresent(a) {
  return {
    kind: 'plan',
    planSha: shaOf(a.bind.rawPlan), configSha: shaOf(a.bind.config), intakeSha: a.bind.intakeSha,
    baseSha: a.bind.baseSha, targetRef: a.bind.targetRef, engineVersion: a.bind.engineVersion, nonce: a.nonce,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// AC1 — every fail-closed SECURITY scenario blocks with NO downstream phase and NO target mutation
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test('AC1: a malformed/garbage engineer output cannot substitute for observed in-scope work — BLOCKED, target unmoved', async () => {
  const fx = makeGitRepo({ layers: [['alpha']] });
  try {
    await approveRun(fx);
    const spies = newSpies();
    // The engineer returns garbage (not an engineer-output object) AND writes nothing: the coordinator's
    // INDEPENDENT scope observation (no in-scope change) overrides any self-report → empty-changeset block.
    const seams = { ...baseSeams(fx, spies), executor: async () => 42 };
    const { code, obj } = await runVerb(fx, ['start', '--run', fx.run, '--json'], seams);

    assert.equal(code, EXIT.BLOCKED, JSON.stringify(obj));
    assert.equal(obj.status, 'blocked');
    assert.equal(obj.blockedStage, 'build');
    assert.equal(obj.converged, false);
    const doc = readDoc(fx.checkpointFile);
    assert.equal(doc.units.alpha.status, 'blocked');
    assert.equal(doc.status, 'needs_attention');
    assert.notEqual(doc.phases?.test?.status, 'done', 'no post-build phase advanced');
    assert.notEqual(doc.phases?.test?.status, 'running');
    assert.ok(!spies.phaseTestRan && !spies.finalValidateRan, 'no downstream phase ran');
    assertTargetUnmoved(fx, spies);
  } finally { fx.cleanup(); }
});

test('AC1: a malformed post-build phase output (no ok:true) is fail-closed — BLOCKED, no publish, target unmoved', async () => {
  const fx = makeGitRepo({ layers: [['alpha']] });
  try {
    await approveRun(fx);
    const spies = newSpies();
    // Build integrates honestly, then the TEST phase agent returns malformed structured output → BAD_OUTPUT.
    const seams = { ...baseSeams(fx, spies), phaseFns: { test: async () => ({ notOk: true }) } };
    const { code, obj } = await runVerb(fx, ['start', '--run', fx.run, '--json'], seams);

    assert.equal(code, EXIT.BLOCKED, JSON.stringify(obj));
    assert.equal(obj.blockedStage, 'phase');
    const doc = readDoc(fx.checkpointFile);
    assert.equal(doc.units.alpha.status, 'done', 'the build itself was honest');
    assert.equal(doc.phases.test.status, 'blocked', 'the malformed phase is blocked, never done');
    assert.equal(spies.finalValidateRan, undefined, 'final validation never reached past the blocked gate');
    assertTargetUnmoved(fx, spies);
  } finally { fx.cleanup(); }
});

test('AC1: an UNSAFE task id (traversal) is refused at worktree creation — BLOCKED, executor never spawned, target unmoved', async () => {
  // Direct proof the guard rejects it (defense-in-depth), then the SAME id driven through the real pipeline.
  assert.throws(() => assertSafeId('a..b', 'taskId'), /traversal/);

  const fx = makeGitRepo({ layers: [['a..b']] });
  try {
    await approveRun(fx);
    const spies = newSpies();
    const { code, obj } = await runVerb(fx, ['start', '--run', fx.run, '--json'], baseSeams(fx, spies));

    assert.equal(code, EXIT.BLOCKED, JSON.stringify(obj));
    assert.equal(obj.blockedStage, 'build');
    assert.equal(spies.execCalls.length, 0, 'no engineer executor was ever spawned for an unsafe id');
    const doc = readDoc(fx.checkpointFile);
    assert.equal(doc.units['a..b'].status, 'blocked');
    assert.match(doc.units['a..b'].note || '', /worktree-failed/);
    assertTargetUnmoved(fx, spies);
  } finally { fx.cleanup(); }
});

test('AC1: an OUT-OF-SCOPE write escape is blocked before integration — target unmoved', async () => {
  const fx = makeGitRepo({ layers: [['alpha']] });
  try {
    await approveRun(fx);
    const spies = newSpies();
    // The engineer writes a file OUTSIDE its declared write scope (src/alpha.js) — the coordinator's scope
    // verification rejects it (out-of-scope) rather than integrating a scope breakout.
    const seams = {
      ...baseSeams(fx, spies),
      executor: async ({ worktree }) => {
        mkdirSync(join(worktree, 'lib'), { recursive: true });
        writeFileSync(join(worktree, 'lib', 'evil.js'), 'module.exports = 1;\n');
        return { built: true };
      },
    };
    const { code, obj } = await runVerb(fx, ['start', '--run', fx.run, '--json'], seams);

    assert.equal(code, EXIT.BLOCKED, JSON.stringify(obj));
    assert.equal(obj.blockedStage, 'build');
    const doc = readDoc(fx.checkpointFile);
    assert.equal(doc.units.alpha.status, 'blocked');
    assert.match(doc.units.alpha.note || '', /out-of-scope/);
    assert.ok(!spies.phaseTestRan && !spies.finalValidateRan, 'no downstream phase ran');
    assertTargetUnmoved(fx, spies);
  } finally { fx.cleanup(); }
});

test('AC1: a SYMLINK escape (in-scope link → target outside the worktree) is blocked — target unmoved', async () => {
  const fx = makeGitRepo({ layers: [['alpha']] });
  try {
    await approveRun(fx);
    const spies = newSpies();
    // The in-scope path is a SYMLINK whose target escapes the worktree — a scope breakout dressed as an
    // in-scope edit. verifyScope resolves the link and rejects it (symlink-escape).
    const seams = {
      ...baseSeams(fx, spies),
      executor: async ({ worktree }) => {
        mkdirSync(join(worktree, 'src'), { recursive: true });
        symlinkSync('../../../../../etc/shadow', join(worktree, 'src', 'alpha.js'));
        return { built: true };
      },
    };
    const { code, obj } = await runVerb(fx, ['start', '--run', fx.run, '--json'], seams);

    assert.equal(code, EXIT.BLOCKED, JSON.stringify(obj));
    assert.equal(obj.blockedStage, 'build');
    const doc = readDoc(fx.checkpointFile);
    assert.equal(doc.units.alpha.status, 'blocked');
    assert.match(doc.units.alpha.note || '', /out-of-scope/);
    assertTargetUnmoved(fx, spies);

    // Direct proof of the symlink verdict from the real guard on a task worktree.
    const wt = createTaskWorktree({ root: fx.root, taskId: 'probe', baseSha: fx.base, worktreesDir: fx.worktreesDir });
    mkdirSync(join(wt.path, 'src'), { recursive: true });
    symlinkSync('../../../../../etc/shadow', join(wt.path, 'src', 'probe.js'));
    const v = verifyScope({ worktreePath: wt.path, baseSha: fx.base, writeScope: ['src/probe.js'] });
    assert.equal(v.ok, false);
    assert.ok(v.violations.some((x) => x.reason === 'symlink-escape'), JSON.stringify(v.violations));
  } finally { fx.cleanup(); }
});

test('AC1: a MISSING integration commit refuses publication — target byte-identical to base', async () => {
  const fx = makeGitRepo({ layers: [['alpha']] });
  try {
    // A durable-done checkpoint (read as bytes by the publish precondition) but the integration branch never
    // received the task commits — the integrated commit is MISSING, so publication refuses & the target is
    // left byte-identical. (This exercises the REAL publishToTarget gate directly, no fake seam.)
    const ckFile = join(fx.stateDir, 'done-but-empty.json');
    writeFileSync(ckFile, JSON.stringify({ status: 'done', finalValidation: { status: 'green' } }));
    const pub = publishToTarget({
      repoDir: fx.root, targetRef: fx.targetRef, integrationRef: fx.integrationRef,
      baseSha: fx.base, checkpointFile: ckFile,
    });
    assert.equal(pub.published, false, JSON.stringify(pub));
    assert.equal(pub.reason, 'nothing-to-publish', 'no reachable integration commit to fast-forward to');
    assert.equal(refSha(fx.root, 'refs/heads/main'), fx.base, 'target byte-identical to the approved base');
  } finally { fx.cleanup(); }
});

test('AC1: engineer/agent DEATH (executor throws) is contained — BLOCKED, no downstream phase, target unmoved', async () => {
  const fx = makeGitRepo({ layers: [['alpha']] });
  try {
    await approveRun(fx);
    const spies = newSpies();
    const seams = { ...baseSeams(fx, spies), executor: async () => { throw new Error('child died mid-turn'); } };
    const { code, obj } = await runVerb(fx, ['start', '--run', fx.run, '--json'], seams);

    assert.equal(code, EXIT.BLOCKED, JSON.stringify(obj));
    assert.equal(obj.blockedStage, 'build');
    const doc = readDoc(fx.checkpointFile);
    assert.equal(doc.units.alpha.status, 'blocked');
    assert.match(doc.units.alpha.note || '', /executor-threw/);
    // Budget reservation for the dead child was SETTLED (never leaked open) even though it threw.
    assert.equal(Object.keys(doc.budget.openReservations).length, 0, 'the dead child’s reservation was settled, not leaked');
    assert.ok(!spies.phaseTestRan && !spies.finalValidateRan, 'no downstream phase ran');
    assertTargetUnmoved(fx, spies);
  } finally { fx.cleanup(); }
});

test('AC1: RED coordinator FINAL validation blocks the terminal gate — no publish, target unmoved', async () => {
  const fx = makeGitRepo({ layers: [['alpha']] });
  try {
    await approveRun(fx);
    const spies = newSpies();
    // Build + test + review all pass, but the COORDINATOR-run terminal validation observes RED — the run is
    // never finalized done and never published (the agent's word never fabricates a green terminal gate).
    const seams = { ...baseSeams(fx, spies), finalValidateFn: async () => { spies.finalValidateRan = true; return { ok: false }; } };
    const { code, obj } = await runVerb(fx, ['start', '--run', fx.run, '--json'], seams);

    assert.equal(code, EXIT.BLOCKED, JSON.stringify(obj));
    assert.equal(obj.blockedStage, 'phase');
    assert.equal(obj.converged, false);
    assert.equal(spies.finalValidateRan, true, 'the coordinator actually ran the terminal validation');
    const doc = readDoc(fx.checkpointFile);
    assert.notEqual(doc.status, 'done');
    assertTargetUnmoved(fx, spies);
  } finally { fx.cleanup(); }
});

test('AC1: MISSING coordinator validation for a mutating phase is fail-closed — no publish, target unmoved', async () => {
  const fx = makeGitRepo({ layers: [['alpha']] });
  try {
    await approveRun(fx);
    const spies = newSpies();
    // The mutating TEST phase returns ok:true but the coordinator has NO per-phase validation function — a
    // mutating phase can never advance on the agent's word alone (VALIDATION_MISSING, fail-closed).
    const seams = { ...baseSeams(fx, spies), validateFn: undefined };
    const { code, obj } = await runVerb(fx, ['start', '--run', fx.run, '--json'], seams);

    assert.equal(code, EXIT.BLOCKED, JSON.stringify(obj));
    assert.equal(obj.blockedStage, 'phase');
    const doc = readDoc(fx.checkpointFile);
    assert.equal(doc.phases.test.status, 'blocked');
    assert.notEqual(doc.status, 'done');
    assertTargetUnmoved(fx, spies);
  } finally { fx.cleanup(); }
});

test('AC1: checkpoint CORRUPTION halts the run (EXIT.CHECKPOINT) — no work, target unmoved', async () => {
  const fx = makeGitRepo({ layers: [['alpha']] });
  try {
    await approveRun(fx);
    // Corrupt the durable checkpoint after approval — the engine refuses to run against an unreadable run.
    writeFileSync(fx.checkpointFile, '{ this is not valid json ');
    const spies = newSpies();
    const { code, obj } = await runVerb(fx, ['resume', '--run', fx.run, '--json'], baseSeams(fx, spies));

    assert.equal(code, EXIT.CHECKPOINT, JSON.stringify(obj));
    assert.equal(obj.ok, false);
    assert.equal(spies.execCalls.length, 0, 'no executor spawned against a corrupt checkpoint');
    assertTargetUnmoved(fx, spies);
  } finally { fx.cleanup(); }
});

test('AC1: a STALE `done` record (marked done, no reachable commit) is a durable BLOCKER — never trusted, target unmoved', async () => {
  const fx = makeGitRepo({ layers: [['alpha']] });
  try {
    await approveRun(fx);
    // Forge a lost-integration inconsistency: the unit claims `done`, but NO commit for it is reachable from
    // the integration branch. The build driver refuses to trust the done record (stale-done blocker).
    unit(fx.checkpointFile, 'alpha', 'done', { note: 'claimed but never integrated' });

    const build = await runBuild({
      plan: { planId: fx.run, layers: [['alpha']], tasks: { alpha: { writeScope: ['src/alpha.js'], paths: ['src/alpha.js'], subject: 'x' } } },
      root: fx.root, integrationDir: fx.root, integrationRef: fx.integrationRef, targetRef: fx.targetRef,
      worktreesDir: fx.worktreesDir, baseSha: fx.base, checkpointFile: fx.checkpointFile,
      runId: fx.run, planId: fx.run,
      executor: async () => { throw new Error('a stale-done task must never re-run its executor'); },
      validateFor: (id) => ({ command: process.execPath, args: ['-e', VALIDATOR, join(fx.root, 'src', `${id}.js`)] }),
      review: async () => ({ canAdvance: true }),
    });

    assert.equal(build.status, 'blocked', JSON.stringify(build));
    assert.equal(build.converged, false);
    assert.deepEqual(build.staleDone, ['alpha']);
    const doc = readDoc(fx.checkpointFile);
    assert.ok((doc.openItems || []).some((it) => it && it.id === 'stale-done:alpha' && it.severity === 'blocker'),
      'a durable stale-done blocker was recorded');
    assert.equal(refSha(fx.root, 'refs/heads/main'), fx.base, 'target byte-identical (no publication path even attempted)');
  } finally { fx.cleanup(); }
});

test('AC1: a SURVIVING child (unit in_progress) blocks every privileged transition — no capability, target unmoved', async () => {
  const fx = makeGitRepo({ layers: [['alpha']] });
  try {
    await approveRun(fx);
    // Simulate a child that outlived its turn: the checkpoint still records a live/in-progress executor.
    unit(fx.checkpointFile, 'alpha', 'in_progress');

    // Neither entering PREPARED, halting for an irreversible action, nor minting a capability may proceed
    // while a child survives — each fails BEFORE any privileged transition.
    assert.throws(() => markPrepared(fx.checkpointFile), (e) => e instanceof AuthorizationError && e.reason === 'executor-active');
    assert.throws(
      () => haltForAuthorization({ checkpointFile: fx.checkpointFile, action: 'ship', evidence: { note: 'x' } }),
      (e) => e instanceof AuthorizationError && e.reason === 'executor-active',
    );
    assert.throws(
      () => issuePlanApproval({
        capDir: join(fx.dir, 'caps2'), run: fx.run, rawPlan: 'p', config: 'c', intakeSha: shaOf('intake'),
        baseSha: 'abc1234', targetRef: 'refs/heads/main', engineVersion: '1.1.0', ttlMs: 1000,
        interactive: true, context: 'coordinator', checkpointFile: fx.checkpointFile, worktreePaths: [],
      }),
      (e) => e instanceof AuthorizationError && e.reason === 'executor-active',
    );
    assert.equal(refSha(fx.root, 'refs/heads/main'), fx.base, 'target byte-identical while a child survives');
  } finally { fx.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// AC2 — the immutable termination set: no oversubscription, every stop is EXIT 5 + converged:false + durable
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test('AC2: concurrent reservations can NEVER oversubscribe the call cap', async () => {
  const ck = freshBudgetCk({ maxCodexCalls: 3 });
  try {
    // Fire many reservations "at once"; the reservation is serialized under the checkpoint lock, so no more
    // than maxCodexCalls can EVER be granted — the rest are refused with max-codex-calls. No oversubscription.
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => (async () => reserve(ck.file, { task: `t${i}`, phase: 'build', callTimeoutMs: 1000 }))()),
    );
    const granted = results.filter((r) => r.granted);
    const refused = results.filter((r) => !r.granted);
    assert.equal(granted.length, 3, 'exactly the cap was granted');
    assert.equal(refused.length, 9);
    assert.ok(refused.every((r) => (r.reasons || []).includes('max-codex-calls')));
    const b = readBudget(ck.file);
    assert.equal(b.spend.codexCalls, 3, 'the ledger never counted more spawns than the cap');
    assert.equal(Object.keys(b.openReservations).length, 3, 'exactly the granted reservations are open');
  } finally { ck.cleanup(); }
});

test('AC2: CALL-cap exhaustion stops the run (EXIT 5, converged:false, durable) and cannot be raised on resume', async () => {
  const ck = freshBudgetCk({ maxCodexCalls: 1 });
  try {
    assert.equal(reserve(ck.file, { task: 'a', phase: 'build', callTimeoutMs: 1000 }).granted, true);
    assert.equal(reserve(ck.file, { task: 'b', phase: 'build', callTimeoutMs: 1000 }).granted, false);
    const ev = evaluate(ck.file, {});
    assert.equal(ev.stop, true);
    assert.equal(ev.converged, false);
    assert.equal(ev.exitCode, EXIT.BUDGET);
    assert.ok(ev.reasons.includes('max-codex-calls'));
    // Durable + immutable: the stop persists, and re-binding a RAISED limit on resume is refused.
    const st = stopStatus(ck.file);
    assert.equal(st.exitCode, EXIT.BUDGET);
    assert.equal(st.converged, false);
    assert.throws(() => initBudget(ck.file, { ...FULL_LIMITS, maxCodexCalls: 999 }), (e) => e instanceof BudgetError && /IMMUTABLE/.test(e.message));
  } finally { ck.cleanup(); }
});

test('AC2: ACTIVE-WALL exhaustion stops the run (EXIT 5, converged:false, durable)', async () => {
  const ck = freshBudgetCk({ maxActiveWallMs: 50 });
  try {
    const g = reserve(ck.file, { task: 'a', phase: 'build', callTimeoutMs: 100000 });
    assert.equal(g.granted, true);
    assert.equal(g.childTimeoutMs, 50, 'the child timeout is clamped to the remaining active wall');
    assert.equal(reserve(ck.file, { task: 'b', phase: 'build', callTimeoutMs: 100000 }).granted, false);
    const ev = evaluate(ck.file, {});
    assert.equal(ev.stop, true);
    assert.equal(ev.exitCode, EXIT.BUDGET);
    assert.equal(ev.converged, false);
    assert.ok(ev.reasons.includes('max-active-wall'));
    assert.equal(stopStatus(ck.file).exitCode, EXIT.BUDGET);
  } finally { ck.cleanup(); }
});

test('AC2: per-task ATTEMPT and per-task RETRY caps stop the run (EXIT 5, converged:false)', async () => {
  // maxAttemptsPerTask = 2 → one initial attempt + one retry, the THIRD is refused.
  const ck = freshBudgetCk({ maxAttemptsPerTask: 2 });
  try {
    assert.equal(reserve(ck.file, { task: 'a', phase: 'build', callTimeoutMs: 1000 }).granted, true, 'initial attempt');
    assert.equal(reserve(ck.file, { task: 'a', phase: 'build', callTimeoutMs: 1000 }).granted, true, 'retry #1');
    const third = reserve(ck.file, { task: 'a', phase: 'build', callTimeoutMs: 1000 });
    assert.equal(third.granted, false);
    assert.ok(third.reasons.includes('max-attempts-per-task'));
    const ev = evaluate(ck.file, {});
    assert.equal(ev.stop, true);
    assert.equal(ev.exitCode, EXIT.BUDGET);
    assert.equal(ev.converged, false);
    assert.ok(ev.reasons.some((r) => r.startsWith('max-attempts-per-task')));
  } finally { ck.cleanup(); }
});

test('AC2: per-PHASE attempt cap stops the run (EXIT 5, converged:false)', async () => {
  const ck = freshBudgetCk({ maxAttemptsPerPhase: 1 });
  try {
    assert.equal(reserve(ck.file, { task: 'a', phase: 'test', callTimeoutMs: 1000 }).granted, true);
    const second = reserve(ck.file, { task: 'b', phase: 'test', callTimeoutMs: 1000 });
    assert.equal(second.granted, false);
    assert.ok(second.reasons.includes('max-attempts-per-phase'));
    const ev = evaluate(ck.file, {});
    assert.equal(ev.stop, true);
    assert.equal(ev.exitCode, EXIT.BUDGET);
    assert.equal(ev.converged, false);
  } finally { ck.cleanup(); }
});

test('AC2: NO-PROGRESS (identical fingerprints across barriers) stops the run (EXIT 5, converged:false)', async () => {
  const ck = freshBudgetCk({ maxNoProgressBarriers: 2 });
  try {
    const first = evaluate(ck.file, { fingerprint: 'fp-same' });
    assert.equal(first.stop, false, 'one unchanged barrier is not yet a thrash');
    assert.equal(first.noProgressStreak, 1);
    const second = evaluate(ck.file, { fingerprint: 'fp-same' });
    assert.equal(second.stop, true);
    assert.equal(second.exitCode, EXIT.BUDGET);
    assert.equal(second.converged, false);
    assert.ok(second.reasons.includes('max-no-progress-barriers'));
    assert.equal(stopStatus(ck.file).exitCode, EXIT.BUDGET);
  } finally { ck.cleanup(); }
});

test('AC2: RESUME-exhaustion — a crashed child’s reserved slice is conservatively charged and cannot be reclaimed', async () => {
  const ck = freshBudgetCk({ maxActiveWallMs: 100 });
  try {
    const g = reserve(ck.file, { task: 'a', phase: 'build', callTimeoutMs: 100 });
    assert.equal(g.granted, true);
    // Crash: the child never settles — reconcileOpenSegments (called on resume) charges the FULL reserved
    // slice (assume it ran to its timeout). Spend is only ever added to; it can never be erased/reclaimed.
    const rec = reconcileOpenSegments(ck.file);
    assert.equal(rec.charged.length, 1);
    const b = readBudget(ck.file);
    assert.equal(b.spend.activeWallMs, 100);
    assert.equal(b.spend.crashCharges, 1);
    // The wall is now exhausted — a fresh reservation on resume is refused and the run stops (EXIT 5).
    assert.equal(reserve(ck.file, { task: 'a', phase: 'build', callTimeoutMs: 100 }).granted, false);
    const ev = evaluate(ck.file, {});
    assert.equal(ev.stop, true);
    assert.equal(ev.exitCode, EXIT.BUDGET);
    assert.equal(ev.converged, false);
    assert.throws(() => initBudget(ck.file, { ...FULL_LIMITS, maxActiveWallMs: 100000 }), (e) => e instanceof BudgetError);
  } finally { ck.cleanup(); }
});

test('AC2: the coordinator HONORS a durable budget stop — start yields EXIT 5, no downstream phase, target unmoved', async () => {
  const fx = makeGitRepo({ layers: [['alpha']] });
  try {
    await approveRun(fx);
    // A prior segment durably stopped the budget. The coordinator must honor it: no build spawn advances,
    // no phase runs, no publication happens, and the verb reports the budget stop (EXIT 5).
    const doc = readDoc(fx.checkpointFile);
    doc.budget.stopped = { at: '2026-01-01T00:00:00Z', reasons: ['max-active-wall'], converged: false, exitCode: EXIT.BUDGET, safeBoundary: true };
    writeDoc(fx.checkpointFile, doc);

    const spies = newSpies();
    const { code, obj } = await runVerb(fx, ['start', '--run', fx.run, '--json'], baseSeams(fx, spies));
    assert.equal(code, EXIT.BUDGET, JSON.stringify(obj));
    assert.equal(obj.status, 'budget-stopped');
    assert.equal(obj.converged, false);
    assert.ok(!spies.phaseTestRan && !spies.finalValidateRan, 'no downstream phase ran under a budget stop');
    assertTargetUnmoved(fx, spies);
    // Immutable even here: resume can never raise the stopped run's limits.
    assert.throws(() => initBudget(fx.checkpointFile, { ...fx.config.budget, maxCodexCalls: fx.config.budget.maxCodexCalls + 1 }), (e) => e instanceof BudgetError);
  } finally { fx.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// AC3 — authorization: every bad approval FAILS BEFORE work; a crash after consume is outcome_unknown, never retried
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test('AC3: a MISSING plan approval fails start BEFORE any executor — EXIT.PREFLIGHT, target unmoved', async () => {
  const fx = makeGitRepo({ layers: [['alpha']] });
  try {
    await approveRun(fx);
    // Delete the minted approval: start must refuse at the capability gate (missing) before any Codex spawn.
    rmSync(capIssuedPath(fx.capDir, fx.run));
    const spies = newSpies();
    const { code, obj } = await runVerb(fx, ['start', '--run', fx.run, '--json'], baseSeams(fx, spies));
    assert.equal(code, EXIT.PREFLIGHT, JSON.stringify(obj));
    assert.equal(obj.ok, false);
    assert.equal(spies.execCalls.length, 0, 'no executor spawned when the approval is missing');
    assertTargetUnmoved(fx, spies);
  } finally { fx.cleanup(); }
});

test('AC3: an irreversible action on a NON-CONVERGED run is refused before work — EXIT.BLOCKED, target unmoved', async () => {
  const fx = makeGitRepo({ layers: [['alpha']] });
  try {
    await approveRun(fx); // run is 'prepared', NOT a converged 'done'
    const { code, obj } = await runVerb(fx, ['authorize', '--run', fx.run, '--action', 'ship', '--json'], { interactive: true, context: 'coordinator' });
    assert.equal(code, EXIT.BLOCKED, JSON.stringify(obj));
    assert.equal(obj.ok, false);
    // No action capability was ever minted (a plan approval can never satisfy an irreversible action).
    assert.equal(existsSync(join(fx.capDir, `${fx.run}.ship.cap.json`)), false);
    assert.equal(refSha(fx.root, 'refs/heads/main'), fx.base);
  } finally { fx.cleanup(); }
});

test('AC3: MISMATCHED / EXPIRED / REPLAYED / REVOKED / CHILD-MINTED / MISSING approvals each fail the consume (no rename, cap stays issued)', async () => {
  // ── MISMATCHED: present bindings differ (wrong base) → mismatched, cap untouched (still issued). ──
  {
    const a = freshAuthEnv('run-mismatch');
    try {
      assert.throws(
        () => consumePlanApproval({ capDir: a.capDir, run: a.run, ...a.bind, baseSha: 'WRONG-BASE-SHA', nonce: a.nonce, now: a.T0 }),
        (e) => e instanceof AuthorizationError && e.reason === 'mismatched',
      );
      assert.equal(verifyCapability({ capDir: a.capDir, run: a.run, kind: 'plan', present: { ...bindPresent(a) }, now: a.T0 }).ok, true, 'the untouched capability is still consumable');
    } finally { a.cleanup(); }
  }
  // ── EXPIRED: a correct consume past the TTL → expired. ──
  {
    const a = freshAuthEnv('run-expired');
    try {
      assert.throws(
        () => consumePlanApproval({ capDir: a.capDir, run: a.run, ...a.bind, nonce: a.nonce, now: a.T0 + 11 * 60 * 1000 }),
        (e) => e instanceof AuthorizationError && e.reason === 'expired',
      );
    } finally { a.cleanup(); }
  }
  // ── REPLAYED: one legitimate consume, then a second (double-start) → replayed. ──
  {
    const a = freshAuthEnv('run-replay');
    try {
      consumePlanApproval({ capDir: a.capDir, run: a.run, ...a.bind, nonce: a.nonce, now: a.T0 });
      assert.throws(
        () => consumePlanApproval({ capDir: a.capDir, run: a.run, ...a.bind, nonce: a.nonce, now: a.T0 }),
        (e) => e instanceof AuthorizationError && e.reason === 'replayed',
      );
    } finally { a.cleanup(); }
  }
  // ── REVOKED: an operator-revoked approval → revoked. ──
  {
    const a = freshAuthEnv('run-revoked');
    try {
      revokeCapability({ capDir: a.capDir, run: a.run, kind: 'plan', reason: 'operator-abort' });
      assert.throws(
        () => consumePlanApproval({ capDir: a.capDir, run: a.run, ...a.bind, nonce: a.nonce, now: a.T0 }),
        (e) => e instanceof AuthorizationError && e.reason === 'revoked',
      );
    } finally { a.cleanup(); }
  }
  // ── CHILD-MINTED: issuance from a sandboxed child context is refused; a swapped-in child-issued record
  //    is rejected on verify. ──
  {
    const a = freshAuthEnv('run-child');
    try {
      assert.throws(
        () => issuePlanApproval({
          capDir: join(a.dir, 'caps-child'), run: 'run-child2', ...a.bind, ttlMs: 1000,
          interactive: true, context: 'executor', checkpointFile: a.file, worktreePaths: [], now: a.T0,
        }),
        (e) => e instanceof AuthorizationError && e.reason === 'child-context',
      );
      // A record forged with a non-coordinator issuer is rejected (child-issued), even mode-0600.
      const present = bindPresent(a);
      writeFileSync(capIssuedPath(a.capDir, 'run-childx'), JSON.stringify({
        kind: 'plan', run: 'run-childx', status: 'issued', issuerContext: 'executor',
        issuedAt: new Date(a.T0).toISOString(), expiresAt: new Date(a.T0 + 60000).toISOString(),
        nonce: 'n', bindings: present, digest: digestBindings(present),
      }), { mode: 0o600 });
      assert.equal(verifyCapability({ capDir: a.capDir, run: 'run-childx', kind: 'plan', present, now: a.T0 }).reason, 'child-issued');
    } finally { a.cleanup(); }
  }
  // ── MISSING: no capability at all → missing (verify + consume). ──
  {
    const a = freshAuthEnv('run-present');
    try {
      assert.equal(verifyCapability({ capDir: a.capDir, run: 'run-absent', kind: 'plan', present: bindPresent(a), now: a.T0 }).reason, 'missing');
      assert.throws(
        () => consumePlanApproval({ capDir: a.capDir, run: 'run-absent', ...a.bind, nonce: 'x', now: a.T0 }),
        (e) => e instanceof AuthorizationError && e.reason === 'missing',
      );
    } finally { a.cleanup(); }
  }
});

test('AC3: an ACTION-WRONG capability request is refused (halted for one action, another requested)', async () => {
  const a = freshAuthEnv('run-action');
  try {
    // Halt the run for `ship`, then attempt to mint/consume a DIFFERENT action — refused (wrong-state). A
    // plan approval likewise can never satisfy an action (distinct kind/key).
    haltForAuthorization({ checkpointFile: a.file, action: 'ship', evidence: { note: 'converged' }, now: a.T0 });
    assert.throws(
      () => issueActionCapability({
        capDir: a.capDir, run: a.run, action: 'deploy', baseSha: a.bind.baseSha, targetRef: a.bind.targetRef,
        engineVersion: a.bind.engineVersion, ttlMs: 1000, interactive: true, context: 'coordinator', checkpointFile: a.file, worktreePaths: [], now: a.T0,
      }),
      (e) => e instanceof AuthorizationError && e.reason === 'wrong-state',
    );
    // Consuming an action capability that was never minted for `deploy` also fails before the action.
    assert.throws(
      () => consumeActionCapability({
        capDir: a.capDir, run: a.run, action: 'deploy', checkpointFile: a.file,
        baseSha: a.bind.baseSha, targetRef: a.bind.targetRef, engineVersion: a.bind.engineVersion, nonce: 'x', now: a.T0,
      }),
      (e) => e instanceof AuthorizationError && e.reason === 'wrong-state',
    );
  } finally { a.cleanup(); }
});

test('AC3: a crash AFTER capability consumption is outcome_unknown and is NEVER auto-retried (cannot be re-minted)', async () => {
  const a = freshAuthEnv('run-crash');
  try {
    // Consume the plan approval, then "crash" before observing completion (never call completeCapability).
    consumePlanApproval({ capDir: a.capDir, run: a.run, ...a.bind, nonce: a.nonce, now: a.T0 });
    const rc = reconcileCapability({ capDir: a.capDir, run: a.run, kind: 'plan' });
    assert.equal(rc.status, 'outcome_unknown', 'a consumed-but-not-completed capability has an UNKNOWN outcome');
    assert.equal(rc.retryable, false, 'and is never automatically retried');
    // The one-per-key rule makes it non-re-mintable: re-issuing for the same key is refused (already-issued).
    assert.throws(
      () => issuePlanApproval({ capDir: a.capDir, run: a.run, ...a.bind, ttlMs: 1000, interactive: true, context: 'coordinator', checkpointFile: a.file, worktreePaths: [], now: a.T0 }),
      (e) => e instanceof AuthorizationError && e.reason === 'already-issued',
    );
    // Once completion IS observed, reconcile reports it completed (still non-retryable).
    completeCapability({ capDir: a.capDir, run: a.run, kind: 'plan', now: a.T0 });
    assert.equal(reconcileCapability({ capDir: a.capDir, run: a.run, kind: 'plan' }).status, 'completed');
  } finally { a.cleanup(); }
});
