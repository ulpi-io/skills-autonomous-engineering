#!/usr/bin/env node
// test-pipeline-e2e.mjs — a ZERO-NETWORK END-TO-END harness that drives the REAL pipeline coordinator
// (autonomous-pipeline/scripts/pipeline.mjs → pipeline-engine → the real build-engine, phase-engine,
// git-workspaces, git-integration, budget-ledger, review-panel and checkpoint store) over TEMPORARY git
// repos, with a FAKE `codex` CLI (scripts/fixtures/fake-codex.mjs) standing in for the executor.
//
// Nothing here is stubbed except the two seams a production run would fill with real infrastructure: the
// engineer executor (→ the fake codex subprocess, invoked through the REAL codex-executor.runCodexTask so
// buildCodexArgv / process-runner / the schema-output gate all run) and the post-build phase agents/review
// (lightweight, but each drives the REAL phase-engine gates and a REAL coordinator-run validation). The
// build DAG, worktree isolation, integration, convergence conjunction, finalize and publication are the
// genuine modules operating on a genuine repo.
//
//   AC1  Two independent tasks run in DISTINCT worktrees; one FORCED red leaves the other durable; no
//        downstream phase runs and NO publication occurs.
//   AC2  RESUME repairs ONLY the failed task, SKIPS the durable one, runs every required gate, and
//        publishes EXACTLY ONCE after final validation.
//   AC3  A clean run preserves deterministic phase ordering, bounded parallelism, checkpoint evidence,
//        commit reachability, budget consumption and an honest final result.
//
// Adversarial/security cases (smuggled flags, capability escape, hostile scope, publication races) are
// owned SEPARATELY by TASK-044 and are deliberately NOT duplicated here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { main } from '../autonomous-pipeline/scripts/pipeline.mjs';
import { EXIT, assertSingleStdoutObject } from '../autonomous-pipeline/scripts/lib/cli-contract.mjs';
import { runCodexTask, preflightCodex, PINNED_CODEX_VERSION } from '../autonomous-pipeline/scripts/lib/codex-executor.mjs';
import { publishToTarget } from '../autonomous-pipeline/scripts/lib/git-integration.mjs';
import { integratedTaskIds } from '../autonomous-pipeline/scripts/lib/build-engine.mjs';
import { readDoc } from '../checkpoint-resume/scripts/lib/checkpoint-store.mjs';
import { makeGitRepo, refSha, isAncestor } from './fixtures/git-repo-fixture.mjs';

const fakeCodexPath = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

// The coordinator's INDEPENDENT per-task slice-validate: read the (materialized) in-scope file and go RED
// iff the fake codex wrote a `MODE:RED` marker into it. This is the coordinator observing the agent's work,
// never trusting the agent's `built:true`.
const VALIDATOR = "const fs=require('fs');let s='';try{s=fs.readFileSync(process.argv[1],'utf8')}catch(e){process.exit(2)}process.exit(/MODE:RED/.test(s)?1:0);";

// A collectable stream for the CLI's single-JSON-object stdout.
function sink() { const c = []; return { write: (s) => { c.push(s); return true; }, text: () => c.join('') }; }
function newSpies() { return { seq: 0, events: [], execCalls: [], concurrent: 0, maxConcurrent: 0 }; }

// A REAL coordinator-run validation in the integration worktree: a genuine child process that exits 0.
function realGreen(cwd) { const r = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { cwd }); return { ok: r.status === 0 }; }

// The engineer executor seam: records enter/exit + live concurrency, then runs the FAKE codex through the
// REAL codex-executor (exercising the pinned argv + schema-output contract) inside the task's own worktree.
function makeExecutor(fx, spies) {
  return async ({ taskId, worktree }) => {
    spies.execCalls.push(taskId);
    spies.events.push({ id: taskId, kind: 'enter', seq: spies.seq++, worktree });
    spies.concurrent += 1;
    spies.maxConcurrent = Math.max(spies.maxConcurrent, spies.concurrent);
    let res;
    try {
      res = await runCodexTask({
        prompt: `implement ${taskId}`,
        sandbox: 'workspace-write',
        cd: worktree,
        schemaFile: fx.schemaPath,
        outputLastMessage: join(fx.controlDir, `out-${taskId}.json`),
        bin: process.execPath,          // spawn the local node…
        program: fakeCodexPath,         // …with the fake codex script as codex's stand-in
        skipPreflight: true,            // preflight is exercised on its own below; skip the extra spawns here
        env: { ...process.env, FAKE_CODEX_TASK: taskId, FAKE_CODEX_CONTROL: fx.controlPath },
      });
    } finally {
      spies.concurrent -= 1;
      spies.events.push({ id: taskId, kind: 'exit', seq: spies.seq++ });
    }
    return { built: res.ok === true, codex: res };
  };
}

// The seams that drive start/resume through the REAL build + phase + publish machinery. Only the executor,
// the post-build phase agents and the review dimension are fakes; every gate they feed is the real one.
function startSeams(fx, spies) {
  return {
    prepareWorkspace: async () => ({ integrationDir: fx.root }),
    executor: makeExecutor(fx, spies),
    validateFor: (id) => ({ command: process.execPath, args: ['-e', VALIDATOR, join(fx.root, 'src', `${id}.js`)] }),
    review: async () => ({ canAdvance: true }),
    phaseFns: { test: async () => { spies.phaseTestRan = true; return { ok: true, tokens: { input: 1, output: 1 } }; } },
    validateFn: async ({ phase }) => { const r = realGreen(fx.root); return { ok: r.ok, head: '', signature: phase }; },
    finalValidateFn: async () => { spies.finalValidateRan = true; spies.finalValidateSeq = spies.seq++; return realGreen(fx.root); },
    reviewOptions: {
      dimensions: ['correctness'],
      dimensionFns: { correctness: async () => { spies.reviewDimRan = true; return { findings: [] }; } },
      verifierPanel: [], verifierFn: () => null,
    },
    // The REAL fast-forward publication, wrapped only to COUNT and ORDER it (proves exactly-once, and that
    // it happens after final validation). The publication logic itself is untouched.
    publishFn: (o) => { spies.publishCount = (spies.publishCount || 0) + 1; spies.publishSeq = spies.seq++; return publishToTarget(o); },
  };
}

const approveIo = (fx, out) => ({ env: { ULPI_RUNS_DIR: fx.stateDir }, cwd: fx.dir, stdout: out, stderr: sink(), seams: { interactive: true, context: 'coordinator' } });
const driveIo = (fx, seams, out) => ({ env: { ULPI_RUNS_DIR: fx.stateDir }, cwd: fx.dir, stdout: out, stderr: sink(), seams });

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// The fake codex is a faithful stand-in for the pinned CLI (proves the executor path is genuinely end-to-end)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
test('fake codex honors the pinned cli-contract: preflight version + flags, argv contract, schema output', async () => {
  // Full preflight (version + `exec --help` flag advertisement) against the fake.
  const pf = await preflightCodex({ bin: process.execPath, program: fakeCodexPath });
  assert.equal(pf.ok, true, JSON.stringify(pf));
  assert.equal(pf.version, PINNED_CODEX_VERSION);

  // A full runCodexTask: buildCodexArgv → process-runner → the fake → the schema-output gate.
  const dir = mkdtempSync(join(tmpdir(), 'ulpi-fk-'));
  try {
    const cd = join(dir, 'wt'); mkdirSync(cd, { recursive: true });
    const outFile = join(dir, 'out.json');
    const schema = join(dir, 'schema.json'); writeFileSync(schema, '{}');
    const res = await runCodexTask({
      prompt: 'do it', sandbox: 'workspace-write', cd, schemaFile: schema, outputLastMessage: outFile,
      bin: process.execPath, program: fakeCodexPath, env: { ...process.env, FAKE_CODEX_TASK: 'alpha' },
    });
    assert.equal(res.status, 'ok', JSON.stringify(res));
    assert.equal(res.role, 'engineer');
    assert.ok(Array.isArray(res.evidence) && res.evidence.length >= 1);
    assert.ok(existsSync(join(cd, 'src', 'alpha.js')), 'the fake wrote its in-scope file into --cd');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// AC1 + AC2 — one forced-red task is isolated; resume repairs only it and publishes exactly once
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
test('AC1/AC2: forced-red isolates the failure durably; resume repairs only it, runs every gate, publishes once', async () => {
  const fx = makeGitRepo({ layers: [['alpha', 'beta']], redTasks: ['beta'] });
  try {
    // approve
    let out = sink();
    let code = await main(['approve', '--plan', fx.planPath, '--config', fx.configPath, '--json'], approveIo(fx, out));
    assert.equal(code, EXIT.SUCCESS, out.text());
    assert.equal(assertSingleStdoutObject(out.text().trim()).status, 'prepared');

    // ── start → BLOCKED (beta is forced red) ──
    const s1 = newSpies();
    out = sink();
    code = await main(['start', '--run', fx.run, '--json'], driveIo(fx, startSeams(fx, s1), out));
    assert.equal(code, EXIT.BLOCKED, out.text());
    const started = assertSingleStdoutObject(out.text().trim());
    assert.equal(started.status, 'blocked');
    assert.equal(started.blockedStage, 'build');

    // AC1: two independent tasks ran, each in its OWN distinct worktree (never the integration worktree).
    const enters1 = s1.events.filter((e) => e.kind === 'enter');
    assert.equal(enters1.length, 2, 'both layer tasks executed');
    assert.deepEqual(s1.execCalls.sort(), ['alpha', 'beta']);
    const wts = enters1.map((e) => e.worktree);
    assert.equal(new Set(wts).size, 2, 'distinct worktrees');
    for (const w of wts) {
      assert.notEqual(w, fx.root, 'a task never runs in the integration worktree');
      assert.ok(w.startsWith(join(fx.worktreesDir, 'task-')), 'each task ran in its own task worktree');
    }

    // AC1: the OTHER task is durable; the forced-red one did NOT integrate; nothing downstream ran/published.
    const integ1 = integratedTaskIds(fx.root, fx.integrationRef);
    assert.equal(integ1.has('alpha'), true, 'alpha integrated (durable commit on the integration branch)');
    assert.equal(integ1.has('beta'), false, 'the forced-red task did NOT integrate');
    let doc = readDoc(fx.checkpointFile);
    assert.equal(doc.units.alpha.status, 'done');
    assert.equal(doc.units.beta.status, 'blocked');
    assert.equal(doc.units.beta.note, 'integration-failed', 'beta blocked at the coordinator slice-validate (forced red)');
    assert.equal(doc.status, 'needs_attention');
    assert.notEqual(doc.phases?.test?.status, 'done', 'no post-build phase ran');
    assert.notEqual(doc.phases?.review?.status, 'done');
    assert.equal(s1.publishCount || 0, 0, 'no publication attempted on a blocked build');
    assert.equal(refSha(fx.root, 'refs/heads/main'), fx.base, 'the target ref is unmoved (no publication)');

    // ── AC2: repair beta (fixture state only — no plan/config drift) and RESUME ──
    fx.setRedTasks([]);
    const s2 = newSpies();
    out = sink();
    code = await main(['resume', '--run', fx.run, '--json'], driveIo(fx, startSeams(fx, s2), out));
    assert.equal(code, EXIT.SUCCESS, out.text());
    const resumed = assertSingleStdoutObject(out.text().trim());
    assert.equal(resumed.status, 'done');
    assert.equal(resumed.published, true);
    assert.equal(resumed.converged, true);

    // Resume re-executed ONLY the failed task; the durable one was skipped (never re-run).
    assert.deepEqual(s2.execCalls, ['beta'], 'resume repaired only the failed task; the durable one was skipped');

    // Every required gate actually ran (test agent, review dimension, terminal final validation).
    assert.equal(s2.phaseTestRan, true, 'the test phase ran');
    assert.equal(s2.reviewDimRan, true, 'the review dimension ran');
    assert.equal(s2.finalValidateRan, true, 'the final validation ran');

    // Exactly ONE publication, and it happened AFTER final validation.
    assert.equal(s2.publishCount, 1, 'published exactly once');
    assert.ok(s2.finalValidateSeq < s2.publishSeq, 'publication follows final validation');

    // Durable evidence + fast-forward of the target to the integration tip; both commits reachable.
    doc = readDoc(fx.checkpointFile);
    assert.equal(doc.status, 'done');
    assert.equal(doc.units.beta.status, 'done');
    assert.equal(doc.phases.build.status, 'done');
    assert.equal(doc.phases.test.status, 'done');
    assert.equal(doc.phases.review.status, 'done');
    assert.equal(doc.finalValidation.status, 'green');
    const tip = refSha(fx.root, fx.integrationRef);
    assert.equal(refSha(fx.root, 'refs/heads/main'), tip, 'the target fast-forwarded to the integration tip');
    const integ2 = integratedTaskIds(fx.root, fx.integrationRef);
    assert.ok(integ2.has('alpha') && integ2.has('beta'), 'both tasks reachable from the integration branch');
    assert.ok(isAncestor(fx.root, fx.base, tip), 'the publish was a fast-forward from the approved base');
  } finally { fx.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// AC3 — a clean multi-layer run: ordering, bounded parallelism, evidence, reachability, budget, honesty
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
test('AC3: a clean run preserves ordering, bounded parallelism, checkpoint evidence, reachability, budget, honest result', async () => {
  const fx = makeGitRepo({ layers: [['alpha', 'beta'], ['gamma']], redTasks: [] });
  try {
    let out = sink();
    let code = await main(['approve', '--plan', fx.planPath, '--config', fx.configPath, '--json'], approveIo(fx, out));
    assert.equal(code, EXIT.SUCCESS, out.text());

    const spies = newSpies();
    out = sink();
    code = await main(['start', '--run', fx.run, '--json'], driveIo(fx, startSeams(fx, spies), out));
    assert.equal(code, EXIT.SUCCESS, out.text());
    const r = assertSingleStdoutObject(out.text().trim());

    // Honest final result: genuinely converged, finalized done, and published — no fabricated green.
    assert.equal(r.status, 'done');
    assert.equal(r.converged, true);
    assert.equal(r.published, true);

    // Deterministic ordering / layer barrier: the layer-2 task entered only AFTER both layer-1 tasks exited.
    const enterSeq = (id) => spies.events.find((e) => e.id === id && e.kind === 'enter').seq;
    const exitSeq = (id) => spies.events.find((e) => e.id === id && e.kind === 'exit').seq;
    assert.ok(enterSeq('gamma') > exitSeq('alpha') && enterSeq('gamma') > exitSeq('beta'),
      'layer-2 started only after the layer-1 barrier');

    // Bounded parallelism: concurrency never exceeded the layer width, and layer-1 genuinely overlapped.
    assert.equal(spies.maxConcurrent, 2, 'bounded parallelism equal to the layer width (2)');

    // Distinct worktrees for all three tasks.
    const wts = spies.events.filter((e) => e.kind === 'enter').map((e) => e.worktree);
    assert.equal(new Set(wts).size, 3, 'three distinct task worktrees');

    // Checkpoint evidence: every unit done with an integration note; required phases green; optionals skipped.
    const doc = readDoc(fx.checkpointFile);
    assert.equal(doc.status, 'done');
    for (const id of fx.allIds) {
      assert.equal(doc.units[id].status, 'done', `${id} durably done`);
      assert.ok(/^integrated:/.test(doc.units[id].note || ''), `${id} carries its integration evidence`);
    }
    assert.equal(doc.phases.build.status, 'done');
    assert.equal(doc.phases.test.status, 'done');
    assert.equal(doc.phases.review.status, 'done');
    for (const p of ['simplify', 'performance', 'ship_prep']) assert.equal(doc.phases[p].status, 'skipped');
    assert.equal(doc.finalValidation.status, 'green');

    // Budget consumption: a spawn was reserved per build task, every reservation settled, none leaked, no stop.
    assert.ok(doc.budget.spend.codexCalls >= fx.allIds.length, 'a codex spawn reserved per build task (plus phases)');
    assert.equal(doc.budget.spend.settledCalls, doc.budget.spend.codexCalls, 'every reservation settled');
    assert.equal(Object.keys(doc.budget.openReservations).length, 0, 'no leaked open reservation');
    assert.equal(doc.budget.stopped, null, 'the run was never budget-stopped');

    // Commit reachability + a single fast-forward publication to the integration tip.
    const integ = integratedTaskIds(fx.root, fx.integrationRef);
    for (const id of fx.allIds) assert.ok(integ.has(id), `${id} commit reachable from the integration branch`);
    const tip = refSha(fx.root, fx.integrationRef);
    assert.equal(refSha(fx.root, 'refs/heads/main'), tip, 'the target fast-forwarded to the integration tip');
    assert.ok(isAncestor(fx.root, fx.base, tip), 'the publish was a fast-forward from the approved base');
    assert.equal(spies.publishCount, 1, 'published exactly once');
  } finally { fx.cleanup(); }
});
