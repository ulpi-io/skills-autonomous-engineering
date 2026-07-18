// git-repo-fixture.mjs — spins up a THROWAWAY git repo + an approved plan + run-config for the
// end-to-end pipeline harness (scripts/test-pipeline-e2e.mjs). Everything lives under a single mkdtemp
// directory that `cleanup()` removes; the real project repo is NEVER touched.
//
// Layout (all siblings under one temp dir):
//   root/       the repo. It carries `main` at the base commit (the publication TARGET, left UNCHECKED so
//               a fast-forward `update-ref` can move it) and is itself CHECKED OUT on the run's integration
//               branch `ulpi-int-<run>` — so it doubles as BOTH the coordinator root AND the integration
//               worktree (mirrors the established build-engine/git-integration fixture shape, and keeps a
//               real `.git` directory so git-integration's default `.git/…` lock path works).
//   wt/         worktreesDir — the per-task detached worktrees the build engine creates (outside root, so
//               root's working tree stays clean for the coordinator's dirty-tree preflight).
//   state/      stateDir / ULPI_RUNS_DIR — the durable checkpoint lands here as <run>.json.
//   caps/       capDir — capability issuance (created by the engine).
//   control/    the fake-codex control file, output schema, and per-task final-message files.
//
// Zero external deps (node: builtins only).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function raw(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
export const refSha = (root, ref) => raw(root, ['rev-parse', ref]).trim();
export function isAncestor(root, ancestor, descendant) {
  try { execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: root, stdio: 'ignore' }); return true; }
  catch { return false; }
}

let counter = 0;

/**
 * Build a throwaway repo + approved plan/config for a run whose topological layers are `layers`
 * (e.g. [['alpha','beta'],['gamma']]). Each task id maps to a single in-scope file `src/<id>.js`.
 * `redTasks` seeds the fake-codex control file (those tasks are written with a forced-red marker).
 * @returns a fixture handle with every path the harness needs plus `setRedTasks()` and `cleanup()`.
 */
export function makeGitRepo({ layers, redTasks = [], run } = {}) {
  if (!Array.isArray(layers) || layers.length === 0 || !layers.every((l) => Array.isArray(l) && l.length)) {
    throw new Error('makeGitRepo requires a non-empty layers: string[][]');
  }
  const runId = run || `e2e${++counter}`;
  const dir = mkdtempSync(join(tmpdir(), 'ulpi-e2e-'));
  const root = join(dir, 'root'); mkdirSync(root, { recursive: true });
  const worktreesDir = join(dir, 'wt');
  const stateDir = join(dir, 'state'); mkdirSync(stateDir, { recursive: true });
  const capDir = join(dir, 'caps');
  const controlDir = join(dir, 'control'); mkdirSync(controlDir, { recursive: true });

  // Base commit on `main`, then branch + check out the integration branch (leaving `main` unchecked).
  raw(root, ['init', '-q', '-b', 'main']);
  raw(root, ['config', 'user.email', 'e2e@example.com']);
  raw(root, ['config', 'user.name', 'E2E']);
  raw(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'README.md'), '# e2e fixture\n');
  raw(root, ['add', '-A']);
  raw(root, ['commit', '-qm', 'base']);
  const base = refSha(root, 'HEAD');
  const intBranch = `ulpi-int-${runId}`;
  raw(root, ['branch', intBranch, base]);
  raw(root, ['checkout', '-q', intBranch]);

  const targetRef = 'refs/heads/main';
  const integrationRef = `refs/heads/${intBranch}`;
  const allIds = layers.flat();
  const tasks = allIds.map((id) => ({
    id, writeScope: [`src/${id}.js`], paths: [`src/${id}.js`], subject: `integrate ${id}`,
    scopeItems: [`SCOPE-${id}`],
  }));
  const selectedScope = allIds.map((id) => ({ id: `SCOPE-${id}`, title: `deliver ${id}`, source: 'e2e fixture intake' }));
  const plan = { planId: `${runId}-plan`, base: { approvalReady: true }, selectedScope, scopeDrops: [], tasks, layers };
  const budget = {
    maxCodexCalls: 200, maxActiveWallMs: 600000, maxAttemptsPerTask: 20,
    maxAttemptsPerPhase: 100, maxNoProgressBarriers: 20, escalationTriggers: [],
  };
  const config = {
    run: runId, root, stateDir, capDir, worktreesDir, targetRef, integrationRef,
    base, budget, skip: ['simplify', 'performance', 'ship_prep'],
    approvalTtlMs: 900000, callTimeoutMs: 60000,
  };

  const planPath = join(dir, 'plan.json'); writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  const configPath = join(dir, 'config.json'); writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const checkpointFile = join(stateDir, `${runId}.json`);
  const controlPath = join(controlDir, 'control.json');
  const schemaPath = join(controlDir, 'schema.json'); writeFileSync(schemaPath, `${JSON.stringify({ type: 'object' })}\n`);

  const fx = {
    dir, root, worktreesDir, stateDir, capDir, controlDir, controlPath, schemaPath,
    base, run: runId, targetRef, integrationRef, intBranch, plan, config, planPath, configPath,
    checkpointFile, allIds, layers,
    // Rewrite the fake-codex control file. This is fixture state, NOT plan/config bytes — flipping it
    // between start and resume does not perturb the coordinator's plan/config drift hashes.
    setRedTasks(ids) { writeFileSync(controlPath, `${JSON.stringify({ redTasks: ids })}\n`); },
    cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
  fx.setRedTasks(redTasks);
  return fx;
}
