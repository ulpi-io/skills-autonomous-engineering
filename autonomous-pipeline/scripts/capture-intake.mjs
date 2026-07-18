#!/usr/bin/env node
// capture-intake.mjs — Phase-0 write-once intake authority, run before auto-spec/auto-plan.
// Usage: node capture-intake.mjs --config <absolute run-config.json> --scope <absolute intake-draft.json> [--json]

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseRunConfigObject } from './lib/pipeline-engine.mjs';
import { captureIntakeSnapshot, intakePathFor, IntakeScopeError } from './lib/intake-scope.mjs';

function usage(message) {
  const e = new Error(message);
  e.code = 2;
  throw e;
}

function parseArgs(argv) {
  const out = { json: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--json') {
      if (seen.has('json')) usage('duplicate flag --json');
      seen.add('json'); out.json = true; continue;
    }
    if (token !== '--config' && token !== '--scope') usage(`unknown argument ${JSON.stringify(token)}`);
    const name = token.slice(2);
    if (seen.has(name)) usage(`duplicate flag --${name}`);
    seen.add(name);
    const value = argv[++i];
    if (!value) usage(`--${name} requires a value`);
    if (!isAbsolute(value) || value.split('/').includes('..')) usage(`--${name} must be an absolute, traversal-free path`);
    out[name] = value;
  }
  for (const name of ['config', 'scope']) if (!out[name]) usage(`missing required flag --${name}`);
  return out;
}

function read(path, label) {
  if (!existsSync(path)) usage(`${label} not found: ${path}`);
  try { return readFileSync(path, 'utf8'); }
  catch (e) { const err = new Error(`cannot read ${label}: ${e.message}`); err.code = 6; throw err; }
}

export function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let json = Array.isArray(argv) && argv.includes('--json');
  try {
    const args = parseArgs(argv); json = args.json;
    const rawConfig = read(args.config, 'run config');
    const rawScope = read(args.scope, 'intake draft');
    const config = parseRunConfigObject(rawConfig);
    const file = intakePathFor(config);
    const result = captureIntakeSnapshot(file, rawScope, { expectedRun: config.run });
    const out = {
      ok: true, created: result.created, run: config.run, file,
      fileSha256: result.fileSha256, scopeSha256: result.snapshot.scopeSha256,
      selectedScopeCount: result.snapshot.selectedScope.length,
    };
    stdout.write(json ? `${JSON.stringify(out)}\n` : `${result.created ? 'captured' : 'already captured (identical)'} intake scope: ${result.snapshot.selectedScope.length} item(s) → ${file}\n`);
    return 0;
  } catch (e) {
    const code = Number.isInteger(e?.code) ? e.code : 1;
    const reason = e instanceof IntakeScopeError ? e.reason : 'usage';
    stderr.write(`${e.message}\n`);
    if (json) stdout.write(`${JSON.stringify({ ok: false, reason, message: e.message, exitCode: code })}\n`);
    return code;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
