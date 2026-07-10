#!/usr/bin/env node
// test-authorization.mjs — behavior contract for autonomous-pipeline/scripts/lib/authorization.mjs.
//
// The controller mints/consumes ONE-USE, hash-bound capabilities for the two privileged transitions
// (plan approval → start; action capability → an irreversible ship/deploy/publish/remote-merge). These
// tests drive the ACTUAL module against real temp files + a real checkpoint store and pin every
// load-bearing guarantee from the task's acceptance criteria:
//   1. one-use O_EXCL hash-bound plan approval from PREPARED; interactive-operator only; NO auto-chain;
//      children get no capability material.
//   2. an irreversible request HALTS at awaiting_authorization; a fresh action-scoped TTL capability is
//      consumed just before the action; a plan approval never satisfies it.
//   3. every refusal (missing/expired/replayed/revoked/mismatched/symlinked/unsafe-mode/child-issued,
//      and issuance while an executor is active) fails before the action; post-consume crash →
//      outcome_unknown, never auto-retried.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, symlinkSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AuthorizationError, CAP_KINDS, PLAN_KIND, REASONS,
  contentSha, digestBindings, checkpointRevisionOf,
  assertCapabilityDirIsolated, executorActive, isInteractiveOperator, detectContext,
  markPrepared, haltForAuthorization,
  issuePlanApproval, consumePlanApproval,
  issueActionCapability, consumeActionCapability,
  verifyCapability, completeCapability, revokeCapability, reconcileCapability,
} from '../autonomous-pipeline/scripts/lib/authorization.mjs';
import { init, unit } from '../checkpoint-resume/scripts/lib/checkpoint-store.mjs';

// ── fixture helpers ─────────────────────────────────────────────────────────────────────────────────
let seq = 0;
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ulpi-auth-'));
  const capDir = join(dir, 'auth');       // coordinator-private issuance dir (created by the module)
  const runsDir = join(dir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  const checkpointFile = join(runsDir, `run-${++seq}.json`);
  return { dir, capDir, checkpointFile };
}
// A checkpoint at status `prepared` with idle units — the window plan approval is minted from.
function preparedRun(checkpointFile) {
  init(checkpointFile, { task: 'demo', units: ['u1', 'u2'] });
  markPrepared(checkpointFile);
}
// Interactive coordinator context, passed explicitly so tests never depend on the real TTY/env.
const OPERATOR = { interactive: true, context: 'coordinator' };
const PLAN = '{"tasks":[],"layers":[],"budget":{"tokens":1000}}';
const CONFIG = '{"budget":{"tokens":1000},"sandbox":"workspace-write"}';
const BIND = { baseSha: 'a'.repeat(40), targetRef: 'main', engineVersion: 'codex-1.2.3' };

function issuePlan(fx, over = {}) {
  return issuePlanApproval({
    capDir: fx.capDir, run: 'run1', rawPlan: PLAN, config: CONFIG,
    ...BIND, ttlMs: 60_000, nonce: 'nonce-plan-1', checkpointFile: fx.checkpointFile, ...OPERATOR, ...over,
  });
}
function consumePlan(fx, over = {}) {
  return consumePlanApproval({
    capDir: fx.capDir, run: 'run1', rawPlan: PLAN, config: CONFIG, ...BIND, nonce: 'nonce-plan-1', ...over,
  });
}

// ── 0. exported vocabulary ────────────────────────────────────────────────────────────────────────
test('vocabulary: plan + the four irreversible actions are the capability kinds; reasons are exhaustive', () => {
  assert.deepEqual(CAP_KINDS, ['plan', 'ship', 'deploy', 'publish', 'remote-merge']);
  for (const r of ['missing', 'expired', 'replayed', 'revoked', 'mismatched', 'symlinked', 'unsafe-mode',
    'child-issued', 'not-interactive', 'child-context', 'executor-active', 'wrong-state', 'wrong-kind',
    'already-issued', 'outcome-unknown']) {
    assert.ok(REASONS.includes(r), `REASONS must include ${r}`);
  }
});

// ── 1. one-use, hash-bound plan approval from PREPARED ──────────────────────────────────────────────
test('plan approval: minted from PREPARED, hash-bound, consumed exactly once (replay refused)', () => {
  const fx = scratch();
  preparedRun(fx.checkpointFile);

  const cap = issuePlan(fx);
  assert.equal(cap.kind, PLAN_KIND);
  assert.equal(cap.status, 'issued');
  assert.equal(cap.bindings.planSha, contentSha(PLAN));
  assert.equal(cap.bindings.configSha, contentSha(CONFIG));
  assert.equal(cap.digest, digestBindings(cap.bindings));

  // consume once → ok
  const used = consumePlan(fx);
  assert.equal(used.record.status, 'consumed');

  // consume again → replayed (the single-winner rename already moved it)
  assert.throws(() => consumePlan(fx), (e) => e instanceof AuthorizationError && e.reason === 'replayed');
});

test('plan approval is written O_EXCL mode-0600 and re-issue for the same key is refused (one-use mint)', () => {
  const fx = scratch();
  preparedRun(fx.checkpointFile);
  issuePlan(fx);
  const capFile = join(fx.capDir, 'run1.plan.cap.json');
  const st = lstatSync(capFile);
  assert.ok(st.isFile());
  assert.equal(st.mode & 0o777, 0o600, 'capability file must be owner-only 0600');
  // a second mint for the same key is refused (cannot double-issue)
  assert.throws(() => issuePlan(fx), (e) => e.reason === 'already-issued');
});

test('plan approval refuses a mismatched plan/config/base/nonce (hash binding)', () => {
  for (const bad of [
    { rawPlan: PLAN + ' ' },           // edited plan
    { config: '{"budget":{"tokens":2}}' }, // changed budget in config
    { baseSha: 'b'.repeat(40) },        // moved base
    { targetRef: 'release' },           // different target
    { engineVersion: 'codex-9.9.9' },   // engine drift
    { nonce: 'other-nonce' },           // replayed/forged nonce
  ]) {
    const fx = scratch();
    preparedRun(fx.checkpointFile);
    issuePlan(fx);
    assert.throws(() => consumePlan(fx, bad),
      (e) => e instanceof AuthorizationError && e.reason === 'mismatched',
      `expected mismatched for ${JSON.stringify(bad)}`);
  }
});

test('plan approval may be minted ONLY from PREPARED (not from a running run)', () => {
  const fx = scratch();
  init(fx.checkpointFile, { task: 'demo', units: ['u1'] }); // status: running, not prepared
  assert.throws(() => issuePlan(fx), (e) => e.reason === 'wrong-state');
});

// ── interactive-operator only + no auto-chain ───────────────────────────────────────────────────────
test('issuance requires an INTERACTIVE operator — a piped/non-interactive mint is refused', () => {
  const fx = scratch();
  preparedRun(fx.checkpointFile);
  assert.throws(() => issuePlan(fx, { interactive: false }), (e) => e.reason === 'not-interactive');
});

test('issuance is coordinator-only — an executor/adapter context mint is refused (no child-issued caps)', () => {
  for (const ctx of ['executor', 'adapter']) {
    const fx = scratch();
    preparedRun(fx.checkpointFile);
    assert.throws(() => issuePlan(fx, { context: ctx }), (e) => e.reason === 'child-context');
  }
});

test('NO auto-chain: mint (human-gated) and consume (machine-runnable) are distinct calls; consume needs no operator', () => {
  const fx = scratch();
  preparedRun(fx.checkpointFile);
  // A non-interactive process cannot MINT ...
  assert.throws(() => issuePlan(fx, { interactive: false }), (e) => e.reason === 'not-interactive');
  // ... but once a human has minted, a fully non-interactive/automated `start` can consume it. The two
  // are separate primitives — there is no single call that mints-and-starts.
  issuePlan(fx);
  const used = consumePlan(fx); // note: no interactive/context flags on consume
  assert.equal(used.record.status, 'consumed');
});

// ── child isolation ─────────────────────────────────────────────────────────────────────────────────
test('child isolation: the capability dir must live OUTSIDE every executor worktree', () => {
  const inside = '/work/wt/task-1/.ulpi/auth';
  const worktree = '/work/wt/task-1';
  assert.throws(() => assertCapabilityDirIsolated(inside, [worktree]), (e) => e.reason === 'child-context');
  // a sibling dir outside the worktree is fine
  assert.equal(assertCapabilityDirIsolated('/work/coordinator/auth', [worktree]), true);
});

test('child isolation: minting is refused when capDir sits inside a declared worktree', () => {
  const fx = scratch();
  preparedRun(fx.checkpointFile);
  const worktree = fx.capDir; // pretend the cap dir IS a worktree (children would receive it)
  assert.throws(() => issuePlan(fx, { worktreePaths: [worktree] }), (e) => e.reason === 'child-context');
});

// ── 2. irreversible action: halt → fresh action-scoped capability → action ──────────────────────────
function haltedRun(checkpointFile, action = 'ship', evidence = 'evidence-blob') {
  init(checkpointFile, { task: 'demo', units: ['u1'] });
  return haltForAuthorization({ checkpointFile, action, evidence });
}
function issueAction(fx, action = 'ship', over = {}) {
  return issueActionCapability({
    capDir: fx.capDir, run: 'run1', action, ...BIND,
    ttlMs: 60_000, nonce: 'nonce-act-1', checkpointFile: fx.checkpointFile, ...OPERATOR, ...over,
  });
}
function consumeAction(fx, action = 'ship', over = {}) {
  return consumeActionCapability({
    capDir: fx.capDir, run: 'run1', action, checkpointFile: fx.checkpointFile, ...BIND, nonce: 'nonce-act-1', ...over,
  });
}

test('irreversible request HALTS at awaiting_authorization with zero live children + evidence + revision', () => {
  const fx = scratch();
  const halt = haltedRun(fx.checkpointFile, 'ship', 'the-evidence');
  assert.equal(halt.status, 'awaiting_authorization');
  assert.equal(halt.liveChildren, 0);
  assert.equal(halt.evidenceSha, contentSha('the-evidence'));
  const doc = JSON.parse(readFileSync(fx.checkpointFile, 'utf8'));
  assert.equal(doc.status, 'awaiting_authorization');
  assert.equal(doc.pendingAuthorization.action, 'ship');
  assert.equal(doc.pendingAuthorization.checkpointRevision, halt.checkpointRevision);
});

test('halt is REFUSED while children are live (must quiesce first)', () => {
  const fx = scratch();
  init(fx.checkpointFile, { task: 'demo', units: ['u1'] });
  unit(fx.checkpointFile, 'u1', 'in_progress'); // a live executor
  assert.throws(() => haltForAuthorization({ checkpointFile: fx.checkpointFile, action: 'ship', evidence: 'x' }),
    (e) => e.reason === 'executor-active');
});

test('fresh action-scoped capability is minted from the halt and consumed just before the action', () => {
  const fx = scratch();
  haltedRun(fx.checkpointFile, 'deploy', 'ev');
  const cap = issueAction(fx, 'deploy');
  assert.equal(cap.kind, 'deploy');
  assert.equal(cap.bindings.action, 'deploy');
  assert.equal(cap.bindings.evidenceSha, contentSha('ev'));
  const used = consumeAction(fx, 'deploy');
  assert.equal(used.record.status, 'consumed');
  assert.equal(used.record.bindings.action, 'deploy');
});

test('a plan approval NEVER satisfies an action capability (distinct kind + key)', () => {
  const fx = scratch();
  // Prepare, mint a plan approval, then move the SAME run to a halt for an action.
  init(fx.checkpointFile, { task: 'demo', units: ['u1'] });
  markPrepared(fx.checkpointFile);
  issuePlan(fx); // run1.plan.cap.json now exists
  haltForAuthorization({ checkpointFile: fx.checkpointFile, action: 'ship', evidence: 'ev' });
  // There is NO ship capability — only a plan one. Consuming the action must fail `missing`, never
  // silently accept the plan approval.
  assert.throws(() => consumeAction(fx, 'ship'), (e) => e instanceof AuthorizationError && e.reason === 'missing');
});

test('action capability MISMATCHES if the checkpoint drifts after the halt (revision binding)', () => {
  const fx = scratch();
  haltedRun(fx.checkpointFile, 'publish', 'ev');
  issueAction(fx, 'publish');
  // simulate drift: a unit changes state after the capability was minted
  const doc = JSON.parse(readFileSync(fx.checkpointFile, 'utf8'));
  doc.units.u1.status = 'done';
  writeFileSync(fx.checkpointFile, JSON.stringify(doc, null, 2) + '\n');
  assert.throws(() => consumeAction(fx, 'publish'), (e) => e.reason === 'mismatched');
});

test('action capability may be minted only from awaiting_authorization for THIS action', () => {
  const fx = scratch();
  haltedRun(fx.checkpointFile, 'ship', 'ev');
  // wrong action for the same halt
  assert.throws(() => issueAction(fx, 'deploy'), (e) => e.reason === 'wrong-state');
});

// ── 3. every refusal case fails BEFORE the action ───────────────────────────────────────────────────
test('refusal: MISSING capability', () => {
  const fx = scratch();
  assert.throws(() => consumePlan(fx), (e) => e.reason === 'missing');
});

test('refusal: EXPIRED capability (TTL elapsed)', () => {
  const fx = scratch();
  preparedRun(fx.checkpointFile);
  issuePlanApproval({ capDir: fx.capDir, run: 'run1', rawPlan: PLAN, config: CONFIG, ...BIND,
    ttlMs: 1000, nonce: 'nonce-plan-1', checkpointFile: fx.checkpointFile, now: 0, ...OPERATOR });
  // consume at a time past expiry
  assert.throws(() => consumePlan(fx, { now: 5000 }), (e) => e.reason === 'expired');
});

test('refusal: REVOKED capability', () => {
  const fx = scratch();
  preparedRun(fx.checkpointFile);
  issuePlan(fx);
  revokeCapability({ capDir: fx.capDir, run: 'run1', kind: PLAN_KIND });
  assert.throws(() => consumePlan(fx), (e) => e.reason === 'revoked');
});

test('refusal: SYMLINKED capability file is never followed', () => {
  const fx = scratch();
  preparedRun(fx.checkpointFile);
  issuePlan(fx);
  const capFile = join(fx.capDir, 'run1.plan.cap.json');
  // move the real file aside and drop a symlink in its place pointing at valid content
  const real = capFile + '.real';
  renameSync(capFile, real);
  symlinkSync(real, capFile);
  assert.ok(lstatSync(capFile).isSymbolicLink());
  assert.throws(() => consumePlan(fx), (e) => e.reason === 'symlinked');
});

test('refusal: UNSAFE-MODE (group/world readable) capability file', () => {
  const fx = scratch();
  preparedRun(fx.checkpointFile);
  issuePlan(fx);
  const capFile = join(fx.capDir, 'run1.plan.cap.json');
  chmodSync(capFile, 0o644); // broaden beyond owner-only
  assert.throws(() => consumePlan(fx), (e) => e.reason === 'unsafe-mode');
});

test('refusal: CHILD-ISSUED capability (issuerContext is not the coordinator)', () => {
  const fx = scratch();
  preparedRun(fx.checkpointFile);
  issuePlan(fx);
  const capFile = join(fx.capDir, 'run1.plan.cap.json');
  const rec = JSON.parse(readFileSync(capFile, 'utf8'));
  rec.issuerContext = 'executor'; // forge a child-minted capability
  writeFileSync(capFile, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  assert.throws(() => consumePlan(fx), (e) => e.reason === 'child-issued');
});

test('refusal: issuance while an EXECUTOR is ACTIVE', () => {
  const fx = scratch();
  init(fx.checkpointFile, { task: 'demo', units: ['u1'] });
  // Force prepared status but with a live unit so executorActive() is true.
  const doc = JSON.parse(readFileSync(fx.checkpointFile, 'utf8'));
  doc.status = 'prepared';
  doc.units.u1.status = 'in_progress';
  writeFileSync(fx.checkpointFile, JSON.stringify(doc, null, 2) + '\n');
  assert.ok(executorActive(doc));
  assert.throws(() => issuePlan(fx), (e) => e.reason === 'executor-active');
});

test('refusal: WRONG-KIND — a stored record whose kind differs from the lookup is rejected', () => {
  const fx = scratch();
  haltedRun(fx.checkpointFile, 'ship', 'ev');
  const cap = issueAction(fx, 'ship'); // stored at key run1.ship
  const capFile = join(fx.capDir, 'run1.ship.cap.json');
  const rec = JSON.parse(readFileSync(capFile, 'utf8'));
  rec.kind = 'deploy'; // forge a kind that no longer matches its key/lookup
  writeFileSync(capFile, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  // looked up as 'ship' (its key) but the record now claims 'deploy' → wrong-kind, before any consume
  const v = verifyCapability({ capDir: fx.capDir, run: 'run1', kind: 'ship', present: cap.bindings });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'wrong-kind');
});

// ── post-consume crash → outcome_unknown, never auto-retried ─────────────────────────────────────────
test('crash after consume before completion → outcome_unknown and NEVER auto-retried', () => {
  const fx = scratch();
  haltedRun(fx.checkpointFile, 'remote-merge', 'ev');
  issueAction(fx, 'remote-merge');
  consumeAction(fx, 'remote-merge'); // consumed, but the process "crashes" before completeCapability

  const rec = reconcileCapability({ capDir: fx.capDir, run: 'run1', kind: 'remote-merge' });
  assert.equal(rec.status, 'outcome_unknown');
  assert.equal(rec.retryable, false);

  // No auto-retry: a consumed capability can never be re-minted for the same key.
  assert.throws(() => issueAction(fx, 'remote-merge'), (e) => e.reason === 'already-issued');
});

test('a COMPLETED capability reconciles as completed (not outcome_unknown)', () => {
  const fx = scratch();
  haltedRun(fx.checkpointFile, 'ship', 'ev');
  issueAction(fx, 'ship');
  consumeAction(fx, 'ship');
  completeCapability({ capDir: fx.capDir, run: 'run1', kind: 'ship', outcome: 'succeeded' });
  const rec = reconcileCapability({ capDir: fx.capDir, run: 'run1', kind: 'ship' });
  assert.equal(rec.status, 'completed');
  // and it is likewise non-retryable / cannot be re-minted
  assert.throws(() => issueAction(fx, 'ship'), (e) => e.reason === 'already-issued');
});

// ── pure helpers ────────────────────────────────────────────────────────────────────────────────────
test('contentSha hashes strings/buffers byte-for-byte and objects canonically (order-insensitive)', () => {
  assert.equal(contentSha('abc'), contentSha(Buffer.from('abc')));
  assert.equal(contentSha({ a: 1, b: 2 }), contentSha({ b: 2, a: 1 }));
  assert.notEqual(contentSha('abc'), contentSha('abd'));
});

test('checkpointRevisionOf is stable across volatile timestamps but changes with real state', () => {
  const base = { status: 'awaiting_authorization', units: { u1: { status: 'pending' } },
    pendingAuthorization: { action: 'ship', evidenceSha: 'e', checkpointRevision: 'ignored' } };
  const withTs = { ...base, updatedAt: '2020-01-01T00:00:00Z' };
  assert.equal(checkpointRevisionOf(base), checkpointRevisionOf(withTs), 'timestamp must not affect revision');
  const drifted = { ...base, units: { u1: { status: 'done' } } };
  assert.notEqual(checkpointRevisionOf(base), checkpointRevisionOf(drifted), 'a unit change must change the revision');
});

test('environment probes: non-interactive/CI is refused; executor role is detected', () => {
  assert.equal(isInteractiveOperator({ CI: '1' }, { stdin: { isTTY: true }, stdout: { isTTY: true } }), false);
  assert.equal(isInteractiveOperator({ ULPI_NONINTERACTIVE: '1' }, { stdin: { isTTY: true }, stdout: { isTTY: true } }), false);
  assert.equal(isInteractiveOperator({}, { stdin: { isTTY: true }, stdout: { isTTY: true } }), true);
  assert.equal(detectContext({ ULPI_ROLE: 'executor' }), 'executor');
  assert.equal(detectContext({ CODEX_SANDBOX: 'workspace-write' }), 'executor');
  assert.equal(detectContext({}), 'coordinator');
});
