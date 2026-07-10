#!/usr/bin/env node
// test-review-panel.mjs — behavior contract for autonomous-pipeline/scripts/lib/review-panel.mjs.
//
// The review panel is the fail-closed *decision* layer of the review phase: it dispatches every required
// dimension under its schema + budget, gives findings a stable identity, verifies them with an independent
// skeptic quorum, reconciles them ONLY against coordinator-observed evidence, and emits a typed verdict
// that either clears the way to ship prep or BLOCKS it. These tests drive the ACTUAL module against a REAL
// throwaway checkpoint (never the project state) with FAKE dimension/verifier functions, and prove each
// load-bearing guarantee:
//   1. every REQUIRED dimension runs under its declared schema + a real budget reservation; findings get
//      stable ids; ONLY coordinator-observed evidence resolves a finding.
//   2. a finding is REFUTED only by the declared INDEPENDENT quorum; dead/duplicate/malformed/
//      non-independent verifier results stay UNVERIFIED + OPEN (never silently dropped).
//   3. missing dimensions, budget exhaustion, verifier death, quorum failure, and unresolved blockers each
//      produce a typed BLOCKED panel that cannot advance ship prep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { init as ckInit, readDoc } from '../checkpoint-resume/scripts/lib/checkpoint-store.mjs';
import { initBudget, readBudget } from '../autonomous-pipeline/scripts/lib/budget-ledger.mjs';
import { EXIT } from '../autonomous-pipeline/scripts/lib/cli-contract.mjs';
import {
  runReviewPanel, assertCanAdvanceShipPrep, shipPrepReadiness,
  findingId, ReviewPanelError, PANEL_REASONS, VERDICTS,
} from '../autonomous-pipeline/scripts/lib/review-panel.mjs';

// ── fixtures ───────────────────────────────────────────────────────────────────────
function mkCheckpoint(limits) {
  const dir = mkdtempSync(join(tmpdir(), 'ulpi-rp-'));
  const file = join(dir, 'run.json');
  ckInit(file, { task: 'review panel test', id: 'run-rp' });
  initBudget(file, limits || baseLimits());
  return { dir, file };
}
// Generous limits so the budget never interferes UNLESS a test deliberately shrinks it. Note every reserve
// consumes a per-PHASE attempt, so maxAttemptsPerPhase must comfortably exceed total reservations.
const baseLimits = () => ({
  maxCodexCalls: 50,
  maxActiveWallMs: 10_000_000,
  maxAttemptsPerTask: 5,
  maxAttemptsPerPhase: 200,
  maxNoProgressBarriers: 5,
  escalationTriggers: ['human-decision'],
});
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

const SCHEMA_A = { type: 'object', required: ['findings'], properties: { findings: { type: 'array' } }, $id: 'A' };
const SCHEMA_B = { type: 'object', required: ['findings'], properties: { findings: { type: 'array' } }, $id: 'B' };

// A dimension fake that records the schema it was handed and returns a fixed finding set.
function fakeDimension(findings, sink) {
  return async ({ name, schema }) => { if (sink) sink.push({ name, schema }); return { findings }; };
}
// Independent verifiers, all with a distinct id and an origin the finding never claimed.
const indepPanel = (n) => Array.from({ length: n }, (_, i) => ({ id: `skeptic-${i}`, origin: `panel-${i}` }));

// ═══ 1. dimension dispatch under schema + budget; stable identity; evidence resolution ═══

test('every required dimension runs under its declared schema and a real budget reservation', async () => {
  const { dir, file } = mkCheckpoint();
  const seen = [];
  const res = await runReviewPanel({
    file,
    dimensions: [
      { name: 'correctness', schema: SCHEMA_A },
      { name: 'security', schema: SCHEMA_B },
    ],
    dimensionFns: {
      correctness: fakeDimension([], seen),
      security: fakeDimension([], seen),
    },
    verifierPanel: indepPanel(3),
    verifierFn: async () => ({ refuted: true }),
  });
  // both ran, each got ITS declared schema
  assert.deepEqual(res.coverage.map((c) => [c.dimension, c.ran, c.ok]), [
    ['correctness', true, true], ['security', true, true],
  ]);
  assert.equal(seen.find((s) => s.name === 'correctness').schema.$id, 'A');
  assert.equal(seen.find((s) => s.name === 'security').schema.$id, 'B');
  // each dimension consumed exactly one budget reservation (no findings ⇒ no verifier spend)
  const b = readBudget(file);
  assert.equal(b.spend.codexCalls, 2, 'one Codex reservation per dimension');
  assert.equal(b.spend.settledCalls, 2, 'both reservations settled (no leak)');
  assert.equal(Object.keys(b.openReservations).length, 0);
  assert.equal(res.status, 'ok');
  assert.equal(res.canAdvanceShipPrep, true);
  cleanup(dir);
});

test('findings get a stable, content-derived identity that is deterministic across runs and lenses', async () => {
  const { dir, file } = mkCheckpoint();
  const finding = { file: 'src/pool.js', line: 42, issue: 'double-lent connection', severity: 'blocker' };
  // the same defect surfaced by TWO dimensions must dedup to ONE finding recording BOTH origins
  const res = await runReviewPanel({
    file,
    dimensions: ['correctness', 'concurrency'],
    dimensionFns: {
      correctness: fakeDimension([finding]),
      concurrency: fakeDimension([{ ...finding }]),
    },
    verifierPanel: indepPanel(3),
    verifierFn: async () => ({ refuted: true }), // refute so it doesn't block; identity is the point here
  });
  const all = [...res.findings.refuted, ...res.findings.confirmed, ...res.findings.unverified, ...res.findings.resolved];
  assert.equal(all.length, 1, 'the two identical findings dedup to one');
  const rec = all[0];
  assert.equal(rec.id, findingId(finding), 'id is the deterministic content hash');
  assert.deepEqual(rec.origins, ['concurrency', 'correctness'], 'both originating dimensions are recorded');
  // stability across a second, independent run
  const two = mkCheckpoint();
  const res2 = await runReviewPanel({
    file: two.file, dimensions: ['correctness'],
    dimensionFns: { correctness: fakeDimension([finding]) },
    verifierPanel: indepPanel(3), verifierFn: async () => ({ refuted: true }),
  });
  const rec2 = [...res2.findings.refuted][0];
  assert.equal(rec2.id, rec.id, 'identity is stable across runs');
  cleanup(dir); cleanup(two.dir);
});

test('ONLY coordinator-observed evidence resolves a finding — a claimant self-claim does not', async () => {
  const finding = { file: 'a.js', issue: 'unchecked input', severity: 'blocker' };
  const id = findingId(finding);

  // (a) coordinator-observed evidence RESOLVES it — no verifier is even spawned
  {
    const { dir, file } = mkCheckpoint();
    const res = await runReviewPanel({
      file, dimensions: ['correctness'],
      dimensionFns: { correctness: fakeDimension([finding]) },
      verifierPanel: indepPanel(3),
      verifierFn: async () => { throw new Error('verifier must not run for a resolved finding'); },
      observedEvidence: { [id]: { observedBy: 'coordinator', evidence: 'test t-42 now passes' } },
    });
    assert.equal(res.findings.resolved.length, 1);
    assert.equal(res.findings.resolved[0].id, id);
    assert.equal(res.status, 'ok');
    assert.equal(res.canAdvanceShipPrep, true);
    // resolution spent NO verifier reservation (only the one dimension reservation)
    assert.equal(readBudget(file).spend.codexCalls, 1);
    // durable register: resolved, out of the open register
    const doc = readDoc(file);
    assert.equal(doc.openItems.length, 0);
    assert.ok(doc.resolvedItems.some((r) => r.id === id), 'resolved finding is recorded in resolvedItems');
    cleanup(dir);
  }
  // (b) a non-coordinator (agent-claimed) "fix" does NOT resolve — the finding is still verified/open
  {
    const { dir, file } = mkCheckpoint();
    const res = await runReviewPanel({
      file, dimensions: ['correctness'],
      dimensionFns: { correctness: fakeDimension([finding]) },
      verifierPanel: indepPanel(3),
      verifierFn: async () => ({ refuted: false }), // real bug confirmed
      observedEvidence: { [id]: { observedBy: 'agent', evidence: 'i fixed it, trust me' } },
    });
    assert.equal(res.findings.resolved.length, 0, 'an agent self-claim cannot resolve');
    assert.equal(res.findings.confirmed.length, 1);
    assert.equal(res.status, 'blocked');
    cleanup(dir);
  }
});

// ═══ 2. skeptic-quorum verification: refute only by an INDEPENDENT quorum ═══════════════

test('an independent quorum that majority-refutes a finding REFUTES it (dismissed, not open)', async () => {
  const { dir, file } = mkCheckpoint();
  const res = await runReviewPanel({
    file, dimensions: ['correctness'],
    dimensionFns: { correctness: fakeDimension([{ file: 'x.js', issue: 'false alarm', severity: 'blocker' }]) },
    verifierPanel: indepPanel(3),
    verifierFn: async () => ({ refuted: true, confidence: 'high' }),
  });
  assert.equal(res.findings.refuted.length, 1);
  assert.equal(res.findings.confirmed.length, 0);
  assert.equal(res.findings.unverified.length, 0);
  assert.equal(res.open.length, 0, 'a refuted finding is not open');
  assert.equal(res.status, 'ok', 'no blockers remain');
  cleanup(dir);
});

test('a DEAD verifier panel keeps the finding UNVERIFIED + OPEN — never dropped, never refuted', async () => {
  const { dir, file } = mkCheckpoint();
  const res = await runReviewPanel({
    file, dimensions: ['correctness'],
    dimensionFns: { correctness: fakeDimension([{ file: 'x.js', issue: 'maybe a bug', severity: 'concern' }]) },
    verifierPanel: indepPanel(3),
    verifierFn: async () => null, // every skeptic died at the door
  });
  assert.equal(res.findings.refuted.length, 0, 'a dead panel can NEVER refute');
  assert.equal(res.findings.unverified.length, 1, 'the finding survives as unverified');
  const rec = res.findings.unverified[0];
  assert.equal(rec.tally.valid, 0);
  assert.equal(rec.ledger.length, 3);
  assert.ok(rec.ledger.every((l) => l.reason === 'dead'), 'every dead vote is recorded in the ledger');
  assert.equal(res.status, 'blocked');
  assert.ok(res.blockedReasons.some((r) => r.startsWith(PANEL_REASONS.UNVERIFIED_FINDING)));
  cleanup(dir);
});

test('NON-INDEPENDENT verifiers cannot refute — panel of claimants stays unverified + open', async () => {
  const { dir, file } = mkCheckpoint();
  // every verifier shares the finding's originating dimension ⇒ all excluded ⇒ no quorum
  const res = await runReviewPanel({
    file, dimensions: ['correctness'],
    dimensionFns: { correctness: fakeDimension([{ file: 'x.js', issue: 'self-cleared?', severity: 'blocker' }]) },
    verifierPanel: [
      { id: 's0', origin: 'correctness' },
      { id: 's1', origin: 'correctness' },
      { id: 's2', origin: 'correctness' },
    ],
    verifierFn: async () => ({ refuted: true, confidence: 'high' }), // they WOULD refute — but they can't
  });
  assert.equal(res.findings.refuted.length, 0, 'the claimant cannot refute its own finding');
  assert.equal(res.findings.unverified.length, 1);
  assert.ok(res.findings.unverified[0].ledger.every((l) => l.reason === 'non-independent'));
  assert.equal(res.status, 'blocked');
  cleanup(dir);
});

test('DUPLICATE verifier ballots cannot pad the quorum — one identity, one vote', async () => {
  const { dir, file } = mkCheckpoint();
  // three ballots but ONE identity → only one valid vote → below quorumFloor(2) → unverified
  const res = await runReviewPanel({
    file, dimensions: ['correctness'],
    dimensionFns: { correctness: fakeDimension([{ file: 'x.js', issue: 'stuffed ballot', severity: 'blocker' }]) },
    verifierPanel: [
      { id: 'dup', origin: 'p' },
      { id: 'dup', origin: 'p' },
      { id: 'dup', origin: 'p' },
    ],
    verifierFn: async () => ({ refuted: true, confidence: 'high' }),
  });
  assert.equal(res.findings.refuted.length, 0);
  assert.equal(res.findings.unverified.length, 1);
  const led = res.findings.unverified[0].ledger;
  assert.equal(led.filter((l) => l.reason === 'duplicate').length, 2, 'the two repeats are excluded as duplicates');
  cleanup(dir);
});

test('MALFORMED verifier results are excluded — starving the quorum keeps the finding unverified', async () => {
  const { dir, file } = mkCheckpoint();
  let i = 0;
  const res = await runReviewPanel({
    file, dimensions: ['correctness'],
    dimensionFns: { correctness: fakeDimension([{ file: 'x.js', issue: 'ambiguous', severity: 'blocker' }]) },
    verifierPanel: indepPanel(3),
    // one well-formed refute, two malformed (missing boolean `refuted`) ⇒ 1 valid < quorumFloor(2)
    verifierFn: async () => { i++; return i === 1 ? { refuted: true } : { verdict: 'maybe' }; },
  });
  assert.equal(res.findings.refuted.length, 0, 'a single valid vote cannot reach the quorum');
  assert.equal(res.findings.unverified.length, 1);
  assert.equal(res.findings.unverified[0].ledger.filter((l) => l.reason === 'malformed').length, 2);
  cleanup(dir);
});

test('a TIE among the independent quorum fails closed to unverified (keeps the finding)', async () => {
  const { dir, file } = mkCheckpoint();
  let i = 0;
  const res = await runReviewPanel({
    file, dimensions: ['correctness'],
    dimensionFns: { correctness: fakeDimension([{ file: 'x.js', issue: 'contested', severity: 'blocker' }]) },
    verifierPanel: indepPanel(4), // even panel to allow a 2–2 tie
    verifierFn: async () => { i++; return { refuted: i % 2 === 0 }; }, // 2 refute, 2 confirm
  });
  assert.equal(res.findings.unverified.length, 1, 'a tie never refutes — fail closed');
  assert.equal(res.findings.refuted.length, 0);
  assert.equal(res.status, 'blocked');
  cleanup(dir);
});

// ═══ 3. every BLOCKED-panel path is typed and cannot advance ship prep ═══════════════════

test('a MISSING required dimension blocks the panel', async () => {
  const { dir, file } = mkCheckpoint();
  const res = await runReviewPanel({
    file,
    dimensions: [{ name: 'correctness' }, { name: 'security' }],
    dimensionFns: { correctness: fakeDimension([]) }, // security has NO function
    verifierPanel: indepPanel(3), verifierFn: async () => ({ refuted: true }),
  });
  assert.equal(res.status, 'blocked');
  assert.deepEqual(res.blockedReasons, [`${PANEL_REASONS.MISSING_DIMENSION}:security`]);
  assert.equal(res.coverage.find((c) => c.dimension === 'security').ran, false);
  assert.throws(() => assertCanAdvanceShipPrep(res), (e) => e instanceof ReviewPanelError && e.code === EXIT.BLOCKED);
  cleanup(dir);
});

test('an OPTIONAL missing dimension does NOT block (only required dimensions gate)', async () => {
  const { dir, file } = mkCheckpoint();
  const res = await runReviewPanel({
    file,
    dimensions: [{ name: 'correctness' }, { name: 'style', required: false }],
    dimensionFns: { correctness: fakeDimension([]) }, // optional 'style' absent
    verifierPanel: indepPanel(3), verifierFn: async () => ({ refuted: true }),
  });
  assert.equal(res.status, 'ok');
  assert.equal(res.canAdvanceShipPrep, true);
  assert.equal(res.coverage.find((c) => c.dimension === 'style').ran, false);
  cleanup(dir);
});

test('BUDGET exhaustion blocks a required dimension that cannot reserve a spawn', async () => {
  // exactly ONE Codex call is allowed → the first dimension reserves, the second is refused
  const { dir, file } = mkCheckpoint({ ...baseLimits(), maxCodexCalls: 1 });
  const res = await runReviewPanel({
    file,
    dimensions: ['correctness', 'security'],
    dimensionFns: { correctness: fakeDimension([]), security: fakeDimension([]) },
    verifierPanel: indepPanel(1), verifierFn: async () => ({ refuted: true }),
  });
  assert.equal(res.status, 'blocked');
  assert.deepEqual(res.blockedReasons, [`${PANEL_REASONS.BUDGET_EXHAUSTED}:security`]);
  const sec = res.coverage.find((c) => c.dimension === 'security');
  assert.equal(sec.ran, false);
  assert.ok(sec.budget.includes('max-codex-calls'));
  cleanup(dir);
});

test('a DEAD (throwing) required dimension blocks the panel and is not reported clean', async () => {
  const { dir, file } = mkCheckpoint();
  const res = await runReviewPanel({
    file, dimensions: ['correctness'],
    dimensionFns: { correctness: async () => { throw new Error('reviewer crashed'); } },
    verifierPanel: indepPanel(3), verifierFn: async () => ({ refuted: true }),
  });
  assert.equal(res.status, 'blocked');
  assert.deepEqual(res.blockedReasons, [`${PANEL_REASONS.DIMENSION_DEAD}:correctness`]);
  const cov = res.coverage[0];
  assert.equal(cov.ran, true);
  assert.equal(cov.ok, false);
  assert.equal(cov.reason, 'dead');
  // the crashed reservation was still settled — no leaked open reservation
  assert.equal(Object.keys(readBudget(file).openReservations).length, 0);
  cleanup(dir);
});

test('a MALFORMED dimension output (not { findings: [] }) blocks the required dimension', async () => {
  const { dir, file } = mkCheckpoint();
  const res = await runReviewPanel({
    file, dimensions: ['correctness'],
    dimensionFns: { correctness: async () => ({ notFindings: true }) },
    verifierPanel: indepPanel(3), verifierFn: async () => ({ refuted: true }),
  });
  assert.equal(res.status, 'blocked');
  assert.equal(res.coverage[0].reason, 'malformed');
  assert.ok(res.blockedReasons.includes(`${PANEL_REASONS.DIMENSION_DEAD}:correctness`));
  cleanup(dir);
});

test('a CONFIRMED blocker-severity finding is an unresolved blocker that blocks ship prep', async () => {
  const { dir, file } = mkCheckpoint();
  const res = await runReviewPanel({
    file, dimensions: ['correctness'],
    dimensionFns: { correctness: fakeDimension([{ file: 'pay.js', issue: 'money path untested', severity: 'blocker' }]) },
    verifierPanel: indepPanel(3),
    verifierFn: async () => ({ refuted: false, confidence: 'high' }), // independent quorum CONFIRMS the bug
  });
  assert.equal(res.findings.confirmed.length, 1);
  assert.equal(res.status, 'blocked');
  const id = res.findings.confirmed[0].id;
  assert.deepEqual(res.blockedReasons, [`${PANEL_REASONS.UNRESOLVED_BLOCKER}:${id}`]);
  // the blocking finding is durably OPEN in the register (feeds convergence)
  const doc = readDoc(file);
  assert.ok(doc.openItems.some((o) => o.id === id), 'confirmed blocker is persisted OPEN');
  cleanup(dir);
});

test('a CONFIRMED low-severity finding (nit) is open but does NOT block ship prep', async () => {
  const { dir, file } = mkCheckpoint();
  const res = await runReviewPanel({
    file, dimensions: ['correctness'],
    dimensionFns: { correctness: fakeDimension([{ file: 'x.js', issue: 'rename var', severity: 'nit' }]) },
    verifierPanel: indepPanel(3),
    verifierFn: async () => ({ refuted: false }),
  });
  assert.equal(res.findings.confirmed.length, 1);
  assert.equal(res.status, 'ok', 'a confirmed nit does not gate ship prep');
  assert.equal(res.blocking.length, 0);
  assert.equal(res.canAdvanceShipPrep, true);
  cleanup(dir);
});

// ═══ integration + guards ═══════════════════════════════════════════════════════════════

test('assertCanAdvanceShipPrep passes an ok panel and throws EXIT.BLOCKED on a blocked one', async () => {
  const { dir, file } = mkCheckpoint();
  const ok = await runReviewPanel({
    file, dimensions: ['correctness'],
    dimensionFns: { correctness: fakeDimension([]) },
    verifierPanel: indepPanel(1), verifierFn: async () => ({ refuted: true }),
  });
  assert.equal(assertCanAdvanceShipPrep(ok), true);

  const two = mkCheckpoint();
  const bad = await runReviewPanel({
    file: two.file, dimensions: ['correctness', 'security'],
    dimensionFns: { correctness: fakeDimension([]) },
    verifierPanel: indepPanel(1), verifierFn: async () => ({ refuted: true }),
  });
  assert.throws(() => assertCanAdvanceShipPrep(bad),
    (e) => e instanceof ReviewPanelError && e.code === EXIT.BLOCKED && /cannot advance ship prep/.test(e.message));
  cleanup(dir); cleanup(two.dir);
});

test('shipPrepReadiness combines panel blockers with the pipeline convergence conjunction', async () => {
  const { dir, file } = mkCheckpoint();
  const clean = await runReviewPanel({
    file, dimensions: ['correctness'],
    dimensionFns: { correctness: fakeDimension([]) },
    verifierPanel: indepPanel(1), verifierFn: async () => ({ refuted: true }),
  });
  // panel is clean, but the pipeline itself is not converged (a unit is unfinished) ⇒ not ready
  const notReady = shipPrepReadiness(clean, {
    units: { u1: { status: 'in_progress' } },
    phases: { build: 'done', test: 'done', review: 'done' },
    finalValidation: { passed: true },
  });
  assert.equal(notReady.ready, false);
  assert.equal(notReady.panelBlockers.length, 0);
  assert.ok(notReady.convergenceFailures.some((f) => f.code === 'unit-unfinished'));

  // panel clean AND pipeline converged ⇒ ready
  const ready = shipPrepReadiness(clean, {
    units: { u1: { status: 'done' } },
    phases: { build: 'done', simplify: 'skipped', test: 'done', review: 'done', performance: 'skipped', ship_prep: 'done' },
    finalValidation: { passed: true },
  });
  assert.equal(ready.ready, true);
  cleanup(dir);
});

test('the verdict vocabulary is exactly the four typed dispositions', () => {
  assert.deepEqual([...VERDICTS].sort(), ['confirmed', 'refuted', 'resolved', 'unverified']);
});
