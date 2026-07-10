// build-engine.mjs — the deterministic DAG BUILD DRIVER for the Codex-native pipeline coordinator.
//
// This is the phase runner that turns an APPROVED, topologically-layered plan into integrated commits. It
// composes the Layer-0/1 foundation (it NEVER reimplements worktrees, integration, budget, review, or the
// checkpoint store) and enforces the autonomy contract that separates "autonomous" from "runaway":
//
//   1. CONCURRENCY ONLY IN DISTINCT WORKTREES. Within a topological layer the independent tasks run
//      CONCURRENTLY, but each executes in its OWN detached task worktree (git-workspaces.createTaskWorktree,
//      one per task id → structurally distinct). No two concurrent tasks ever share a working tree.
//   2. LAYER BARRIER. A layer's tasks are awaited to completion (Promise.all) and every required integration
//      must land before the NEXT layer starts. A blocked task or a stale-done inconsistency stops the driver
//      at that layer — it never races ahead of an unmet dependency.
//   3. THE AGENT NEVER GRADES ITS OWN HOMEWORK. The engineer's self-reported `built:true` is advisory only.
//      A task integrates ONLY when the COORDINATOR independently confirms: the worktree actually changed
//      in-scope files (git-workspaces.verifyScope — empty or out-of-scope ⇒ blocked), the review panel
//      cleared it BEFORE integration (missing/blocked review ⇒ blocked), and git-integration.integrateTask
//      succeeded (its OWN independent slice-validate is red ⇒ blocked). Any of these overrides `built:true`.
//   4. BUDGET-RESERVED, DURABLE, RESUMABLE. Every executor spawn reserves from the immutable budget ledger
//      first; every transition is recorded in the locked checkpoint store. On resume the driver SKIPS only
//      tasks whose integration commit is REACHABLE from the integration branch, RECONCILES a missing
//      checkpoint write from the commit's Task-Id trailer, and treats a stale `done` record (marked done but
//      with no reachable commit) as a durable BLOCKER — a `done` claim with no commit is never trusted.
//
// The integration critical section (materialize the task's in-scope changes into the integration worktree,
// then integrate) is serialized by an in-process mutex so the shared integration worktree is always clean at
// HEAD when a task integrates; a FAILED integration is rolled back byte-for-byte (pure fs restore) so it can
// never pollute the next task. git-integration's own cross-process file lock still applies underneath.
//
// Zero external deps (node: builtins only). Node 22+.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

import {
  createTaskWorktree, verifyScope, cleanupWorktree,
} from './git-workspaces.mjs';
import { integrateTask, parseTrailers } from './git-integration.mjs';
import { reserve, settle } from './budget-ledger.mjs';
import { runReviewPanel } from './review-panel.mjs';
import { EXIT } from './cli-contract.mjs';
import {
  unit, phase, item, readDoc,
} from '../../../checkpoint-resume/scripts/lib/checkpoint-store.mjs';

// ── typed error ─────────────────────────────────────────────────────────────────────────────────────
export class BuildEngineError extends Error {
  constructor(message, code = EXIT.USAGE) { super(message); this.name = 'BuildEngineError'; this.code = code; }
}
const fail = (m, code = EXIT.USAGE) => { throw new BuildEngineError(m, code); };

// ── read-only git reader (the coordinator reading its OWN integration branch) ─────────────────────────
// git-workspaces / git-integration are deliberately narrow choke points; walking the integration history
// for resume is a distinct, purely READ-ONLY concern, so this reader has its own tiny allowlist. It never
// stages, commits, or moves a ref — those remain git-integration's sole province.
const READ_ONLY_SUBCOMMANDS = Object.freeze(new Set(['rev-parse', 'rev-list', 'log', 'show', 'cat-file', 'merge-base']));

function gitRead(cwd, args) {
  if (!Array.isArray(args) || args.length === 0) throw new Error('gitRead: no subcommand');
  if (!READ_ONLY_SUBCOMMANDS.has(args[0])) throw new Error(`gitRead: subcommand not read-only: ${args[0]}`);
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

// Map every task id whose trailered commit is REACHABLE from the integration ref → that commit's sha. This
// is the authoritative "already integrated" set: only commits reachable from the integration branch count.
// A ref that does not resolve (fresh run, integration branch not yet created) yields an EMPTY map.
export function integratedTaskIds(repoDir, integrationRef) {
  const out = new Map();
  let raw;
  // %H<US>%B<RS> — hash, unit-separator, full body, record-separator — so bodies with blank lines stay intact.
  try { raw = gitRead(repoDir, ['log', '--format=%H%x1f%B%x1e', integrationRef, '--']); }
  catch { return out; }
  for (const rec of raw.split('\x1e')) {
    const s = rec.replace(/^\s+/, '');
    if (!s) continue;
    const usi = s.indexOf('\x1f');
    if (usi < 0) continue;
    const sha = s.slice(0, usi).trim();
    const body = s.slice(usi + 1);
    const t = parseTrailers(body);
    const id = t['Task-Id'];
    // The nearest (newest) commit for a task id wins; log walks newest→oldest so only set once.
    if (id && !out.has(id)) out.set(id, sha);
  }
  return out;
}

// ── resume reconciliation ─────────────────────────────────────────────────────────────────────────────
/**
 * Reconcile the durable checkpoint against the integration branch before (re)running a build:
 *   • REACHABLE + checkpoint-done  → already integrated; skipped.
 *   • REACHABLE + checkpoint-not-done → RECONCILE the missing write: mark the unit done from the commit's
 *     Task-Id trailer (a lost checkpoint write must never cause a re-integration of committed work).
 *   • NOT reachable + checkpoint-done → STALE done: a `done` record with no reachable commit is NOT trusted.
 *     The store forbids demoting a done unit, so we record a durable blocking open item (which blocks
 *     convergence/finalize) and report it as blocked — never silently skip it as complete.
 *   • NOT reachable + not done → runnable.
 * @returns {{integrated:string[], reconciled:string[], staleDone:string[], runnable:string[]}}
 */
export function reconcileResume({ repoDir, integrationRef, checkpointFile, taskIds }) {
  if (!Array.isArray(taskIds)) fail('reconcileResume requires a taskIds array');
  const integrated = integratedTaskIds(repoDir, integrationRef);
  let doc;
  try { doc = readDoc(checkpointFile); } catch { doc = { units: {} }; }
  const units = doc.units || {};
  const reconciled = [];
  const staleDone = [];
  const runnable = [];
  for (const id of taskIds) {
    const st = units[id] && units[id].status;
    if (integrated.has(id)) {
      if (st !== 'done') {
        unit(checkpointFile, id, 'done', { note: `reconciled-from-trailer:${integrated.get(id)}` });
        reconciled.push(id);
      }
      continue;
    }
    if (st === 'done') {
      staleDone.push(id);
      item(checkpointFile, {
        id: `stale-done:${id}`, kind: 'stale-done', severity: 'blocker',
        issue: `unit ${id} is marked done but no commit is reachable from ${integrationRef} — stale/lost integration; not trusted`,
      });
      continue;
    }
    runnable.push(id);
  }
  return { integrated: [...integrated.keys()], reconciled, staleDone, runnable };
}

// ── in-process serialization mutex for the integration critical section ───────────────────────────────
// Executors (the expensive per-task work) run concurrently; the copy-into-integration-worktree + integrate
// section must be serialized so the shared integration worktree is clean at HEAD for each task. A rejected
// section never wedges the chain (the tail swallows so the next section still runs).
function createMutex() {
  let tail = Promise.resolve();
  return function run(fn) {
    const result = tail.then(() => fn());
    tail = result.then(() => {}, () => {});
    return result;
  };
}

// ── materialize a task's in-scope changes into the integration worktree (with rollback) ───────────────
// Copy exactly the coordinator-verified in-scope changed paths from the task worktree into the integration
// worktree (replicating a deletion as a deletion), returning a `restore()` that reverts every touched path
// to its prior state — so a FAILED integration leaves the integration worktree byte-for-byte at HEAD.
function materializeChanges(srcWt, destWt, changed) {
  const snapshots = [];
  for (const rel of changed) {
    const srcAbs = join(srcWt, rel);
    const destAbs = join(destWt, rel);
    const prior = existsSync(destAbs) ? readFileSync(destAbs) : null; // Buffer or null (absent)
    snapshots.push({ destAbs, prior });
    if (existsSync(srcAbs)) {
      mkdirSync(dirname(destAbs), { recursive: true });
      writeFileSync(destAbs, readFileSync(srcAbs));
    } else if (prior !== null) {
      rmSync(destAbs, { force: true }); // an in-scope deletion is replicated
    }
  }
  return function restore() {
    for (const s of snapshots) {
      if (s.prior === null) { if (existsSync(s.destAbs)) rmSync(s.destAbs, { force: true }); }
      else { mkdirSync(dirname(s.destAbs), { recursive: true }); writeFileSync(s.destAbs, s.prior); }
    }
  };
}

// ── options normalization ─────────────────────────────────────────────────────────────────────────────
// The default reviewer runs the REAL review panel (per-task options supplied by the caller). Tests inject
// their own `review` fn. With NEITHER a `review` fn NOR a `reviewOptionsFor` factory the driver is
// fail-closed: every task is BLOCKED for missing review evidence (a change never integrates unreviewed).
function reviewViaPanel(reviewOptionsFor) {
  return async (ctxArg) => {
    const opts = reviewOptionsFor(ctxArg);
    const result = await runReviewPanel(opts);
    return { canAdvance: result.canAdvanceShipPrep === true, result };
  };
}

function normalize(opts) {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) fail('runBuild requires an options object');
  const req = (k) => { if (opts[k] === undefined || opts[k] === null) fail(`runBuild requires '${k}'`); return opts[k]; };
  const plan = req('plan');
  if (!plan || !Array.isArray(plan.layers) || typeof plan.tasks !== 'object' || plan.tasks === null) {
    fail('plan must be { layers: string[][], tasks: { <id>: { writeScope, paths?, subject? } } }');
  }
  if (typeof req('executor') !== 'function') fail('executor must be a function');
  if (typeof req('validateFor') !== 'function') fail('validateFor must be a function taskId -> { command, args }');
  const review = typeof opts.review === 'function'
    ? opts.review
    : (typeof opts.reviewOptionsFor === 'function' ? reviewViaPanel(opts.reviewOptionsFor) : null);
  return {
    root: req('root'),
    integrationDir: req('integrationDir'),
    integrationRef: req('integrationRef'),
    targetRef: opts.targetRef,
    worktreesDir: req('worktreesDir'),
    baseSha: req('baseSha'),
    checkpointFile: req('checkpointFile'),
    runId: req('runId'),
    planId: req('planId'),
    plan,
    executor: opts.executor,
    validateFor: opts.validateFor,
    review,
    quarantineDir: opts.quarantineDir,
    lockPath: opts.lockPath,
    lockOptions: opts.lockOptions || { waitMs: 8000, staleMs: 5000 },
    callTimeoutMs: Number.isInteger(opts.callTimeoutMs) && opts.callTimeoutMs > 0 ? opts.callTimeoutMs : 60_000,
    clock: typeof opts.clock === 'function' ? opts.clock : Date.now,
    integrateMutex: createMutex(),
  };
}

// ── run ONE task end-to-end (executor → verify → review → integrate → record) ─────────────────────────
export async function runTask(ctx, taskId) {
  const spec = ctx.plan.tasks[taskId] || {};
  const writeScope = Array.isArray(spec.writeScope) ? spec.writeScope : [];

  unit(ctx.checkpointFile, taskId, 'in_progress');

  let wt;
  try {
    wt = createTaskWorktree({
      root: ctx.root, taskId, baseSha: ctx.baseSha,
      worktreesDir: ctx.worktreesDir, quarantineDir: ctx.quarantineDir,
    });
  } catch (e) {
    unit(ctx.checkpointFile, taskId, 'blocked', { note: `worktree-failed: ${e.message}` });
    return { taskId, ok: false, reason: 'worktree-failed', evidence: { error: e.message } };
  }

  const blockTask = (reason, evidence, claimedBuilt) => {
    unit(ctx.checkpointFile, taskId, 'blocked', { note: reason });
    return { taskId, ok: false, reason, evidence, claimedBuilt, worktree: wt.path };
  };

  try {
    // BUDGET: reserve one spawn BEFORE running the executor — never oversubscribe the immutable set.
    const r = reserve(ctx.checkpointFile, { task: taskId, phase: 'build', callTimeoutMs: ctx.callTimeoutMs });
    if (!r.granted) return blockTask('budget', { reasons: r.reasons || (r.stopped ? ['budget-stopped'] : []) });

    // EXECUTE the engineer under Codex in the task's OWN worktree. `built` is advisory — verified below.
    let exec; let execErr;
    const t0 = ctx.clock();
    try { exec = await ctx.executor({ taskId, spec, worktree: wt.path, baseSha: wt.baseSha }); }
    catch (e) { execErr = e; }
    finally { settle(ctx.checkpointFile, r.reservationId, { actualWallMs: Math.max(0, ctx.clock() - t0) }); }
    if (execErr) return blockTask('executor-threw', { error: String((execErr && execErr.message) || execErr) });
    const claimedBuilt = !!(exec && exec.built);

    // INDEPENDENT scope verification on the task worktree — the agent's `built:true` NEVER substitutes for
    // the coordinator actually observing the changes. Empty or out-of-scope ⇒ blocked (built:true overridden).
    const scope = verifyScope({ worktreePath: wt.path, baseSha: wt.baseSha, writeScope });
    if (!scope.changed || scope.changed.length === 0) return blockTask('empty-changeset', { baseSha: wt.baseSha }, claimedBuilt);
    if (!scope.ok) return blockTask('out-of-scope', { violations: scope.violations }, claimedBuilt);

    // REVIEW BEFORE INTEGRATION — fail-closed. No reviewer, a review error, or a blocked panel all refuse.
    if (!ctx.review) return blockTask('missing-review', { detail: 'no reviewer configured (fail-closed)' }, claimedBuilt);
    let review;
    try { review = await ctx.review({ taskId, spec, worktree: wt.path, changed: scope.changed, checkpointFile: ctx.checkpointFile }); }
    catch (e) { return blockTask('review-error', { error: String((e && e.message) || e) }, claimedBuilt); }
    if (!review || review.canAdvance !== true) return blockTask('review-blocked', { review: review || null }, claimedBuilt);

    // INTEGRATE inside the in-process mutex: copy in-scope changes into the integration worktree, then
    // integrate (git-integration re-runs the slice validate INDEPENDENTLY, re-verifies scope, stages the
    // explicit paths, and commits with trailers). A failed integration is rolled back so the shared
    // integration worktree stays clean at HEAD for the next task.
    const integ = await ctx.integrateMutex(async () => {
      const restore = materializeChanges(wt.path, ctx.integrationDir, scope.changed);
      const res = integrateTask({
        repoDir: ctx.integrationDir,
        validate: ctx.validateFor(taskId),
        writeScope,
        paths: spec.paths,
        subject: spec.subject || `integrate ${taskId}`,
        runId: ctx.runId, taskId, planId: ctx.planId,
        lockPath: ctx.lockPath, lockOptions: ctx.lockOptions,
      });
      if (!res.ok) restore();
      return res;
    });
    if (!integ.ok) {
      return blockTask('integration-failed', { reason: integ.reason, evidence: integ.evidence, code: integ.code }, claimedBuilt);
    }

    unit(ctx.checkpointFile, taskId, 'done', { note: `integrated:${integ.sha}` });
    return { taskId, ok: true, sha: integ.sha, staged: integ.staged, claimedBuilt, worktree: wt.path };
  } finally {
    try { cleanupWorktree({ root: ctx.root, worktreePath: wt.path, quarantineDir: ctx.quarantineDir }); }
    catch { /* best-effort cleanup */ }
  }
}

// ── drive the whole approved DAG, layer by layer, with resume ─────────────────────────────────────────
/**
 * Execute the approved topological layers. Within each layer the pending tasks run CONCURRENTLY (each in its
 * own distinct worktree); the layer is a BARRIER (all awaited, all required integrations must land) before
 * the next layer starts. Resume skips already-integrated tasks, reconciles missing writes from trailers, and
 * stops on a stale-done inconsistency. Returns a typed, honest summary — never a fabricated green.
 */
export async function runBuild(opts) {
  const ctx = normalize(opts);
  phase(ctx.checkpointFile, 'build', 'running');

  const allTaskIds = ctx.plan.layers.flat();
  const rec = reconcileResume({
    repoDir: ctx.integrationDir, integrationRef: ctx.integrationRef,
    checkpointFile: ctx.checkpointFile, taskIds: allTaskIds,
  });
  const done = new Set([...rec.integrated, ...rec.reconciled]);
  const stale = new Set(rec.staleDone);

  const layers = [];
  const blocked = [];
  let converged = true;
  let stoppedAtLayer = null;

  for (let li = 0; li < ctx.plan.layers.length; li++) {
    const layer = ctx.plan.layers[li];
    const staleInLayer = layer.filter((id) => stale.has(id));
    const pending = layer.filter((id) => !done.has(id) && !stale.has(id));

    // CONCURRENT within the layer, DISTINCT worktrees; the Promise.all is the layer BARRIER.
    const results = await Promise.all(pending.map((id) => runTask(ctx, id)));
    for (const r of results) { if (r.ok) done.add(r.taskId); else blocked.push(r); }
    layers.push({ index: li, layer, results, staleInLayer });

    // A stale-done inconsistency or ANY blocked required task stops the driver here — the next layer's
    // dependencies are not all satisfied, so we never race ahead (fail-closed barrier).
    if (staleInLayer.length > 0 || results.some((r) => !r.ok)) {
      converged = false;
      stoppedAtLayer = li;
      break;
    }
  }

  const status = converged && blocked.length === 0 && stale.size === 0 ? 'ok' : 'blocked';
  phase(ctx.checkpointFile, 'build', status === 'ok' ? 'done' : 'blocked');

  return {
    status,
    converged: status === 'ok',
    exitCode: status === 'ok' ? EXIT.SUCCESS : EXIT.BLOCKED,
    stoppedAtLayer,
    integrated: [...done],
    blocked,
    staleDone: rec.staleDone,
    reconcile: rec,
    layers,
  };
}
