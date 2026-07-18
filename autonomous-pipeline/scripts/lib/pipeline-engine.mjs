// pipeline-engine.mjs — the ENGINE behind the public pipeline CLI for the Codex-native coordinator.
//
// This is the composition layer. It NEVER re-implements worktrees, integration, budget, review, the
// checkpoint store, the capability controller, or the convergence conjunction — it ORCHESTRATES them into
// the five public verbs (approve / start / resume / status / authorize) and enforces the ordering that
// separates "autonomous" from "runaway":
//
//   approve   — refuse a plan whose base is not approval-ready; init the durable run + immutable budget;
//               enter the PREPARED window; mint the ONE-USE, hash-bound plan-approval capability. A human
//               sits between mint (approve) and consume (start); the coordinator can never auto-chain.
//   start     — run EVERY preflight refusal (plan/base/config drift, wrong target, dirty tree, checkpoint
//               mismatch) and CONSUME the one-use plan approval BEFORE a single Codex executor is spawned;
//               then drive build → post-build phases; publish ONLY as a fast-forward after the explicit
//               convergence conjunction AND a durable finalize `done`. Child executors get NO capability
//               material. A replayed approval (double-start) is refused.
//   resume    — continue from durable state: reconcile crashed budget segments (never erase spend / no-
//               progress counters), skip already-integrated units, and NEVER treat a budget stop or an
//               agent's self-assertion as completion. Refuses a run that never consumed its approval, and
//               never re-consumes/re-mints one.
//   status    — read-only durable snapshot.
//   authorize — at a converged, quiesced boundary, durably HALT for the irreversible action and mint a
//               FRESH, action-scoped capability. A plan approval can never satisfy an action.
//
// Every EXPECTED refusal is a typed PipelineEngineError carrying a pinned EXIT code (cli-contract.mjs);
// only a truly unexpected fault throws raw. A checkpoint or budget write failure STOPS the run (its
// CheckpointError/BudgetError propagates with EXIT.CHECKPOINT/EXIT.BUDGET) rather than pressing on.
//
// Testability: every heavyweight side effect (base resolution, dirty-tree probe, workspace setup, the
// build driver, the phase engine, publication) is an injectable seam that DEFAULTS to the real Layer-0/1
// module. Tests drive the full contract with fakes — no real Codex, git remote, or network.
//
// Zero external deps (node: builtins only). Node 22+.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

import { EXIT, parseCanonicalPlan } from './cli-contract.mjs';
import {
  markPrepared, issuePlanApproval, consumePlanApproval,
  haltForAuthorization, issueActionCapability,
  contentSha, assertCapabilityDirIsolated, reconcileCapability,
  AuthorizationError,
} from './authorization.mjs';
import { convergenceFailures, PHASES } from './pipeline-state.mjs';
import { runBuild } from './build-engine.mjs';
import { runPhaseEngine, CLOSEOUT_PHASES } from './phase-engine.mjs';
import { publishToTarget } from './git-integration.mjs';
import { resolveBaseSha, createIntegrationWorktree } from './git-workspaces.mjs';
import { initBudget, reconcileOpenSegments, stopStatus } from './budget-ledger.mjs';
import {
  init as ckInit, readDoc, writeDoc, upgradeDoc, withLock, finalize as ckFinalize,
} from '../../../checkpoint-resume/scripts/lib/checkpoint-store.mjs';

// ── pinned engine identity ──────────────────────────────────────────────────────────────────────────
// Bound into every capability's `engineVersion`. A capability minted by one engine version is refused by
// another (the digest changes) — resume/authorize can never cross an engine boundary silently.
export const ENGINE_VERSION = '1.0.0';

// The checkpoint's required-phase gate (finalize `done` refuses until each is 'done'). These mirror the
// non-optional phases of pipeline-state.PHASES (build + test + review). Optional phases may be skipped.
export const REQUIRED_PHASES = Object.freeze(PHASES.filter((p) => !p.optional).map((p) => p.name));

// ── typed error ───────────────────────────────────────────────────────────────────────────────────────
export class PipelineEngineError extends Error {
  constructor(reason, message, code = EXIT.PREFLIGHT) {
    super(message || reason);
    this.name = 'PipelineEngineError';
    this.reason = reason;   // stable machine-readable slug
    this.code = code;       // pinned EXIT code
  }
}
const refuse = (reason, message, code = EXIT.PREFLIGHT) => { throw new PipelineEngineError(reason, message, code); };

// ── small helpers ───────────────────────────────────────────────────────────────────────────────────
function assertAbs(p, label) {
  if (typeof p !== 'string' || !isAbsolute(p)) refuse('bad-config', `${label} must be an absolute path (got ${JSON.stringify(p)})`, EXIT.USAGE);
  if (p.split('/').includes('..')) refuse('bad-config', `${label} must not contain a '..' segment`, EXIT.USAGE);
  return p;
}
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function readFileOr(path, label) {
  if (typeof path !== 'string' || path.length === 0) refuse('checkpoint-io', `${label} path is not recorded on this run`, EXIT.CHECKPOINT);
  if (!existsSync(path)) refuse('drift', `${label} file is gone since approval (${path}) — refusing to run against a missing ${label}`, EXIT.PREFLIGHT);
  try { return readFileSync(path, 'utf8'); }
  catch (e) { refuse('checkpoint-io', `cannot read ${label} at ${path}: ${e.message}`, EXIT.CHECKPOINT); }
}

// The default dirty-tree probe: a clean working tree at the coordinator root is a precondition for a run.
// Injectable so tests need no real repo. Returns the array of porcelain lines (empty ⇒ clean).
export function defaultGitStatus(root) {
  const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').map((l) => l.trimEnd()).filter(Boolean);
}

const integrationRefFor = (run) => `refs/heads/ulpi-int-${run}`;

// ── binding selected-scope coverage ───────────────────────────────────────────────────────────────────
// Intake selection is the scope authority. This check is intentionally repeated at approval (rather than
// trusting auto-plan's validator): it runs before checkpoint/capability mutation and is bound into the
// approved plan hash. A general plan approval is never interpreted as acknowledgement of a proposed drop.
export function selectedScopeCoverage(plan) {
  const errors = [];
  const selected = Array.isArray(plan?.selectedScope) ? plan.selectedScope : [];
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const drops = Array.isArray(plan?.scopeDrops) ? plan.scopeDrops : [];
  const SAFE_SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  const scopeById = new Map();
  const mapped = new Map();
  const dropped = new Map();

  if (selected.length === 0) errors.push({ code: 'scope-missing', detail: 'selectedScope[] is absent or empty' });
  if (plan?.scopeDrops !== undefined && !Array.isArray(plan.scopeDrops)) errors.push({ code: 'scope-invalid', detail: 'scopeDrops must be an array' });
  for (const item of selected) {
    const id = item?.id;
    if (typeof id !== 'string' || !SAFE_SCOPE_ID.test(id)) { errors.push({ code: 'scope-invalid', detail: 'selectedScope item has an invalid id' }); continue; }
    if (scopeById.has(id)) errors.push({ code: 'scope-invalid', scopeId: id, detail: 'duplicate selectedScope id' });
    else scopeById.set(id, item);
    if (typeof item?.title !== 'string' || item.title.trim() === '' || typeof item?.source !== 'string' || item.source.trim() === '') {
      errors.push({ code: 'scope-invalid', scopeId: id, detail: 'selectedScope item needs nonempty title and source' });
    }
  }
  for (const task of tasks) {
    if (!Array.isArray(task?.scopeItems)) {
      errors.push({ code: 'scope-invalid', detail: `task ${task?.id || '(unknown)'} is missing scopeItems[]` });
      continue;
    }
    for (const raw of task?.scopeItems || []) {
      const id = String(raw);
      if (!scopeById.has(id)) errors.push({ code: 'scope-invalid', scopeId: id, detail: `task ${task?.id || '(unknown)'} maps an unknown selectedScope id` });
      const owners = mapped.get(id) || [];
      if (owners.includes(task?.id)) errors.push({ code: 'scope-invalid', scopeId: id, detail: `task ${task?.id || '(unknown)'} repeats a selectedScope id` });
      else owners.push(task?.id);
      mapped.set(id, owners);
    }
  }
  for (const drop of drops) {
    const id = drop?.scopeId;
    if (typeof id !== 'string' || !scopeById.has(id)) { errors.push({ code: 'scope-invalid', scopeId: id, detail: 'scopeDrops references an unknown selectedScope id' }); continue; }
    if (dropped.has(id)) { errors.push({ code: 'scope-invalid', scopeId: id, detail: 'duplicate scopeDrops entry' }); continue; }
    const valid = typeof drop?.reason === 'string' && drop.reason.trim() !== ''
      && drop?.acknowledgedByUser === true
      && typeof drop?.acknowledgement === 'string' && drop.acknowledgement.trim() !== '';
    if (!valid) errors.push({ code: 'scope-drop-unacknowledged', scopeId: id, detail: 'drop lacks distinct per-id user acknowledgement evidence' });
    else dropped.set(id, drop);
  }

  const result = { total: scopeById.size, covered: [], dropped: [], uncovered: [], errors };
  for (const id of scopeById.keys()) {
    const isMapped = (mapped.get(id) || []).length > 0;
    const isDropped = dropped.has(id);
    if (isMapped && isDropped) errors.push({ code: 'scope-invalid', scopeId: id, detail: 'selectedScope id is both mapped and dropped' });
    if (isMapped) result.covered.push(id);
    else if (isDropped) result.dropped.push(id);
    else result.uncovered.push(id);
  }
  return result;
}

// ── run-config normalization ──────────────────────────────────────────────────────────────────────────
/**
 * Validate + normalize the run-config JSON the operator hands `approve`. It carries the durable placement
 * (state/cap/worktree dirs), the publication target, the immutable budget, and optional phase skips. Every
 * path is asserted absolute + traversal-free; unknown shape is refused (EXIT.USAGE).
 */
export function parseRunConfigObject(input) {
  const cfg = typeof input === 'string' ? safeJson(input, 'run config') : input;
  if (!isPlainObject(cfg)) refuse('bad-config', 'run config must be a JSON object', EXIT.USAGE);
  const run = cfg.run;
  const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  if (typeof run !== 'string' || !SAFE_ID.test(run) || run.includes('..')) refuse('bad-config', `run config .run is not a safe id: ${JSON.stringify(run)}`, EXIT.USAGE);
  assertAbs(cfg.root, 'config.root');
  assertAbs(cfg.stateDir, 'config.stateDir');
  assertAbs(cfg.capDir, 'config.capDir');
  assertAbs(cfg.worktreesDir, 'config.worktreesDir');
  const targetRef = cfg.targetRef;
  if (typeof targetRef !== 'string' || !/^refs\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(targetRef) || targetRef.includes('..')) {
    refuse('bad-config', `config.targetRef must be a fully-qualified ref: ${JSON.stringify(targetRef)}`, EXIT.USAGE);
  }
  if (typeof cfg.base !== 'string' || cfg.base.length === 0 || cfg.base.startsWith('-')) refuse('bad-config', 'config.base must be a non-empty, non-flag ref/sha', EXIT.USAGE);
  if (!isPlainObject(cfg.budget)) refuse('bad-config', 'config.budget must be a JSON object (the immutable termination set)', EXIT.USAGE);
  const skip = Array.isArray(cfg.skip) ? cfg.skip.map(String) : [];
  const integrationRef = cfg.integrationRef || integrationRefFor(run);
  return {
    run, root: cfg.root, stateDir: cfg.stateDir, capDir: cfg.capDir, worktreesDir: cfg.worktreesDir,
    targetRef, integrationRef, base: cfg.base, budget: cfg.budget, skip,
    approvalTtlMs: Number.isInteger(cfg.approvalTtlMs) && cfg.approvalTtlMs > 0 ? cfg.approvalTtlMs : 15 * 60 * 1000,
    authorizeTtlMs: Number.isInteger(cfg.authorizeTtlMs) && cfg.authorizeTtlMs > 0 ? cfg.authorizeTtlMs : 5 * 60 * 1000,
    callTimeoutMs: Number.isInteger(cfg.callTimeoutMs) && cfg.callTimeoutMs > 0 ? cfg.callTimeoutMs : 60_000,
  };
}
function safeJson(text, label) { try { return JSON.parse(text); } catch (e) { refuse('bad-config', `${label} is not valid JSON: ${e.message}`, EXIT.USAGE); } }

// Coordinator-private run metadata, stamped into the checkpoint at approve. It records the exact resume
// recipe (paths, hashes, refs, the approval nonce) so start/resume can detect drift and re-present the
// approval WITHOUT any external state. This lives in the same trust boundary as the checkpoint itself.
function stampMeta(checkpointFile, patch) {
  return withLock(checkpointFile, () => {
    const doc = upgradeDoc(readDoc(checkpointFile));
    doc.pipeline = { ...(doc.pipeline || {}), ...patch };
    writeDoc(checkpointFile, doc);
    return doc.pipeline;
  });
}
function stampStatus(checkpointFile, status) {
  return withLock(checkpointFile, () => {
    const doc = upgradeDoc(readDoc(checkpointFile));
    doc.status = status;
    writeDoc(checkpointFile, doc);
    return status;
  });
}

// ── the convergence conjunction over the durable checkpoint ─────────────────────────────────────────────
// Reconcile the coordinator's OWN durable state against pipeline-state's conjunction — the single gate that
// authorizes finalize `done` + publication. Never trusts an engine's returned summary alone.
export function checkpointConvergence(doc) {
  const units = {};
  for (const [id, u] of Object.entries(doc.units || {})) units[id] = { status: u.status };
  const phases = {};
  for (const [name, p] of Object.entries(doc.phases || {})) phases[name] = p && p.status;
  const finalValidation = doc.finalValidation
    ? { passed: doc.finalValidation.status === 'green' }
    : null;
  return convergenceFailures({
    units, phases, phaseDefs: PHASES,
    openItems: Array.isArray(doc.openItems) ? doc.openItems : [],
    scopeCoverage: doc.pipeline?.scopeCoverage || null,
    requireScopeCoverage: !!doc.pipeline,
    finalValidation,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// approve
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
/**
 * Approve a plan+config: refuse a non-approval-ready base, initialize the durable run + immutable budget,
 * enter PREPARED, and mint the one-use, hash-bound plan-approval capability.
 * @param {object} opts { rawPlan, rawConfig, planPath, configPath, checkpointFile?, interactive, context,
 *   resolveBase?, now? }
 */
export function approve(opts) {
  if (!isPlainObject(opts)) refuse('bad-config', 'approve requires an options object', EXIT.USAGE);
  const rawPlan = req(opts, 'rawPlan');
  const rawConfig = req(opts, 'rawConfig');
  const plan = parseCanonicalPlan(rawPlan);       // structural plan-validate (tasks[] + layers[])
  const config = parseRunConfigObject(rawConfig);
  const now = opts.now ?? Date.now();
  const resolveBase = opts.resolveBase || resolveBaseSha;

  // 1. APPROVAL-READINESS GATE. A plan whose base is not marked ready is refused — before any state.
  const base = isPlainObject(plan.base) ? plan.base : {};
  if (base.approvalReady !== true) {
    refuse('approval-not-ready', 'plan.base.approvalReady is not true — the plan is not cleared for autonomous execution', EXIT.PREFLIGHT);
  }

  // 1b. SCOPE-COVERAGE GATE. Recompute from the approved plan bytes before ANY durable state/capability
  // mutation. Proposed drops without their own user acknowledgement remain uncovered; plan approval alone
  // never clears them.
  const scopeCoverage = selectedScopeCoverage(plan);
  if (scopeCoverage.errors.length > 0) {
    const first = scopeCoverage.errors[0];
    refuse(first.code, `scope coverage invalid: ${first.detail}`, EXIT.PREFLIGHT);
  }
  if (scopeCoverage.uncovered.length > 0) {
    refuse('scope-uncovered', `SCOPE COVERAGE: ${scopeCoverage.covered.length} of ${scopeCoverage.total} selected-scope items covered; UNCOVERED: ${scopeCoverage.uncovered.join(', ')}`, EXIT.PREFLIGHT);
  }

  const { run, capDir, worktreesDir, targetRef, integrationRef } = config;
  assertCapabilityDirIsolated(capDir, [worktreesDir]); // children must never receive issuance state

  const checkpointFile = opts.checkpointFile || join(config.stateDir, `${run}.json`);
  const baseSha = resolveBase(config.root, config.base);
  if (typeof baseSha !== 'string' || baseSha.length < 7) refuse('drift', `could not resolve config.base '${config.base}' to a commit`, EXIT.PREFLIGHT);

  // 2. DURABLE INIT — units are the plan task ids; required phases gate finalize; validation required.
  const taskIds = plan.layers.flat();
  ckInit(checkpointFile, {
    task: `pipeline:${run}`, id: run, units: taskIds,
    requiredPhases: [...REQUIRED_PHASES], requireValidation: true,
    launch: { scriptPath: 'autonomous-pipeline/scripts/pipeline.mjs', args: { command: 'resume', run } },
  });
  initBudget(checkpointFile, config.budget); // immutable termination set — a later re-bind is refused

  const planSha = contentSha(rawPlan);
  const configSha = contentSha(rawConfig);
  stampMeta(checkpointFile, {
    run, root: config.root, planPath: opts.planPath ?? null, configPath: opts.configPath ?? null,
    planSha, configSha, base: config.base, approvedBaseSha: baseSha, targetRef, integrationRef,
    worktreesDir, capDir, skip: config.skip, engineVersion: ENGINE_VERSION,
    scopeCoverage,
    approvalTtlMs: config.approvalTtlMs, authorizeTtlMs: config.authorizeTtlMs, callTimeoutMs: config.callTimeoutMs,
  });

  // 3. ENTER PREPARED, then MINT the one-use plan approval (interactive-operator-only, coordinator-only).
  markPrepared(checkpointFile);
  const cap = issuePlanApproval({
    capDir, run, rawPlan, config: rawConfig, baseSha, targetRef, engineVersion: ENGINE_VERSION,
    ttlMs: config.approvalTtlMs, interactive: opts.interactive, context: opts.context,
    checkpointFile, worktreePaths: [worktreesDir], now,
  });
  // Persist the approval nonce so `start` can re-present the exact bindings (coordinator-private).
  stampMeta(checkpointFile, { approvalNonce: cap.nonce });

  return {
    command: 'approve', ok: true, run, status: 'prepared',
    planSha, configSha, baseSha, targetRef,
    scopeCoverage,
    capability: { kind: 'plan', expiresAt: cap.expiresAt },
    exitCode: EXIT.SUCCESS,
  };
}

// ── load the durable run context for start/resume/authorize/status ─────────────────────────────────────
function loadRunCtx(opts, { reReadPayload = true } = {}) {
  const checkpointFile = req(opts, 'checkpointFile');
  if (!existsSync(checkpointFile)) refuse('checkpoint-missing', `no run checkpoint at ${checkpointFile}`, EXIT.CHECKPOINT);
  let doc;
  try { doc = readDoc(checkpointFile); }
  catch (e) { refuse('checkpoint-io', `cannot read checkpoint ${checkpointFile}: ${e.message}`, EXIT.CHECKPOINT); }
  const meta = doc.pipeline;
  if (!isPlainObject(meta)) refuse('checkpoint-io', `checkpoint ${checkpointFile} has no pipeline metadata (was it created by approve?)`, EXIT.CHECKPOINT);
  const run = doc.id;
  const ctx = {
    checkpointFile, doc, meta, run,
    root: opts.root ?? meta.root,
    capDir: opts.capDir ?? meta.capDir,
    worktreesDir: opts.worktreesDir ?? meta.worktreesDir,
    targetRef: opts.targetRef ?? meta.targetRef,
    integrationRef: opts.integrationRef ?? meta.integrationRef,
    approvedBaseSha: meta.approvedBaseSha,
    approvalNonce: meta.approvalNonce,
    planSha: meta.planSha,
    configSha: meta.configSha,
    skip: Array.isArray(meta.skip) ? meta.skip : [],
    approvalTtlMs: meta.approvalTtlMs, authorizeTtlMs: meta.authorizeTtlMs, callTimeoutMs: meta.callTimeoutMs || 60_000,
    now: opts.now ?? Date.now(),
    resolveBase: opts.resolveBase || resolveBaseSha,
    gitStatus: opts.gitStatus || defaultGitStatus,
  };
  if (reReadPayload) {
    ctx.rawPlan = opts.rawPlan ?? readFileOr(opts.planPath ?? meta.planPath, 'plan');
    ctx.rawConfig = opts.rawConfig ?? readFileOr(opts.configPath ?? meta.configPath, 'config');
  }
  return ctx;
}

const req = (o, k) => { if (o[k] === undefined || o[k] === null) refuse('bad-config', `missing required option '${k}'`, EXIT.USAGE); return o[k]; };

// ── preflight (defense-in-depth; the capability consume is the authoritative gate) ──────────────────────
// Every check here fires BEFORE any Codex executor is spawned. Independent of the capability, it re-derives
// the base/plan/config from live inputs and compares to what was approved, verifies the target and a clean
// tree, and confirms the run is in the expected checkpoint state.
export function preflight(ctx, { requireStatus }) {
  // checkpoint state gate
  if (requireStatus && ctx.doc.status !== requireStatus) {
    refuse('checkpoint-mismatch', `run is '${ctx.doc.status}', expected '${requireStatus}' — refusing to proceed`, EXIT.PREFLIGHT);
  }
  // base drift — the live base must still resolve to exactly what was approved
  let liveBase;
  try { liveBase = ctx.resolveBase(ctx.root, ctx.meta.base ?? ctx.approvedBaseSha); }
  catch (e) { refuse('drift', `cannot resolve base: ${e.message}`, EXIT.PREFLIGHT); }
  // (config.base is not persisted separately; approvedBaseSha is the anchor — re-resolve HEAD anchor)
  if (typeof ctx.approvedBaseSha === 'string' && liveBase !== ctx.approvedBaseSha) {
    refuse('base-drift', `base moved since approval (approved ${ctx.approvedBaseSha}, now ${liveBase})`, EXIT.PREFLIGHT);
  }
  // config drift — the live config bytes must hash to the approved config
  if (typeof ctx.rawConfig === 'string' && contentSha(ctx.rawConfig) !== ctx.configSha) {
    refuse('config-drift', 'run config changed since approval (config hash mismatch)', EXIT.PREFLIGHT);
  }
  // plan drift — the live plan bytes must hash to the approved plan
  if (typeof ctx.rawPlan === 'string' && contentSha(ctx.rawPlan) !== ctx.planSha) {
    refuse('plan-drift', 'plan changed since approval (plan hash mismatch)', EXIT.PREFLIGHT);
  }
  // target consistency — the live config's target must match the approved target
  const liveTarget = parseRunConfigObject(ctx.rawConfig).targetRef;
  if (liveTarget !== ctx.targetRef) {
    refuse('wrong-target', `publication target changed since approval (approved ${ctx.targetRef}, now ${liveTarget})`, EXIT.PREFLIGHT);
  }
  // dirty tree — the coordinator root must be clean before a run integrates
  let dirty;
  try { dirty = ctx.gitStatus(ctx.root); }
  catch (e) { refuse('dirty-preflight', `cannot probe working tree: ${e.message}`, EXIT.PREFLIGHT); }
  if (Array.isArray(dirty) && dirty.length > 0) {
    refuse('dirty-tree', `working tree at ${ctx.root} is dirty (${dirty.length} change(s)) — refusing to run`, EXIT.PREFLIGHT);
  }
  return { ok: true, baseSha: ctx.approvedBaseSha };
}

// ── build a child executor that carries NO capability material ──────────────────────────────────────────
// Every child receives ONLY worktree-safe fields. We assert the caller-provided executor is a function and
// wrap it so no capability/nonce/capDir can ever be threaded to a sandboxed child.
function childSafeExecutor(executor) {
  if (typeof executor !== 'function') refuse('bad-config', 'an `executor` function is required to spawn build tasks', EXIT.USAGE);
  return async ({ taskId, spec, worktree, baseSha }) => {
    // NOTE: only these four fields cross the boundary — never capDir/capability/nonce.
    return executor({ taskId, spec, worktree, baseSha });
  };
}

// ── the shared "drive to convergence or an honest block" core for start/resume ──────────────────────────
async function driveToConvergence(ctx, opts, phase) {
  const runBuildFn = opts.runBuildFn || runBuild;
  const runPhaseEngineFn = opts.runPhaseEngineFn || runPhaseEngine;
  const publishFn = opts.publishFn || publishToTarget;
  const prepareWorkspace = opts.prepareWorkspace || defaultPrepareWorkspace;

  const plan = parseCanonicalPlan(ctx.rawPlan);
  // The canonical plan carries tasks as an ARRAY (cli-contract schema); the build DAG driver keys tasks by
  // id. Adapt without mutating the approved plan (its hash is load-bearing for drift detection).
  const buildPlan = {
    planId: plan.planId || ctx.run,
    layers: plan.layers,
    tasks: Object.fromEntries((plan.tasks || []).filter((t) => t && typeof t.id === 'string').map((t) => [t.id, {
      writeScope: Array.isArray(t.writeScope) ? t.writeScope : [], paths: t.paths, subject: t.subject,
    }])),
  };
  const ws = await prepareWorkspace(ctx);            // integration worktree (real) or a fake in tests
  const integrationDir = ws.integrationDir;

  // BUILD — the DAG driver reserves budget, spawns capability-free children, integrates, and (on resume)
  // skips already-integrated units. Its returned `converged` is advisory; the durable checkpoint is truth.
  const build = await runBuildFn({
    plan: buildPlan, root: ctx.root, integrationDir, integrationRef: ctx.integrationRef, targetRef: ctx.targetRef,
    worktreesDir: ctx.worktreesDir, baseSha: ctx.approvedBaseSha, checkpointFile: ctx.checkpointFile,
    runId: ctx.run, planId: plan.planId || ctx.run,
    executor: childSafeExecutor(opts.executor), validateFor: opts.validateFor,
    review: opts.review, reviewOptionsFor: opts.reviewOptionsFor,
    callTimeoutMs: ctx.callTimeoutMs,
  });
  if (stopStatus(ctx.checkpointFile)) return budgetStop(ctx, phase);           // never treat a stop as done
  if (!build || build.converged !== true) {
    // auto-learn/map are run closeout, not success-only phases. A bumpy BUILD never enters the ordinary
    // post-build chain, so drive the closeout-only definitions explicitly. Terminal workspace validation
    // stays off: an incomplete build must not run/claim the end-state truth gate.
    let closeout = null;
    try {
      closeout = await runPhaseEngineFn({
        file: ctx.checkpointFile, worktree: integrationDir, phases: CLOSEOUT_PHASES,
        phaseFns: opts.phaseFns, validateFn: opts.validateFn, finalValidateFn: opts.finalValidateFn,
        terminalValidation: false, callTimeoutMs: ctx.callTimeoutMs,
      });
    } catch (e) {
      closeout = { status: 'blocked', converged: false, blockedReasons: [`closeout-engine:${String((e && e.message) || e)}`] };
    }
    return blockedRun(ctx, phase, 'build', { build, closeout });
  }

  // POST-BUILD PHASES — sequential, fail-closed, coordinator-validated.
  const phaseRes = await runPhaseEngineFn({
    file: ctx.checkpointFile, worktree: integrationDir, skip: ctx.skip,
    phaseFns: opts.phaseFns, validateFn: opts.validateFn, finalValidateFn: opts.finalValidateFn,
    reviewOptions: opts.reviewOptions, callTimeoutMs: ctx.callTimeoutMs,
  });
  if (stopStatus(ctx.checkpointFile)) return budgetStop(ctx, phase);
  if (!phaseRes || phaseRes.converged !== true) return blockedRun(ctx, phase, 'phase', phaseRes);

  // CONVERGENCE CONJUNCTION over the DURABLE checkpoint — the single gate to finalize + publish.
  const fresh = readDoc(ctx.checkpointFile);
  const convFailures = checkpointConvergence(fresh);
  if (convFailures.length) return blockedRun(ctx, phase, 'convergence', { convergenceFailures: convFailures });

  // FINALIZE done (fail-closed). A refused/failed checkpoint write STOPS the run — it never presses on.
  try { ckFinalize(ctx.checkpointFile, 'done', { result: { published: false, at: ctx.now } }); }
  catch (e) {
    if (e && e.name === 'CheckpointError') throw new PipelineEngineError('checkpoint-write-failed', `finalize refused: ${e.message}`, EXIT.CHECKPOINT);
    throw e;
  }

  // PUBLISH — a SINGLE fast-forward CAS, gated INDEPENDENTLY on the durable `done` checkpoint.
  const pub = publishFn({
    repoDir: integrationDir, targetRef: ctx.targetRef, integrationRef: ctx.integrationRef,
    baseSha: ctx.approvedBaseSha, checkpointFile: ctx.checkpointFile,
  });
  if (!pub || pub.published !== true) {
    return { command: phase, ok: false, run: ctx.run, status: 'published-refused', converged: true, published: false, publication: pub || null, exitCode: (pub && pub.code) || EXIT.DRIFT };
  }
  return { command: phase, ok: true, run: ctx.run, status: 'done', converged: true, published: true, publication: pub, exitCode: EXIT.SUCCESS };
}

function budgetStop(ctx, phase) {
  const stop = stopStatus(ctx.checkpointFile);
  try { stampStatus(ctx.checkpointFile, 'needs_attention'); } catch { /* best-effort */ }
  return { command: phase, ok: false, run: ctx.run, status: 'budget-stopped', converged: false, budget: stop, exitCode: EXIT.BUDGET };
}
function blockedRun(ctx, phase, stage, detail) {
  try { stampStatus(ctx.checkpointFile, 'needs_attention'); } catch { /* best-effort */ }
  return {
    command: phase, ok: false, run: ctx.run, status: 'blocked', converged: false, blockedStage: stage,
    convergenceFailures: (detail && detail.convergenceFailures) || undefined,
    blockedReasons: (detail && detail.blockedReasons) || undefined,
    closeout: (detail && detail.closeout) || undefined,
    exitCode: EXIT.BLOCKED,
  };
}

// Default (real) workspace setup: a detached integration worktree checked out at the approved base. Tests
// inject their own `prepareWorkspace` to avoid touching a real repo.
async function defaultPrepareWorkspace(ctx) {
  const wt = createIntegrationWorktree({
    root: ctx.root, runId: ctx.run, baseSha: ctx.approvedBaseSha, worktreesDir: ctx.worktreesDir,
  });
  return { integrationDir: wt.path };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// start
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
/**
 * Start an approved run: full preflight + one-use plan-approval CONSUME BEFORE any Codex spawn, then drive
 * to convergence and publish fast-forward. A replayed approval (double start) is refused.
 */
export async function start(opts) {
  const ctx = loadRunCtx(opts);
  // 1. PREFLIGHT — every drift/target/dirty/checkpoint refusal fires here, before any executor.
  preflight(ctx, { requireStatus: 'prepared' });
  // 2. CAPABILITY GATE — CONSUME the one-use plan approval. A replay/mismatch/expiry refuses here, before
  //    any Codex spawn. This is what forbids a double-start and an edited-plan run.
  try {
    consumePlanApproval({
      capDir: ctx.capDir, run: ctx.run, rawPlan: ctx.rawPlan, config: ctx.rawConfig,
      baseSha: ctx.approvedBaseSha, targetRef: ctx.targetRef, engineVersion: ENGINE_VERSION,
      nonce: ctx.approvalNonce, now: ctx.now,
    });
  } catch (e) {
    if (e instanceof AuthorizationError) throw new PipelineEngineError(e.reason, `plan approval refused: ${e.message}`, e.code);
    throw e;
  }
  // 3. mark running (a crash mid-flight resumes as 'running', never silently 'done').
  stampStatus(ctx.checkpointFile, 'running');
  return driveToConvergence(ctx, opts, 'start');
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// resume
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
/**
 * Resume an interrupted run from durable state. Reconciles crashed budget segments (never erases spend or
 * no-progress counters), refuses a run that never consumed its approval, never re-consumes/re-mints an
 * approval, and never treats a budget stop or an agent's self-assertion as completion.
 */
export async function resume(opts) {
  const ctx = loadRunCtx(opts);
  // A resumable run is one already underway — not a fresh terminal/prepared state.
  const st = ctx.doc.status;
  if (st === 'done' || st === 'aborted') refuse('checkpoint-mismatch', `run is terminal ('${st}') — nothing to resume`, EXIT.PREFLIGHT);
  preflight(ctx, {}); // no status pin: running/needs_attention/prepared-consumed are all resumable

  // The plan approval MUST already be consumed (the run was genuinely started). An 'issued' (un-consumed)
  // approval means the run never started → refuse (resume is not a start). A missing/revoked one refuses.
  const rc = reconcileCapability({ capDir: ctx.capDir, run: ctx.run, kind: 'plan' });
  // consumed-but-not-completed surfaces as 'outcome_unknown'; a completed one as 'completed'. Anything else
  // (issued / missing / revoked) is not a resumable, already-started run.
  if (rc.status !== 'outcome_unknown' && rc.status !== 'completed') {
    refuse('approval-replayed', `refusing resume: plan approval is '${rc.status}', not a consumed approval (a resume never re-consumes or re-mints an approval)`, EXIT.PREFLIGHT);
  }

  // Reconcile crashed budget segments BEFORE reserving again — conservatively charges a crashed child's
  // full reserved slice; spend and no-progress barriers are preserved (only ever added to).
  reconcileOpenSegments(ctx.checkpointFile);
  if (stopStatus(ctx.checkpointFile)) return budgetStop(ctx, 'resume'); // a budget stop is NOT completion

  stampStatus(ctx.checkpointFile, 'running');
  return driveToConvergence(ctx, opts, 'resume');
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// status
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
/** A read-only durable snapshot. Never mutates. */
export function status(opts) {
  const ctx = loadRunCtx(opts, { reReadPayload: false });
  const doc = ctx.doc;
  const convFailures = checkpointConvergence(doc);
  const units = doc.units || {};
  const unitCounts = { total: 0 };
  for (const u of Object.values(units)) { unitCounts.total++; unitCounts[u.status] = (unitCounts[u.status] || 0) + 1; }
  const phases = {};
  for (const [n, p] of Object.entries(doc.phases || {})) phases[n] = p && p.status;
  let budget = null;
  try { budget = stopStatus(ctx.checkpointFile); } catch { budget = null; }
  return {
    command: 'status', ok: true, run: ctx.run, status: doc.status,
    converged: convFailures.length === 0, convergenceFailures: convFailures,
    units: unitCounts, phases,
    openItems: Array.isArray(doc.openItems) ? doc.openItems.length : 0,
    scopeCoverage: doc.pipeline?.scopeCoverage || null,
    finalValidation: doc.finalValidation || null,
    budgetStopped: budget,
    exitCode: EXIT.SUCCESS,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// authorize
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
/**
 * Authorize an irreversible action on a CONVERGED, quiesced run: durably HALT at awaiting_authorization and
 * mint a FRESH, action-scoped, TTL-limited capability. A plan approval can never satisfy an action.
 * @param {object} opts { checkpointFile, action, interactive, context, now? }
 */
export function authorize(opts) {
  const action = req(opts, 'action');
  const ctx = loadRunCtx(opts, { reReadPayload: false });
  // You may only authorize an irreversible action on a run that has actually CONVERGED + finalized done.
  if (ctx.doc.status !== 'done') {
    refuse('not-converged', `refusing to authorize '${action}': run is '${ctx.doc.status}', not a converged (done) run`, EXIT.BLOCKED);
  }
  const evidence = ctx.doc.finalValidation || { note: 'converged', run: ctx.run };
  let halt; let cap;
  try {
    halt = haltForAuthorization({ checkpointFile: ctx.checkpointFile, action, evidence, now: ctx.now });
    cap = issueActionCapability({
      capDir: ctx.capDir, run: ctx.run, action, baseSha: ctx.approvedBaseSha, targetRef: ctx.targetRef,
      engineVersion: ENGINE_VERSION, ttlMs: ctx.authorizeTtlMs, interactive: opts.interactive, context: opts.context,
      checkpointFile: ctx.checkpointFile, worktreePaths: [ctx.worktreesDir], now: ctx.now,
    });
  } catch (e) {
    if (e instanceof AuthorizationError) throw new PipelineEngineError(e.reason, `authorize refused: ${e.message}`, e.code);
    throw e;
  }
  stampMeta(ctx.checkpointFile, { actionNonces: { ...(ctx.meta.actionNonces || {}), [action]: cap.nonce } });
  return {
    command: 'authorize', ok: true, run: ctx.run, action, status: 'awaiting_authorization',
    checkpointRevision: halt.checkpointRevision,
    capability: { kind: action, expiresAt: cap.expiresAt },
    exitCode: EXIT.SUCCESS,
  };
}
