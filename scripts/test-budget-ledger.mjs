#!/usr/bin/env node
// test-budget-ledger.mjs — behavior contract for autonomous-pipeline/scripts/lib/budget-ledger.mjs.
//
// The budget ledger enforces the run's IMMUTABLE termination set on top of the ONE locked checkpoint
// store. These tests drive the ACTUAL module against a REAL throwaway checkpoint file (never the project
// state) and prove each load-bearing guarantee:
//   1. immutability / hash-binding: the set is bound to a config hash at init; re-init with a different
//      limit is refused; re-init with the same set is idempotent and preserves spend; a hard token ceiling
//      is rejected as unsupported; observed tokens are reported (never enforced).
//   2. atomic no-oversubscribe reservation under REAL process concurrency: exactly maxCodexCalls grants.
//   3. crash-conservative charge: an unsettled (crashed) open segment is charged its full reserved slice.
//   4. resume-cannot-raise / cannot-erase-spend.
//   5. exhaustion / no-progress / escalation -> durable stop at a safe boundary: converged:false, exit 5,
//      and the stop gate blocks downstream work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { init as ckInit, readDoc } from '../checkpoint-resume/scripts/lib/checkpoint-store.mjs';
import { EXIT } from '../autonomous-pipeline/scripts/lib/cli-contract.mjs';
import {
  normalizeLimits, computeConfigHash, initBudget, readBudget,
  reserve, settle, reconcileOpenSegments,
  reportTokens, parseObservedTokensFromJsonl,
  progressFingerprint, evaluate, assertNotStopped, checkExhausted, stopStatus,
  pauseForAuthorization, resumeFromAuthorization,
  DONE_CONDITION, FORBIDDEN_TOKEN_KEYS, BudgetError,
} from '../autonomous-pipeline/scripts/lib/budget-ledger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_URL = pathToFileURL(join(HERE, '..', 'autonomous-pipeline', 'scripts', 'lib', 'budget-ledger.mjs')).href;

// ── fixture ────────────────────────────────────────────────────────────────────────
function mkCheckpoint(limits) {
  const dir = mkdtempSync(join(tmpdir(), 'ulpi-bl-'));
  const file = join(dir, 'run.json');
  ckInit(file, { task: 'budget test', id: 'run-test' });
  if (limits) initBudget(file, limits);
  return { dir, file };
}
const baseLimits = () => ({
  maxCodexCalls: 5,
  maxActiveWallMs: 100000,
  maxAttemptsPerTask: 3,
  maxAttemptsPerPhase: 4,
  maxNoProgressBarriers: 2,
  escalationTriggers: ['scope-violation', 'human-decision'],
});

// ═══ 1. immutability + hash binding ══════════════════════════════════════════════════
test('normalizeLimits defaults doneCondition to convergence-v1 and sorts triggers', () => {
  const L = normalizeLimits(baseLimits());
  assert.equal(L.doneCondition, DONE_CONDITION);
  assert.deepEqual(L.escalationTriggers, ['human-decision', 'scope-violation']);
});

test('config hash is stable across key order and changes when any limit changes', () => {
  const a = computeConfigHash(normalizeLimits({ ...baseLimits() }));
  const reordered = normalizeLimits({
    escalationTriggers: ['human-decision', 'scope-violation'],
    maxNoProgressBarriers: 2, maxAttemptsPerPhase: 4, maxAttemptsPerTask: 3,
    maxActiveWallMs: 100000, maxCodexCalls: 5,
  });
  assert.equal(computeConfigHash(reordered), a, 'hash must ignore key order');
  const raised = computeConfigHash(normalizeLimits({ ...baseLimits(), maxCodexCalls: 6 }));
  assert.notEqual(raised, a, 'raising a limit must change the hash');
});

test('initBudget binds the termination set + config hash into the checkpoint', () => {
  const { file, dir } = mkCheckpoint();
  const res = initBudget(file, baseLimits());
  assert.equal(res.created, true);
  const b = readBudget(file);
  assert.equal(b.configHash, computeConfigHash(normalizeLimits(baseLimits())));
  assert.equal(b.limits.doneCondition, DONE_CONDITION);
  assert.equal(b.limits.maxCodexCalls, 5);
  // it is durably persisted in the checkpoint doc itself
  assert.equal(readDoc(file).budget.configHash, b.configHash);
  rmSync(dir, { recursive: true, force: true });
});

test('a hard token ceiling is REJECTED as unsupported (Codex cannot bound tokens pre-turn)', () => {
  for (const k of FORBIDDEN_TOKEN_KEYS) {
    assert.throws(() => normalizeLimits({ ...baseLimits(), [k]: 100000 }),
      (e) => e instanceof BudgetError && /UNSUPPORTED/.test(e.message) && e.code === EXIT.USAGE,
      `must reject hard token ceiling key ${k}`);
  }
});

test('observed tokens are reported (never enforced) and JSONL usage is parsed', () => {
  const { file, dir } = mkCheckpoint(baseLimits());
  reportTokens(file, { input: 100, output: 40 });
  reportTokens(file, { input: 10, output: 5, total: 15 });
  const b = readBudget(file);
  assert.equal(b.observedTokens.input, 110);
  assert.equal(b.observedTokens.output, 45);
  assert.equal(b.observedTokens.total, 140 + 15);
  assert.equal(b.observedTokens.reports, 2);
  // huge observed usage does NOT stop the run — there is no token ceiling to enforce
  reportTokens(file, { input: 10 ** 9, output: 10 ** 9 });
  assert.equal(stopStatus(file), null);

  const jsonl = [
    JSON.stringify({ type: 'item' }),
    JSON.stringify({ type: 'turn', usage: { input_tokens: 200, output_tokens: 30 } }),
    'not json',
    JSON.stringify({ token_usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } }),
  ].join('\n');
  const parsed = parseObservedTokensFromJsonl(jsonl);
  assert.equal(parsed.input, 205);
  assert.equal(parsed.output, 35);
  assert.equal(parsed.total, 230 + 10);
  assert.equal(parsed.reports, 2);
  rmSync(dir, { recursive: true, force: true });
});

// ═══ 2. atomic reservation — no oversubscription (single process) ═════════════════════
test('reserve consumes calls/attempts and refuses when a limit is exhausted (no mutation on refusal)', () => {
  const { file, dir } = mkCheckpoint({ ...baseLimits(), maxCodexCalls: 2, maxAttemptsPerTask: 5, maxAttemptsPerPhase: 5 });
  const r1 = reserve(file, { task: 'T1', phase: 'build', callTimeoutMs: 1000 });
  const r2 = reserve(file, { task: 'T2', phase: 'build', callTimeoutMs: 1000 });
  assert.equal(r1.granted, true);
  assert.equal(r2.granted, true);
  const r3 = reserve(file, { task: 'T3', phase: 'build', callTimeoutMs: 1000 });
  assert.equal(r3.granted, false);
  assert.deepEqual(r3.reasons, ['max-codex-calls']);
  // refusal did not consume a call
  assert.equal(readBudget(file).spend.codexCalls, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('per-task and per-phase attempt caps are independent', () => {
  const { file, dir } = mkCheckpoint({ ...baseLimits(), maxCodexCalls: 100, maxAttemptsPerTask: 2, maxAttemptsPerPhase: 100 });
  assert.equal(reserve(file, { task: 'A', phase: 'p1', callTimeoutMs: 10 }).granted, true);
  assert.equal(reserve(file, { task: 'A', phase: 'p2', callTimeoutMs: 10 }).granted, true);
  const blocked = reserve(file, { task: 'A', phase: 'p3', callTimeoutMs: 10 });
  assert.equal(blocked.granted, false);
  assert.ok(blocked.reasons.includes('max-attempts-per-task'));
  // a different task is unaffected
  assert.equal(reserve(file, { task: 'B', phase: 'p1', callTimeoutMs: 10 }).granted, true);
  rmSync(dir, { recursive: true, force: true });
});

test('child timeout = min(call timeout, remaining active wall)', () => {
  const { file, dir } = mkCheckpoint({ ...baseLimits(), maxActiveWallMs: 700, maxCodexCalls: 10 });
  const r = reserve(file, { task: 'T', phase: 'build', callTimeoutMs: 5000 });
  assert.equal(r.granted, true);
  assert.equal(r.childTimeoutMs, 700, 'clamped to remaining active wall');
  // now the wall is fully reserved -> next reserve refused
  const r2 = reserve(file, { task: 'T2', phase: 'build', callTimeoutMs: 100 });
  assert.equal(r2.granted, false);
  assert.ok(r2.reasons.includes('max-active-wall'));
  rmSync(dir, { recursive: true, force: true });
});

test('concurrent reservations across REAL processes cannot oversubscribe', async () => {
  const maxCodexCalls = 5;
  const workers = 16;
  const { file, dir } = mkCheckpoint({ ...baseLimits(), maxCodexCalls, maxAttemptsPerTask: 100, maxAttemptsPerPhase: 100 });
  const workerPath = join(dir, 'worker.mjs');
  writeFileSync(workerPath, `
    const [,, modUrl, file, tag] = process.argv;
    const m = await import(modUrl);
    try {
      const r = m.reserve(file, { task: tag, phase: 'build', callTimeoutMs: 1000 });
      process.stdout.write(JSON.stringify({ granted: r.granted }));
    } catch (e) { process.stdout.write(JSON.stringify({ error: e.message })); }
  `);
  const run = (tag) => new Promise((resolve) => {
    const p = spawn(process.execPath, [workerPath, LEDGER_URL, file, tag], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => { try { resolve(JSON.parse(out)); } catch { resolve({ error: 'no-json:' + out }); } });
  });
  const results = await Promise.all(Array.from({ length: workers }, (_, i) => run('W' + i)));
  const granted = results.filter((r) => r.granted === true).length;
  assert.ok(!results.some((r) => r.error), 'no worker errored: ' + JSON.stringify(results));
  assert.equal(granted, maxCodexCalls, `exactly ${maxCodexCalls} grants, got ${granted}`);
  assert.equal(readBudget(file).spend.codexCalls, maxCodexCalls, 'spend never exceeds the cap');
  assert.equal(Object.keys(readBudget(file).openReservations).length, maxCodexCalls);
  rmSync(dir, { recursive: true, force: true });
});

// ═══ 3. crash-conservative charge ════════════════════════════════════════════════════
test('an unsettled (crashed) open segment is conservatively charged its full reserved slice', () => {
  const { file, dir } = mkCheckpoint({ ...baseLimits(), maxActiveWallMs: 10000, maxCodexCalls: 10 });
  const r = reserve(file, { task: 'T', phase: 'build', callTimeoutMs: 3000 });
  assert.equal(r.childTimeoutMs, 3000);
  assert.equal(readBudget(file).spend.activeWallMs, 0, 'not charged until settle/reconcile');
  // simulate a crash: never settle -> reconcile on resume
  const rec = reconcileOpenSegments(file);
  assert.equal(rec.charged.length, 1);
  assert.equal(rec.charged[0].chargedMs, 3000);
  const b = readBudget(file);
  assert.equal(b.spend.activeWallMs, 3000, 'full reserved slice charged (conservative)');
  assert.equal(b.spend.crashCharges, 1);
  assert.equal(Object.keys(b.openReservations).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('settle charges the MEASURED wall clamped to the reservation and never exceeds it', () => {
  const { file, dir } = mkCheckpoint({ ...baseLimits(), maxActiveWallMs: 10000, maxCodexCalls: 10 });
  const r1 = reserve(file, { task: 'T', phase: 'build', callTimeoutMs: 2000 });
  settle(file, r1.reservationId, { actualWallMs: 500 });
  assert.equal(readBudget(file).spend.activeWallMs, 500);
  const r2 = reserve(file, { task: 'T', phase: 'build', callTimeoutMs: 2000 });
  // a lying/over-long measurement is clamped to the reserved slice
  settle(file, r2.reservationId, { actualWallMs: 99999 });
  assert.equal(readBudget(file).spend.activeWallMs, 500 + 2000);
  rmSync(dir, { recursive: true, force: true });
});

// ═══ 4. resume cannot raise limits or erase spend ════════════════════════════════════
test('re-init with the SAME set is idempotent and preserves spend', () => {
  const { file, dir } = mkCheckpoint(baseLimits());
  reserve(file, { task: 'T', phase: 'build', callTimeoutMs: 100 });
  const before = readBudget(file).spend.codexCalls;
  const res = initBudget(file, baseLimits()); // resume path
  assert.equal(res.created, false);
  assert.equal(readBudget(file).spend.codexCalls, before, 'spend not erased on resume');
  rmSync(dir, { recursive: true, force: true });
});

test('re-init that RAISES (or changes) any limit is refused — immutable termination set', () => {
  const { file, dir } = mkCheckpoint(baseLimits());
  reserve(file, { task: 'T', phase: 'build', callTimeoutMs: 100 });
  assert.throws(() => initBudget(file, { ...baseLimits(), maxCodexCalls: 999 }),
    (e) => e instanceof BudgetError && /IMMUTABLE/.test(e.message) && e.code === EXIT.USAGE);
  assert.throws(() => initBudget(file, { ...baseLimits(), maxActiveWallMs: 1 }), /IMMUTABLE/);
  // spend intact after the refused raise
  assert.equal(readBudget(file).spend.codexCalls, 1);
  rmSync(dir, { recursive: true, force: true });
});

// ═══ 5. exhaustion / no-progress / escalation -> durable exit-5 stop ═══════════════════
test('an exhausted call limit makes evaluate durably STOP: converged:false, exit 5, blocks downstream', () => {
  const { file, dir } = mkCheckpoint({ ...baseLimits(), maxCodexCalls: 1, maxAttemptsPerTask: 100, maxAttemptsPerPhase: 100 });
  reserve(file, { task: 'T', phase: 'build', callTimeoutMs: 100 }); // exhaust the single call
  assert.deepEqual(checkExhausted(file), ['max-codex-calls']);
  const fp = progressFingerprint({ integrationHead: 'abc', completedUnits: ['u1'] });
  const d = evaluate(file, { fingerprint: fp });
  assert.equal(d.stop, true);
  assert.equal(d.converged, false);
  assert.equal(d.exitCode, EXIT.BUDGET);
  assert.equal(EXIT.BUDGET, 5, 'budget stop is pinned exit 5');
  assert.ok(d.reasons.includes('max-codex-calls'));
  // durable + blocks downstream
  assert.ok(stopStatus(file));
  assert.throws(() => assertNotStopped(file), (e) => e instanceof BudgetError && e.code === EXIT.BUDGET);
  // and no further reservations are granted once stopped
  assert.equal(reserve(file, { task: 'T2', phase: 'build', callTimeoutMs: 10 }).granted, false);
  rmSync(dir, { recursive: true, force: true });
});

test('unchanged progress fingerprint across maxNoProgressBarriers barriers stops the run', () => {
  const { file, dir } = mkCheckpoint({ ...baseLimits(), maxNoProgressBarriers: 2, maxCodexCalls: 100 });
  const fp = progressFingerprint({ integrationHead: 'HEAD1', completedUnits: ['u1'], completedPhases: ['build'] });
  const d1 = evaluate(file, { fingerprint: fp });
  assert.equal(d1.stop, false, 'first barrier is progress (streak 1)');
  assert.equal(d1.noProgressStreak, 1);
  const d2 = evaluate(file, { fingerprint: fp }); // identical -> no progress
  assert.equal(d2.noProgressStreak, 2);
  assert.equal(d2.stop, true);
  assert.ok(d2.reasons.includes('max-no-progress-barriers'));
  assert.equal(d2.exitCode, EXIT.BUDGET);
  rmSync(dir, { recursive: true, force: true });
});

test('a CHANGED fingerprint resets progress and does not stop', () => {
  const { file, dir } = mkCheckpoint({ ...baseLimits(), maxNoProgressBarriers: 2, maxCodexCalls: 100 });
  evaluate(file, { fingerprint: progressFingerprint({ integrationHead: 'A' }) });
  const d = evaluate(file, { fingerprint: progressFingerprint({ integrationHead: 'B' }) }); // real progress
  assert.equal(d.stop, false);
  assert.equal(d.noProgressStreak, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('a NAMED escalation trigger forces an exit-5 stop; an unknown trigger is refused', () => {
  const { file, dir } = mkCheckpoint(baseLimits());
  assert.throws(() => evaluate(file, { escalation: 'not-a-real-trigger' }),
    (e) => e instanceof BudgetError && e.code === EXIT.USAGE);
  const d = evaluate(file, { escalation: 'scope-violation' });
  assert.equal(d.stop, true);
  assert.equal(d.exitCode, EXIT.BUDGET);
  assert.ok(d.reasons.includes('escalation:scope-violation'));
  rmSync(dir, { recursive: true, force: true });
});

test('evaluate reports a safe boundary only when no reservations are open', () => {
  const { file, dir } = mkCheckpoint(baseLimits());
  reserve(file, { task: 'T', phase: 'build', callTimeoutMs: 100 });
  const d = evaluate(file, { fingerprint: progressFingerprint({ integrationHead: 'X' }) });
  assert.equal(d.safeBoundary, false, 'an open reservation means we are mid-flight');
  reconcileOpenSegments(file);
  const d2 = evaluate(file, { fingerprint: progressFingerprint({ integrationHead: 'Y' }) });
  assert.equal(d2.safeBoundary, true);
  rmSync(dir, { recursive: true, force: true });
});

// ── paused-authorization time is excluded from active wall, only at a safe boundary ────
test('pause for authorization is refused with open reservations and excludes paused time when granted', () => {
  const { file, dir } = mkCheckpoint(baseLimits());
  const r = reserve(file, { task: 'T', phase: 'build', callTimeoutMs: 100 });
  assert.throws(() => pauseForAuthorization(file), (e) => e instanceof BudgetError && e.code === EXIT.BLOCKED);
  settle(file, r.reservationId, { actualWallMs: 50 });
  pauseForAuthorization(file);
  const res = resumeFromAuthorization(file, { elapsedMs: 999999 });
  assert.equal(res.pausedMs, 999999);
  // paused time is NOT charged against the active-wall budget
  assert.equal(readBudget(file).spend.activeWallMs, 50);
  rmSync(dir, { recursive: true, force: true });
});
