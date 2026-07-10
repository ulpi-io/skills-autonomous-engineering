#!/usr/bin/env node
// pipeline.mjs — the PUBLIC CLI entrypoint for the Codex-native pipeline coordinator.
//
// It implements EXACTLY the versioned grammar + exit-code table pinned in lib/cli-contract.mjs and
// dispatches to lib/pipeline-engine.mjs. It owns three thin responsibilities and nothing else:
//
//   1. GRAMMAR + EXIT CODES. `parseCli(argv)` enforces the five forms and their flags; every refusal
//      carries a pinned EXIT code. This module translates a thrown error's `.code` into the process exit
//      status and never invents a meaning (exit 1 is reserved for an unexpected crash).
//   2. ONE-OBJECT-ON-STDOUT JSON. In `--json` mode EXACTLY ONE final JSON object is written to stdout
//      (success OR a typed error object); ALL diagnostics go to stderr. In human mode a short summary goes
//      to stdout and diagnostics to stderr.
//   3. RUN LOCATION. `approve` places the run under config.stateDir; the other verbs resolve a run by id
//      to `<runsDir>/<id>.json` (ULPI_RUNS_DIR or <cwd>/.ulpi/runs). Payloads (plan/config) are re-read
//      from the paths recorded at approval so an edit is detected as drift by the engine.
//
// Heavyweight execution (the Codex executor, per-task/-phase validation, the real integration worktree) is
// injected as `seams` for tests, and defaults to real wiring built from the plan+config for production.
//
// Zero external deps (node: builtins only). Node 22+.

import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

import {
  parseCli, parseRunConfig, EXIT, emit, CliContractError,
} from './lib/cli-contract.mjs';
import * as engine from './lib/pipeline-engine.mjs';

// ── error → pinned exit code ──────────────────────────────────────────────────────────────────────────
// Every typed error our libraries throw carries an EXIT-scale `.code` (they import EXIT), EXCEPT the
// checkpoint store's CheckpointError, whose code is on its own {1:usage,2:refusal} scale — remap it.
function toExitCode(e) {
  if (e && e.name === 'CheckpointError') return e.code === 2 ? EXIT.CHECKPOINT : EXIT.USAGE;
  if (e && Number.isInteger(e.code) && e.code >= 0 && e.code <= 7 && e.code !== 1) return e.code;
  return 1; // reserved: unexpected crash
}

function readTextFile(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new CliContractError(`${label} must be an absolute path`, EXIT.USAGE);
  if (!existsSync(path)) throw new CliContractError(`${label} not found: ${path}`, EXIT.USAGE);
  try { return readFileSync(path, 'utf8'); }
  catch (e) { throw new CliContractError(`cannot read ${label} at ${path}: ${e.message}`, EXIT.USAGE); }
}

function runsDirOf(io) {
  const env = io.env || {};
  const cwd = io.cwd || process.cwd();
  const d = env.ULPI_RUNS_DIR && isAbsolute(env.ULPI_RUNS_DIR) ? env.ULPI_RUNS_DIR : join(cwd, '.ulpi', 'runs');
  return d;
}
const checkpointFor = (io, run) => join(runsDirOf(io), `${run}.json`);

// ── per-command handlers ────────────────────────────────────────────────────────────────────────────
async function doApprove(args, io) {
  const rawPlan = readTextFile(args.plan, '--plan');
  const rawConfig = readTextFile(args.config, '--config');
  // Locate where approve will place the run: prefer the config's stateDir, else the conventional runsDir.
  let stateDir = null;
  try { const c = parseRunConfig(rawConfig); if (typeof c.stateDir === 'string' && isAbsolute(c.stateDir)) stateDir = c.stateDir; } catch { /* engine validates */ }
  const run = safeRunFromConfig(rawConfig);
  const checkpointFile = stateDir ? join(stateDir, `${run}.json`) : checkpointFor(io, run);
  return engine.approve({
    rawPlan, rawConfig, planPath: args.plan, configPath: args.config, checkpointFile,
    ...(io.seams || {}),
  });
}

function safeRunFromConfig(rawConfig) {
  let c; try { c = parseRunConfig(rawConfig); } catch { throw new CliContractError('run config is not valid JSON', EXIT.USAGE); }
  if (!c || typeof c.run !== 'string') throw new CliContractError('run config must carry a string `run` id', EXIT.USAGE);
  return c.run;
}

async function doStart(args, io) {
  return engine.start({ checkpointFile: checkpointFor(io, args.run), ...(io.seams || {}) });
}
async function doResume(args, io) {
  return engine.resume({ checkpointFile: checkpointFor(io, args.run), ...(io.seams || {}) });
}
function doStatus(args, io) {
  return engine.status({ checkpointFile: checkpointFor(io, args.run), ...(io.seams || {}) });
}
function doAuthorize(args, io) {
  return engine.authorize({ checkpointFile: checkpointFor(io, args.run), action: args.action, ...(io.seams || {}) });
}

// ── the dispatcher ────────────────────────────────────────────────────────────────────────────────────
/**
 * Run one CLI invocation. Returns the process exit code. Never calls process.exit (so it is unit-testable);
 * the module tail does that when run as a script.
 * @param {string[]} argv the args AFTER `node pipeline.mjs` (i.e. the command + flags)
 * @param {{stdout?, stderr?, env?, cwd?, seams?}} io
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  // Detect --json robustly even if parsing fails, so an early error still honors the one-object rule.
  const jsonMode = Array.isArray(argv) && argv.includes('--json');

  let args;
  try { args = parseCli(argv); }
  catch (e) { return fail(e, null, jsonMode, stdout, stderr); }

  const json = args.json === true;
  try {
    let result;
    switch (args.command) {
      case 'approve':   result = await doApprove(args, io); break;
      case 'start':     result = await doStart(args, io); break;
      case 'resume':    result = await doResume(args, io); break;
      case 'status':    result = doStatus(args, io); break;
      case 'authorize': result = doAuthorize(args, io); break;
      default:          throw new CliContractError(`unhandled command '${args.command}'`, EXIT.USAGE);
    }
    const exitCode = Number.isInteger(result.exitCode) ? result.exitCode : EXIT.SUCCESS;
    if (json) {
      stdout.write(emit(stripInternal(result)) + '\n'); // exactly one object on stdout
    } else {
      stdout.write(humanLine(result) + '\n');
    }
    return exitCode;
  } catch (e) {
    return fail(e, args, json, stdout, stderr);
  }
}

// Present a typed error: one JSON object on stdout in json mode (diagnostics to stderr either way).
function fail(e, args, json, stdout, stderr) {
  const code = toExitCode(e);
  const obj = {
    command: args ? args.command : null, ok: false,
    error: (e && e.message) || String(e), reason: (e && e.reason) || null, exitCode: code,
  };
  stderr.write(`pipeline: ${obj.error}${obj.reason ? ` [${obj.reason}]` : ''}\n`);
  if (json) stdout.write(emit(obj) + '\n');
  return code;
}

// Drop non-serializable / bulky internal fields before emitting the public JSON object.
function stripInternal(result) {
  const { publication, budget, budgetStopped, convergenceFailures, blockedReasons, ...rest } = result;
  const out = { ...rest };
  if (publication !== undefined) out.publication = publication;
  if (budget !== undefined) out.budget = budget;
  if (budgetStopped !== undefined) out.budgetStopped = budgetStopped;
  if (convergenceFailures !== undefined) out.convergenceFailures = convergenceFailures;
  if (blockedReasons !== undefined) out.blockedReasons = blockedReasons;
  return out;
}

function humanLine(r) {
  const bits = [`${r.command}`, r.run ? `run=${r.run}` : null, `status=${r.status}`,
    r.converged !== undefined ? `converged=${r.converged}` : null,
    r.published !== undefined ? `published=${r.published}` : null,
    r.action ? `action=${r.action}` : null];
  return bits.filter(Boolean).join(' ');
}

// ── script tail ─────────────────────────────────────────────────────────────────────────────────────
// Run only when invoked directly (not when imported by tests).
const invokedDirectly = (() => {
  try { return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((e) => {
    process.stderr.write(`pipeline: unexpected: ${(e && e.stack) || e}\n`);
    process.exitCode = 1;
  });
}
