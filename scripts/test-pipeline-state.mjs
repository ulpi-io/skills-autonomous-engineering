#!/usr/bin/env node
// test-pipeline-state.mjs — contract tests for autonomous-pipeline/scripts/lib/pipeline-state.mjs.
//
// Proves the load-bearing guarantees of the PURE lifecycle state machine that prose can't enforce and a
// refactor could silently regress:
//   • legal vs illegal transitions for pending/running/done/blocked/skipped (+ skip only for optional),
//   • REQUIRED-gate sequencing: a blocked OR unrun required upstream phase makes downstream non-runnable,
//   • resume selection for phases and dependency-gated units,
//   • the convergence conjunction is FALSE for any unfinished unit / non-green required phase / illegitimately
//     skipped required phase / unresolved blocker / missing-or-red final validation, and TRUE only when all hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOD = join(HERE, '..', 'autonomous-pipeline', 'scripts', 'lib', 'pipeline-state.mjs');
const {
  STATES, TERMINAL_STATES, PHASES,
  isState, isTerminal, isOptionalPhase,
  isLegalTransition, applyTransition,
  requiredUpstream, requiredUpstreamCleared, isPhaseRunnable, runnablePhases,
  isUnitRunnable, runnableUnits,
  convergenceFailures, converged,
} = await import(MOD);

// ── State vocabulary ────────────────────────────────────────────────────────────────────────────────
test('the five canonical states are exactly pending/running/done/blocked/skipped', () => {
  assert.deepEqual([...STATES].sort(), ['blocked', 'done', 'pending', 'running', 'skipped']);
  for (const s of STATES) assert.ok(isState(s), `${s} should be a state`);
  assert.ok(!isState('nope'));
  assert.ok(!isState(undefined));
});

test('terminal states are done and skipped only', () => {
  assert.deepEqual([...TERMINAL_STATES].sort(), ['done', 'skipped']);
  assert.ok(isTerminal('done') && isTerminal('skipped'));
  for (const s of ['pending', 'running', 'blocked']) assert.ok(!isTerminal(s), `${s} not terminal`);
});

// ── Legal transitions ──────────────────────────────────────────────────────────────────────────────
test('legal transitions are accepted', () => {
  assert.ok(isLegalTransition('pending', 'running'));
  assert.ok(isLegalTransition('pending', 'skipped', { optional: true }));
  assert.ok(isLegalTransition('running', 'done'));
  assert.ok(isLegalTransition('running', 'blocked'));
  assert.ok(isLegalTransition('blocked', 'running')); // resume re-enters
});

test('illegal transitions are rejected', () => {
  // cannot reach done without running
  assert.ok(!isLegalTransition('pending', 'done'));
  // cannot resurrect / rewind a terminal state
  assert.ok(!isLegalTransition('done', 'running'));
  assert.ok(!isLegalTransition('done', 'pending'));
  assert.ok(!isLegalTransition('skipped', 'running'));
  // no rewinding to pending, and no direct blocked→done
  assert.ok(!isLegalTransition('running', 'pending'));
  assert.ok(!isLegalTransition('blocked', 'done'));
  // self-transition is not a legal move
  assert.ok(!isLegalTransition('running', 'running'));
  // unknown states
  assert.ok(!isLegalTransition('pending', 'bogus'));
  assert.ok(!isLegalTransition('bogus', 'running'));
});

test('skip is legal ONLY for an optional phase', () => {
  assert.ok(isLegalTransition('pending', 'skipped', { optional: true }));
  assert.ok(!isLegalTransition('pending', 'skipped', { optional: false }));
  assert.ok(!isLegalTransition('pending', 'skipped')); // default: not optional
  // you cannot skip once you have started running, even if optional
  assert.ok(!isLegalTransition('running', 'skipped', { optional: true }));
});

test('applyTransition returns the new state on a legal move and throws on illegal', () => {
  assert.equal(applyTransition('pending', 'running'), 'running');
  assert.equal(applyTransition('running', 'done'), 'done');
  assert.equal(applyTransition('pending', 'skipped', { optional: true }), 'skipped');
  assert.throws(() => applyTransition('pending', 'done'), /illegal transition/);
  assert.throws(() => applyTransition('done', 'running'), /illegal transition/);
  assert.throws(() => applyTransition('pending', 'skipped', { optional: false }), /only an optional phase/);
  assert.throws(() => applyTransition('x', 'running'), /unknown from-state/);
  assert.throws(() => applyTransition('pending', 'x'), /unknown to-state/);
});

// ── Phase defs & optionality ─────────────────────────────────────────────────────────────────────────
test('canonical phases include required auto_learn → auto_map closeout after ordinary phases', () => {
  assert.deepEqual(PHASES.map((p) => p.name), ['build', 'simplify', 'test', 'review', 'performance', 'ship_prep', 'auto_learn', 'auto_map']);
  assert.ok(!isOptionalPhase('build') && !isOptionalPhase('test') && !isOptionalPhase('review'));
  assert.ok(isOptionalPhase('simplify') && isOptionalPhase('performance') && isOptionalPhase('ship_prep'));
  assert.ok(!isOptionalPhase('auto_learn') && !isOptionalPhase('auto_map'));
  assert.ok(!isOptionalPhase('nonexistent'));
});

// ── Required-gate sequencing / resume selection ──────────────────────────────────────────────────────
test('requiredUpstream skips optional phases', () => {
  assert.deepEqual(requiredUpstream('build'), []);
  assert.deepEqual(requiredUpstream('test'), ['build']); // simplify (optional) does not gate
  assert.deepEqual(requiredUpstream('review'), ['build', 'test']);
  assert.deepEqual(requiredUpstream('ship_prep'), ['build', 'test', 'review']); // performance (optional) skipped
  assert.deepEqual(requiredUpstream('auto_learn'), [], 'closeout can run after a bumpy ordinary pass');
  assert.deepEqual(requiredUpstream('auto_map'), ['auto_learn'], 'map waits for learn');
});

test('an UNRUN required upstream phase makes every downstream phase non-runnable', () => {
  const s = { build: 'pending', simplify: 'pending', test: 'pending', review: 'pending', performance: 'pending', ship_prep: 'pending', auto_learn: 'pending', auto_map: 'pending' };
  // build has no required upstream → runnable; everything downstream gated by unrun build
  assert.ok(isPhaseRunnable('build', s));
  assert.ok(!isPhaseRunnable('test', s));
  assert.ok(!isPhaseRunnable('review', s));
  assert.ok(!isPhaseRunnable('ship_prep', s));
  assert.deepEqual(runnablePhases(s), ['build']);
  // an optional downstream is ALSO gated by its unrun required upstream
  assert.ok(!requiredUpstreamCleared('review', s));
});

test('a BLOCKED required upstream phase makes every downstream phase non-runnable', () => {
  const s = { build: 'done', simplify: 'skipped', test: 'blocked', review: 'pending', performance: 'pending', ship_prep: 'pending', auto_learn: 'pending', auto_map: 'pending' };
  // test is blocked → itself runnable (re-enter), but review/ship_prep gated because required upstream test != done
  assert.ok(isPhaseRunnable('test', s)); // blocked is not terminal → re-runnable
  assert.ok(!isPhaseRunnable('review', s));
  assert.ok(!isPhaseRunnable('ship_prep', s));
  assert.ok(!requiredUpstreamCleared('review', s));
  assert.deepEqual(runnablePhases(s), ['test']);
});

test('an optional upstream phase does NOT gate downstream (skipped simplify still lets test run)', () => {
  const s = { build: 'done', simplify: 'skipped', test: 'pending', review: 'pending', performance: 'pending', ship_prep: 'pending', auto_learn: 'pending', auto_map: 'pending' };
  assert.ok(isPhaseRunnable('test', s)); // build done, simplify skipped → test's gate is clear
  assert.ok(!isPhaseRunnable('review', s)); // gated by unrun test
  assert.deepEqual(runnablePhases(s), ['test']);
});

test('a crashed RUNNING phase is re-runnable on resume (running is not terminal)', () => {
  const s = { build: 'running', simplify: 'pending', test: 'pending', review: 'pending', performance: 'pending', ship_prep: 'pending', auto_learn: 'pending', auto_map: 'pending' };
  assert.ok(isPhaseRunnable('build', s));
  assert.ok(!isPhaseRunnable('test', s)); // build not done → gated
  // terminal phases are not runnable
  const done = { ...s, build: 'done' };
  assert.ok(!isPhaseRunnable('build', done));
});

test('unknown phase name is never runnable', () => {
  assert.ok(!isPhaseRunnable('ghost', { build: 'done' }));
});

// ── Unit resume selection (dependency-gated) ─────────────────────────────────────────────────────────
test('runnableUnits returns pending/blocked units whose deps are all done', () => {
  const units = {
    T1: { status: 'done' },
    T2: { status: 'pending', dependsOn: ['T1'] }, // dep done → runnable
    T3: { status: 'pending', dependsOn: ['T2'] }, // dep not done → gated
    T4: { status: 'blocked' }, // blocked, no deps → re-runnable
    T5: { status: 'skipped' }, // terminal → not runnable
  };
  assert.ok(isUnitRunnable('T2', units));
  assert.ok(!isUnitRunnable('T3', units));
  assert.ok(isUnitRunnable('T4', units));
  assert.ok(!isUnitRunnable('T5', units));
  assert.ok(!isUnitRunnable('T1', units)); // done → terminal
  assert.ok(!isUnitRunnable('ghost', units));
  assert.deepEqual(runnableUnits(units).sort(), ['T2', 'T4']);
});

// ── Convergence conjunction ──────────────────────────────────────────────────────────────────────────
const fullyGreen = () => ({
  units: { T1: { status: 'done' }, T2: { status: 'done' } },
  phases: { build: 'done', simplify: 'done', test: 'done', review: 'done', performance: 'skipped', ship_prep: 'done', auto_learn: 'done', auto_map: 'done' },
  openItems: [],
  intakeBinding: {
    fileSha256: 'a'.repeat(64), scopeSha256: 'b'.repeat(64), selection: 'Full MVP',
    selectedScope: [{ id: 'SCOPE-001', title: 'selected', source: 'user' }],
  },
  scopeCoverage: { total: 1, covered: ['SCOPE-001'], dropped: [], uncovered: [], errors: [] },
  requireScopeCoverage: true,
  finalValidation: { passed: true },
});

test('converged is TRUE only when every clause holds', () => {
  assert.deepEqual(convergenceFailures(fullyGreen()), []);
  assert.ok(converged(fullyGreen()));
});

test('converged is FALSE for an unfinished unit', () => {
  const s = fullyGreen();
  s.units.T2 = { status: 'in_progress' };
  assert.ok(!converged(s));
  assert.ok(convergenceFailures(s).some((f) => f.code === 'unit-unfinished'));
});

test('converged is FALSE for a non-green (blocked) required phase', () => {
  const s = fullyGreen();
  s.phases.test = 'blocked';
  assert.ok(!converged(s));
  const codes = convergenceFailures(s).map((f) => f.code);
  assert.ok(codes.includes('phase-not-green'));
  assert.ok(codes.includes('blocked-phase')); // blocked also counts as an unresolved blocker
});

test('converged is FALSE for an unrun required phase', () => {
  const s = fullyGreen();
  s.phases.review = 'pending';
  assert.ok(!converged(s));
  assert.ok(convergenceFailures(s).some((f) => f.code === 'phase-not-green'));
});

test('converged is FALSE for an ILLEGITIMATELY skipped required phase', () => {
  const s = fullyGreen();
  s.phases.build = 'skipped'; // build is required → cannot be skipped
  assert.ok(!converged(s));
  assert.ok(convergenceFailures(s).some((f) => f.code === 'required-phase-skipped'));
});

test('converged stays TRUE when an OPTIONAL phase is legitimately skipped', () => {
  const s = fullyGreen();
  s.phases.simplify = 'skipped';
  s.phases.ship_prep = 'skipped';
  assert.ok(converged(s));
});

test('converged is FALSE for an unresolved blocker in the open register', () => {
  const s = fullyGreen();
  s.openItems = [{ task: 'T1', phase: 'build', reason: 'escalated' }];
  assert.ok(!converged(s));
  assert.ok(convergenceFailures(s).some((f) => f.code === 'open-register'));
});

test('converged is FALSE when binding selected-scope coverage is missing', () => {
  const s = fullyGreen();
  s.scopeCoverage = null;
  assert.ok(!converged(s));
  assert.ok(convergenceFailures(s).some((f) => f.code === 'scope-coverage-missing'));
});

test('converged is FALSE when the independent intake binding is missing or detached from coverage', () => {
  const missing = fullyGreen();
  missing.intakeBinding = null;
  assert.ok(convergenceFailures(missing).some((f) => f.code === 'intake-binding-missing'));

  const detached = fullyGreen();
  detached.scopeCoverage = { total: 1, covered: ['SCOPE-GHOST'], dropped: [], uncovered: [], errors: [] };
  const failures = convergenceFailures(detached);
  assert.ok(failures.some((f) => f.code === 'scope-coverage-invalid' && /non-intake id SCOPE-GHOST/.test(f.detail)));
  assert.ok(failures.some((f) => f.code === 'scope-coverage-invalid' && /SCOPE-001 is absent/.test(f.detail)));
});

test('converged is FALSE for every never-mapped selected-scope item', () => {
  const s = fullyGreen();
  s.intakeBinding.selectedScope.push({ id: 'SCOPE-002', title: 'second', source: 'user' });
  s.scopeCoverage = { total: 2, covered: ['SCOPE-001'], dropped: [], uncovered: ['SCOPE-002'], errors: [] };
  assert.ok(!converged(s));
  const failures = convergenceFailures(s).filter((f) => f.code === 'scope-uncovered');
  assert.equal(failures.length, 1);
  assert.match(failures[0].detail, /SCOPE-002/);
});

test('converged is FALSE for a tampered selected-scope coverage receipt', () => {
  const missingAccount = fullyGreen();
  missingAccount.scopeCoverage = { total: 2, covered: ['SCOPE-001'], dropped: [], uncovered: [], errors: [] };
  assert.ok(convergenceFailures(missingAccount).some((f) => f.code === 'scope-coverage-invalid' && /accounts for 1 of 2/.test(f.detail)));

  const overlap = fullyGreen();
  overlap.scopeCoverage = { total: 1, covered: ['SCOPE-001'], dropped: ['SCOPE-001'], uncovered: [], errors: [] };
  assert.ok(convergenceFailures(overlap).some((f) => f.code === 'scope-coverage-invalid' && /appears in both/.test(f.detail)));
});

test('mapped-but-blocked scope is covered, while unit blockers keep convergence false', () => {
  const s = fullyGreen();
  s.units.T2 = { status: 'blocked' };
  const codes = convergenceFailures(s).map((f) => f.code);
  assert.ok(codes.includes('unit-unfinished') && codes.includes('blocked-unit'));
  assert.ok(!codes.includes('scope-uncovered'));
});

test('converged is FALSE for a blocked unit', () => {
  const s = fullyGreen();
  s.units.T2 = { status: 'blocked' };
  assert.ok(!converged(s));
  const codes = convergenceFailures(s).map((f) => f.code);
  assert.ok(codes.includes('blocked-unit'));
  assert.ok(codes.includes('unit-unfinished')); // blocked is also not done
});

test('converged is FALSE for a MISSING final validation', () => {
  const s = fullyGreen();
  s.finalValidation = null;
  assert.ok(!converged(s));
  assert.ok(convergenceFailures(s).some((f) => f.code === 'final-validation-missing'));
  const s2 = fullyGreen();
  delete s2.finalValidation;
  assert.ok(convergenceFailures(s2).some((f) => f.code === 'final-validation-missing'));
});

test('converged is FALSE for a RED final validation', () => {
  const s = fullyGreen();
  s.finalValidation = { passed: false };
  assert.ok(!converged(s));
  assert.ok(convergenceFailures(s).some((f) => f.code === 'final-validation-red'));
});

test('empty pipeline (no units, no phase defs override) with green final still needs phases green', () => {
  // guards against a vacuous-truth regression: default phaseDefs=PHASES means unrun phases fail convergence
  assert.ok(!converged({ units: {}, phases: {}, openItems: [], finalValidation: { passed: true } }));
});
