#!/usr/bin/env node
// test-phase-engine.mjs — behavior contract for autonomous-pipeline/scripts/lib/phase-engine.mjs.
//
// The phase engine is the fail-closed post-build phase RUNNER: it runs simplify/test/review/performance/
// ship_prep + final validation SEQUENTIALLY in the coordinator-owned integration worktree, reserving the
// immutable budget BEFORE each mutating agent, advancing a phase ONLY on valid structured output PLUS
// coordinator-run validation, and BLOCKING a phase + every downstream phase on any failure. These tests
// drive the ACTUAL module against a REAL throwaway checkpoint (never the project state) with FAKE phase/
// validation agents, and prove each load-bearing guarantee:
//   1. configured omissions persist as 'skipped' (never 'done'); required phases run sequentially, in order.
//   2. every mutating phase reserves budget BEFORE invocation and requires valid structured output +
//      coordinator-run validation before advancing.
//   3. agent death, ok:false / malformed output, red OR missing validation, budget / no-progress
//      exhaustion, and checkpoint failure each block the phase AND every downstream phase (hard gate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { init as ckInit, readDoc, phase as ckPhase } from '../checkpoint-resume/scripts/lib/checkpoint-store.mjs';
import { initBudget, readBudget } from '../autonomous-pipeline/scripts/lib/budget-ledger.mjs';
import { EXIT } from '../autonomous-pipeline/scripts/lib/cli-contract.mjs';
import {
  runPhaseEngine, assertConverged, PhaseEngineError,
  PHASE_BLOCK_REASONS, POST_BUILD_PHASES, FINAL_VALIDATION,
} from '../autonomous-pipeline/scripts/lib/phase-engine.mjs';

// ── fixtures ───────────────────────────────────────────────────────────────────────
const WORKTREE = '/tmp/ulpi-integration-worktree'; // a pass-through path — the engine runs NO git itself

function mkCheckpoint(limits) {
  const dir = mkdtempSync(join(tmpdir(), 'ulpi-pe-'));
  const file = join(dir, 'run.json');
  ckInit(file, { task: 'phase engine test', id: 'run-pe' });
  initBudget(file, limits || baseLimits());
  return { dir, file };
}
// Generous limits so the budget never interferes UNLESS a test deliberately shrinks it. Every reserve
// consumes a per-PHASE attempt, so maxAttemptsPerPhase must comfortably exceed reservations per phase.
const baseLimits = (over = {}) => ({
  maxCodexCalls: 50,
  maxActiveWallMs: 10_000_000,
  maxAttemptsPerTask: 5,
  maxAttemptsPerPhase: 20,
  maxNoProgressBarriers: 5,
  escalationTriggers: ['human-decision'],
  ...over,
});
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

// A fake mutating-phase set (no review) — order-preserving, all optional except `test`.
const phasesABCD = () => ([
  { name: 'simplify', optional: true, mutating: true },
  { name: 'test', optional: false, mutating: true },
  { name: 'performance', optional: true, mutating: true },
  { name: 'ship_prep', optional: true, mutating: true },
]);
// A phase agent fake: records its invocation and returns valid structured output.
function fakeAgent(sink, extra = {}) {
  return async (arg) => { if (sink) sink.push(arg); return { ok: true, ...extra }; };
}
// A coordinator validation fake that always observes green.
const greenValidate = async () => ({ ok: true });
const greenFinal = async () => ({ ok: true });

// ═══ 1. skip vs run + sequential order ═══════════════════════════════════════════════

test('configured omissions persist as skipped (never done); required phases run sequentially in order', async () => {
  const { dir, file } = mkCheckpoint();
  const order = [];
  const res = await runPhaseEngine({
    file, worktree: WORKTREE,
    phases: phasesABCD(),
    skip: ['simplify', 'performance'],           // omit two OPTIONAL phases
    phaseFns: { test: fakeAgent(order), ship_prep: fakeAgent(order) },
    validateFn: greenValidate,
    finalValidateFn: greenFinal,
  });

  // skipped phases never ran; running phases ran in declaration order
  assert.deepEqual(res.order, ['test', 'ship_prep'], 'only non-skipped phases ran, sequentially in order');
  const byName = Object.fromEntries(res.phases.map((p) => [p.name, p.state]));
  assert.equal(byName.simplify, 'skipped');
  assert.equal(byName.performance, 'skipped');
  assert.equal(byName.test, 'done');
  assert.equal(byName.ship_prep, 'done');
  // a skipped phase is NEVER reported done
  assert.notEqual(byName.simplify, 'done');
  assert.notEqual(byName.performance, 'done');
  // the durable checkpoint agrees — omission persisted as 'skipped'
  const doc = readDoc(file);
  assert.equal(doc.phases.simplify.status, 'skipped');
  assert.equal(doc.phases.performance.status, 'skipped');
  assert.equal(doc.phases.test.status, 'done');
  assert.equal(doc.phases.ship_prep.status, 'done');
  // clean convergence
  assert.equal(res.status, 'ok');
  assert.equal(res.exitCode, EXIT.SUCCESS);
  assert.equal(res.converged, true);
  assert.equal(res.finalValidation.ok, true);
  assert.equal(res.finalValidation.observedBy, 'coordinator');
  assert.doesNotThrow(() => assertConverged(res));
  cleanup(dir);
});

test('a REQUIRED phase configured to skip is a fail-closed BLOCK, not a skip — and gates downstream', async () => {
  const { dir, file } = mkCheckpoint();
  const order = [];
  const res = await runPhaseEngine({
    file, worktree: WORKTREE,
    phases: phasesABCD(),
    skip: ['test'],                              // `test` is REQUIRED — cannot be omitted
    phaseFns: { simplify: fakeAgent(order), test: fakeAgent(order), ship_prep: fakeAgent(order) },
    validateFn: greenValidate,
    finalValidateFn: greenFinal,
  });
  const byName = Object.fromEntries(res.phases.map((p) => [p.name, p]));
  assert.equal(byName.simplify.state, 'done');                 // upstream optional ran fine
  assert.equal(byName.test.state, 'blocked');
  assert.equal(byName.test.reason, PHASE_BLOCK_REASONS.REQUIRED_OMITTED);
  assert.notEqual(byName.test.state, 'skipped');               // NEVER skipped
  // every downstream phase is gated (blocked, never run)
  assert.equal(byName.performance.state, 'blocked');
  assert.equal(byName.performance.reason, PHASE_BLOCK_REASONS.UPSTREAM_BLOCKED);
  assert.equal(byName.ship_prep.state, 'blocked');
  assert.equal(byName.ship_prep.reason, PHASE_BLOCK_REASONS.UPSTREAM_BLOCKED);
  assert.equal(res.order.includes('performance'), false);
  assert.equal(res.order.includes('ship_prep'), false);
  assert.equal(res.status, 'blocked');
  assert.equal(res.exitCode, EXIT.BLOCKED);
  assert.equal(res.firstBlockedPhase, 'test');
  assert.throws(() => assertConverged(res), PhaseEngineError);
  cleanup(dir);
});

// ═══ 2. budget-reserved-before-invoke + coordinator-validation-required ═══════════════

test('every mutating phase reserves budget BEFORE the agent is invoked', async () => {
  const { dir, file } = mkCheckpoint();
  // The agent observes the budget AT INVOCATION TIME — proving the reservation already happened.
  const observedAtInvoke = [];
  const spyAgent = () => async (arg) => {
    const b = readBudget(file);
    observedAtInvoke.push({ phase: arg.phase, callsAtInvoke: b.spend.codexCalls, reservation: arg.reservation });
    return { ok: true };
  };
  const res = await runPhaseEngine({
    file, worktree: WORKTREE,
    phases: phasesABCD(),
    phaseFns: { simplify: spyAgent(), test: spyAgent(), performance: spyAgent(), ship_prep: spyAgent() },
    validateFn: greenValidate,
    finalValidateFn: greenFinal,
  });
  assert.equal(res.status, 'ok');
  // each phase carried a live reservation and saw the monotonically-incremented call count at invoke time
  assert.deepEqual(observedAtInvoke.map((o) => o.callsAtInvoke), [1, 2, 3, 4], 'reservation consumed a call BEFORE each invoke');
  for (const o of observedAtInvoke) {
    assert.ok(o.reservation && typeof o.reservation.reservationId === 'string' && o.reservation.reservationId.length > 0,
      `phase ${o.phase} was handed its live reservation id`);
  }
  // all reservations settled — no leak
  const b = readBudget(file);
  assert.equal(b.spend.codexCalls, 4);
  assert.equal(b.spend.settledCalls, 4);
  assert.equal(Object.keys(b.openReservations).length, 0);
  cleanup(dir);
});

test('a mutating phase with NO coordinator validation function blocks (validation-missing) + gates downstream', async () => {
  const { dir, file } = mkCheckpoint();
  const res = await runPhaseEngine({
    file, worktree: WORKTREE,
    phases: phasesABCD(),
    phaseFns: { simplify: fakeAgent(), test: fakeAgent(), performance: fakeAgent(), ship_prep: fakeAgent() },
    // validateFn intentionally OMITTED — a mutating phase cannot advance on the agent's word alone
    finalValidateFn: greenFinal,
  });
  const byName = Object.fromEntries(res.phases.map((p) => [p.name, p]));
  assert.equal(byName.simplify.state, 'blocked');
  assert.equal(byName.simplify.reason, PHASE_BLOCK_REASONS.VALIDATION_MISSING);
  // downstream gated
  assert.equal(byName.test.reason, PHASE_BLOCK_REASONS.UPSTREAM_BLOCKED);
  assert.equal(byName.performance.reason, PHASE_BLOCK_REASONS.UPSTREAM_BLOCKED);
  assert.equal(byName.ship_prep.reason, PHASE_BLOCK_REASONS.UPSTREAM_BLOCKED);
  assert.equal(res.status, 'blocked');
  cleanup(dir);
});

test('valid structured output alone does NOT advance a mutating phase — coordinator must run validation', async () => {
  const { dir, file } = mkCheckpoint();
  let validateCalls = 0;
  const res = await runPhaseEngine({
    file, worktree: WORKTREE,
    phases: [{ name: 'simplify', optional: true, mutating: true }],
    phaseFns: { simplify: fakeAgent(null, { summary: 'i cleaned it up, trust me' }) },
    validateFn: async ({ phase, worktree, output }) => {
      validateCalls++;
      assert.equal(phase, 'simplify');
      assert.equal(worktree, WORKTREE);          // validation runs in the integration worktree
      assert.equal(output.ok, true);             // it receives the agent's structured output
      return { ok: true, signature: 'sig-1' };
    },
    finalValidateFn: greenFinal,
  });
  assert.equal(validateCalls, 1, 'coordinator validation was actually run for the phase');
  const p = res.phases[0];
  assert.equal(p.state, 'done');
  assert.equal(p.validation.observedBy, 'coordinator'); // evidence is the coordinator's observation
  assert.equal(p.validation.ok, true);
  cleanup(dir);
});

// ═══ 3. each failure class blocks the phase + ALL downstream (hard gate) ══════════════

// A reusable harness: phases A,B,C all mutating; A always succeeds; B is made to fail in the given way;
// C must end up gated (never run). Returns the engine result + the invocation order.
async function runWithFailingB({ limits, phaseFns, validateFn, hooks } = {}) {
  const { dir, file } = mkCheckpoint(limits);
  const order = [];
  const wrapFns = {};
  for (const [k, fn] of Object.entries(phaseFns)) {
    wrapFns[k] = async (arg) => { order.push(arg.phase); return fn(arg); };
  }
  const res = await runPhaseEngine({
    file, worktree: WORKTREE,
    phases: [
      { name: 'A', optional: true, mutating: true },
      { name: 'B', optional: true, mutating: true },
      { name: 'C', optional: true, mutating: true },
    ],
    phaseFns: wrapFns,
    validateFn: validateFn || greenValidate,
    finalValidateFn: greenFinal,
    hooks,
  });
  return { dir, file, res, order };
}
function assertBBlocksC(res, order, expectedReason) {
  const byName = Object.fromEntries(res.phases.map((p) => [p.name, p]));
  assert.equal(byName.A.state, 'done', 'upstream A advanced normally');
  assert.equal(byName.B.state, 'blocked', 'B blocked');
  assert.equal(byName.B.reason, expectedReason, `B blocked for the expected reason (${expectedReason})`);
  assert.equal(byName.C.state, 'blocked', 'C is gated');
  assert.equal(byName.C.reason, PHASE_BLOCK_REASONS.UPSTREAM_BLOCKED, 'C gated as upstream-blocked, never run');
  assert.equal(order.includes('C'), false, 'C agent was never invoked');
  assert.equal(res.status, 'blocked');
  assert.equal(res.exitCode, EXIT.BLOCKED);
  assert.equal(res.firstBlockedPhase, 'B');
}

test('failure class: AGENT DEATH blocks the phase + all downstream', async () => {
  const { dir, res, order } = await runWithFailingB({
    phaseFns: {
      A: async () => ({ ok: true }),
      B: async () => { throw new Error('agent segfault'); },
      C: async () => ({ ok: true }),
    },
  });
  assertBBlocksC(res, order, PHASE_BLOCK_REASONS.AGENT_DEAD);
  cleanup(dir);
});

test('failure class: ok:false / malformed output blocks the phase + all downstream', async () => {
  const { dir, res, order } = await runWithFailingB({
    phaseFns: {
      A: async () => ({ ok: true }),
      B: async () => ({ ok: false, why: 'could not simplify safely' }), // explicit non-ok
      C: async () => ({ ok: true }),
    },
  });
  assertBBlocksC(res, order, PHASE_BLOCK_REASONS.BAD_OUTPUT);
  cleanup(dir);
});

test('failure class: malformed (non-object) output blocks the phase + all downstream', async () => {
  const { dir, res, order } = await runWithFailingB({
    phaseFns: {
      A: async () => ({ ok: true }),
      B: async () => 'not an object', // malformed structured output
      C: async () => ({ ok: true }),
    },
  });
  assertBBlocksC(res, order, PHASE_BLOCK_REASONS.BAD_OUTPUT);
  cleanup(dir);
});

test('failure class: RED coordinator validation blocks the phase + all downstream', async () => {
  const { dir, res, order } = await runWithFailingB({
    phaseFns: {
      A: async () => ({ ok: true }),
      B: async () => ({ ok: true }),
      C: async () => ({ ok: true }),
    },
    validateFn: async ({ phase }) => (phase === 'B' ? { ok: false, detail: 'tests red' } : { ok: true }),
  });
  assertBBlocksC(res, order, PHASE_BLOCK_REASONS.VALIDATION_RED);
  cleanup(dir);
});

test('failure class: BUDGET exhaustion (reservation refused) blocks the phase + all downstream', async () => {
  // Only ONE Codex call allowed: A reserves it, B's reservation is refused BEFORE invocation.
  const { dir, res, order } = await runWithFailingB({
    limits: baseLimits({ maxCodexCalls: 1 }),
    phaseFns: {
      A: async () => ({ ok: true }),
      B: async () => ({ ok: true }),
      C: async () => ({ ok: true }),
    },
  });
  assertBBlocksC(res, order, PHASE_BLOCK_REASONS.BUDGET_EXHAUSTED);
  assert.equal(order.includes('B'), false, 'B agent was never invoked — refused BEFORE invocation');
  cleanup(dir);
});

test('failure class: NO-PROGRESS exhaustion blocks the phase + all downstream', async () => {
  // Two consecutive coordinator-observed signatures are identical → the second trips the no-progress barrier.
  const { dir, res, order } = await runWithFailingB({
    limits: baseLimits({ maxNoProgressBarriers: 2 }),
    phaseFns: {
      A: async () => ({ ok: true }),
      B: async () => ({ ok: true }),
      C: async () => ({ ok: true }),
    },
    validateFn: async () => ({ ok: true, head: 'STUCK', signature: 'STUCK' }), // never moves
  });
  assertBBlocksC(res, order, PHASE_BLOCK_REASONS.NO_PROGRESS);
  cleanup(dir);
});

test('failure class: CHECKPOINT failure blocks the phase + all downstream', async () => {
  // The durable checkpoint write for advancing B to 'done' throws; the phase cannot honestly advance.
  const failingSet = (f, name, status) => {
    if (name === 'B' && status === 'done') throw new Error('disk full writing checkpoint');
    return ckPhase(f, name, status);
  };
  const { dir, res, order } = await runWithFailingB({
    phaseFns: {
      A: async () => ({ ok: true }),
      B: async () => ({ ok: true }),
      C: async () => ({ ok: true }),
    },
    hooks: { setPhaseState: failingSet },
  });
  assertBBlocksC(res, order, PHASE_BLOCK_REASONS.CHECKPOINT_FAILED);
  cleanup(dir);
});

// ═══ final validation gate + review delegation ═══════════════════════════════════════

test('a RED terminal final validation blocks the run (non-converged)', async () => {
  const { dir, file } = mkCheckpoint();
  const res = await runPhaseEngine({
    file, worktree: WORKTREE,
    phases: [{ name: 'test', optional: false, mutating: true }],
    phaseFns: { test: fakeAgent() },
    validateFn: greenValidate,
    finalValidateFn: async () => ({ ok: false, detail: 'final workspace validation red' }),
  });
  assert.equal(res.phases[0].state, 'done', 'the phase itself passed');
  assert.equal(res.status, 'blocked', 'but the terminal gate blocks the run');
  assert.equal(res.finalValidation.ok, false);
  assert.ok(res.blockedReasons.some((r) => r.includes(FINAL_VALIDATION)));
  assert.equal(res.converged, false);
  // durable final-validation recorded red
  assert.equal(readDoc(file).finalValidation.status, 'red');
  cleanup(dir);
});

test('a MISSING terminal final validation function blocks the run (fail-closed)', async () => {
  const { dir, file } = mkCheckpoint();
  const res = await runPhaseEngine({
    file, worktree: WORKTREE,
    phases: [{ name: 'test', optional: false, mutating: true }],
    phaseFns: { test: fakeAgent() },
    validateFn: greenValidate,
    // finalValidateFn OMITTED
  });
  assert.equal(res.status, 'blocked');
  assert.equal(res.finalValidation.missing, true);
  assert.ok(res.blockedReasons.some((r) => r.startsWith(PHASE_BLOCK_REASONS.VALIDATION_MISSING)));
  assert.equal(res.converged, false);
  cleanup(dir);
});

test('the review phase is delegated to the review panel: a blocked panel blocks the phase + downstream', async () => {
  const { dir, file } = mkCheckpoint();
  const res = await runPhaseEngine({
    file, worktree: WORKTREE,
    phases: [
      { name: 'review', optional: false, review: true },
      { name: 'ship_prep', optional: true, mutating: true },
    ],
    phaseFns: { ship_prep: fakeAgent() },
    validateFn: greenValidate,
    finalValidateFn: greenFinal,
    reviewOptions: {
      // a REQUIRED review dimension with no function → the panel BLOCKS (missing-dimension)
      dimensions: [{ name: 'correctness', required: true }],
      dimensionFns: {},
      verifierPanel: [],
      verifierFn: async () => ({ refuted: false }),
    },
  });
  const byName = Object.fromEntries(res.phases.map((p) => [p.name, p]));
  assert.equal(byName.review.state, 'blocked');
  assert.equal(byName.review.reason, PHASE_BLOCK_REASONS.REVIEW_BLOCKED);
  assert.ok(byName.review.panel && Array.isArray(byName.review.panel.blockedReasons) && byName.review.panel.blockedReasons.length > 0);
  assert.equal(byName.ship_prep.state, 'blocked');
  assert.equal(byName.ship_prep.reason, PHASE_BLOCK_REASONS.UPSTREAM_BLOCKED);
  assert.equal(res.status, 'blocked');
  cleanup(dir);
});

test('the review phase advances when the panel clears ship prep', async () => {
  const { dir, file } = mkCheckpoint();
  const res = await runPhaseEngine({
    file, worktree: WORKTREE,
    phases: [{ name: 'review', optional: false, review: true }],
    reviewOptions: {
      dimensions: [{ name: 'correctness', required: true }],
      dimensionFns: { correctness: async () => ({ findings: [] }) }, // no findings → clean panel
      verifierPanel: [{ id: 'v0', origin: 'p0' }],
      verifierFn: async () => ({ refuted: true }),
    },
    finalValidateFn: greenFinal,
  });
  assert.equal(res.phases[0].state, 'done');
  assert.ok(res.phases[0].panel && res.phases[0].panel.canAdvanceShipPrep === true);
  assert.equal(res.status, 'ok');
  cleanup(dir);
});

// ═══ default post-build phase set + input validation ═════════════════════════════════

test('the default POST_BUILD_PHASES order is simplify → test → review → performance → ship_prep', () => {
  assert.deepEqual(POST_BUILD_PHASES.map((p) => p.name), ['simplify', 'test', 'review', 'performance', 'ship_prep']);
  const byName = Object.fromEntries(POST_BUILD_PHASES.map((p) => [p.name, p]));
  assert.equal(byName.test.optional, false);
  assert.equal(byName.review.optional, false);
  assert.equal(byName.simplify.optional, true);
  assert.equal(byName.performance.optional, true);
  assert.equal(byName.ship_prep.optional, true);
});

test('input validation: missing file / worktree / bad phase are refused (fail-closed usage errors)', async () => {
  await assert.rejects(() => runPhaseEngine({ worktree: WORKTREE }), PhaseEngineError);
  await assert.rejects(() => runPhaseEngine({ file: '/x/y.json' }), PhaseEngineError);
  await assert.rejects(() => runPhaseEngine({ file: '/x/y.json', worktree: WORKTREE, phases: [{ name: '' }] }), PhaseEngineError);
});
