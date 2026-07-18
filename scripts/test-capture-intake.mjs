#!/usr/bin/env node
// Dedicated CLI contract for autonomous-pipeline/scripts/capture-intake.mjs.
// Pins Phase-0 grammar, one-object JSON errors, exit codes 0/2/3/6, config/scope input handling,
// canonical output placement, and idempotent write-once behavior without invoking any live agent/network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { main } from '../autonomous-pipeline/scripts/capture-intake.mjs';
import { intakePathFor } from '../autonomous-pipeline/scripts/lib/intake-scope.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'autonomous-pipeline', 'scripts', 'capture-intake.mjs');

let counter = 0;
function fixture(t, over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ulpi-capture-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = `capture-${++counter}`;
  const root = join(dir, 'root'); mkdirSync(root, { recursive: true });
  const config = {
    run,
    root,
    stateDir: join(dir, 'runs'),
    capDir: join(dir, 'caps'),
    worktreesDir: join(dir, 'worktrees'),
    targetRef: 'refs/heads/main',
    base: 'HEAD',
    budget: {},
    ...over.config,
  };
  const scope = {
    run,
    selection: 'Full MVP test bundle',
    selectedScope: [{ id: 'SCOPE-001', title: 'Selected feature', source: 'user' }],
    ...over.scope,
  };
  const configPath = join(dir, 'config.json');
  const scopePath = join(dir, 'scope.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(scopePath, `${JSON.stringify(scope, null, 2)}\n`);
  return { dir, run, config, scope, configPath, scopePath, intakePath: intakePathFor(config) };
}

function sink() {
  let value = '';
  return { write: (chunk) => { value += String(chunk); }, text: () => value };
}

function invoke(argv) {
  const stdout = sink(); const stderr = sink();
  const code = main(argv, { stdout, stderr });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

function jsonResult(argv) {
  const args = argv.includes('--json') ? argv : [...argv, '--json'];
  const result = invoke(args);
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `--json must emit exactly one stdout object, got ${JSON.stringify(result.stdout)}`);
  const body = JSON.parse(lines[0]);
  assert.equal(body.exitCode ?? result.code, result.code);
  return { ...result, body };
}

test('main happy path writes the canonical authority and identical recapture is idempotent', (t) => {
  const f = fixture(t);
  const first = jsonResult(['--config', f.configPath, '--scope', f.scopePath]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.created, true);
  assert.equal(first.body.run, f.run);
  assert.equal(first.body.file, f.intakePath);
  assert.equal(first.body.selectedScopeCount, 1);
  assert.match(first.body.fileSha256, /^[a-f0-9]{64}$/);
  assert.match(first.body.scopeSha256, /^[a-f0-9]{64}$/);
  assert.equal(lstatSync(f.intakePath).mode & 0o777, 0o400);

  const second = jsonResult(['--config', f.configPath, '--scope', f.scopePath]);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.body.created, false);
  assert.equal(second.body.fileSha256, first.body.fileSha256);
});

test('human output distinguishes a new capture from an identical existing authority', (t) => {
  const f = fixture(t);
  const first = invoke(['--config', f.configPath, '--scope', f.scopePath]);
  assert.equal(first.code, 0);
  assert.match(first.stdout, /^captured intake scope: 1 item\(s\)/);
  assert.equal(first.stderr, '');
  const second = invoke(['--config', f.configPath, '--scope', f.scopePath]);
  assert.equal(second.code, 0);
  assert.match(second.stdout, /^already captured \(identical\) intake scope: 1 item\(s\)/);
  assert.equal(second.stderr, '');
});

test('the executable entrypoint returns exit 0 and exactly one JSON object', (t) => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, [CLI, '--config', f.configPath, '--scope', f.scopePath, '--json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(child.status, 0, child.stderr);
  const lines = child.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const body = JSON.parse(lines[0]);
  assert.equal(body.ok, true);
  assert.equal(body.created, true);
  assert.equal(body.file, f.intakePath);
});

test('argument grammar rejects missing, unknown, duplicate, relative, and traversing flags with exit 2', async (t) => {
  const f = fixture(t);
  const cases = [
    ['missing both required flags', ['--json'], /missing required flag --config/],
    ['unknown flag', ['--unknown', '--json'], /unknown argument/],
    ['duplicate config', ['--config', f.configPath, '--config', f.configPath, '--scope', f.scopePath, '--json'], /duplicate flag --config/],
    ['duplicate scope', ['--config', f.configPath, '--scope', f.scopePath, '--scope', f.scopePath, '--json'], /duplicate flag --scope/],
    ['duplicate json', ['--json', '--json'], /duplicate flag --json/],
    ['missing config value', ['--json', '--config'], /--config requires a value/],
    ['missing scope value', ['--json', '--config', f.configPath, '--scope'], /--scope requires a value/],
    ['missing config flag', ['--scope', f.scopePath, '--json'], /missing required flag --config/],
    ['missing scope flag', ['--config', f.configPath, '--json'], /missing required flag --scope/],
    ['relative config', ['--config', 'config.json', '--scope', f.scopePath, '--json'], /--config must be an absolute/],
    ['relative scope', ['--config', f.configPath, '--scope', 'scope.json', '--json'], /--scope must be an absolute/],
    ['traversing config', ['--config', `${f.dir}/../config.json`, '--scope', f.scopePath, '--json'], /traversal-free/],
    ['traversing scope', ['--config', f.configPath, '--scope', `${f.dir}/../scope.json`, '--json'], /traversal-free/],
  ];
  for (const [name, argv, match] of cases) {
    await t.test(name, () => {
      const result = jsonResult(argv);
      assert.equal(result.code, 2);
      assert.equal(result.body.ok, false);
      assert.equal(result.body.reason, 'usage');
      assert.equal(result.body.exitCode, 2);
      assert.match(result.body.message, match);
      assert.match(result.stderr, match);
    });
  }
});

test('missing and unreadable config/scope inputs preserve exit 2 versus exit 6', async (t) => {
  const f = fixture(t);
  const missingConfig = jsonResult(['--config', join(f.dir, 'missing-config.json'), '--scope', f.scopePath]);
  assert.equal(missingConfig.code, 2);
  assert.equal(missingConfig.body.reason, 'usage');
  assert.match(missingConfig.body.message, /run config not found/);

  const missingScope = jsonResult(['--config', f.configPath, '--scope', join(f.dir, 'missing-scope.json')]);
  assert.equal(missingScope.code, 2);
  assert.equal(missingScope.body.reason, 'usage');
  assert.match(missingScope.body.message, /intake draft not found/);

  const configDir = join(f.dir, 'config-dir'); mkdirSync(configDir);
  const unreadableConfig = jsonResult(['--config', configDir, '--scope', f.scopePath]);
  assert.equal(unreadableConfig.code, 6);
  assert.equal(unreadableConfig.body.reason, 'usage');
  assert.match(unreadableConfig.body.message, /cannot read run config/);

  const scopeDir = join(f.dir, 'scope-dir'); mkdirSync(scopeDir);
  const unreadableScope = jsonResult(['--config', f.configPath, '--scope', scopeDir]);
  assert.equal(unreadableScope.code, 6);
  assert.equal(unreadableScope.body.reason, 'usage');
  assert.match(unreadableScope.body.message, /cannot read intake draft/);
});

test('config and intake validation errors expose the pinned usage/intake reasons and exit codes', async (t) => {
  const f = fixture(t);
  const cases = [];

  const malformedConfig = join(f.dir, 'malformed-config.json'); writeFileSync(malformedConfig, '{');
  cases.push(['malformed config', malformedConfig, f.scopePath, 2, 'usage', /run config is not valid JSON/]);

  const invalidConfig = join(f.dir, 'invalid-config.json');
  writeFileSync(invalidConfig, JSON.stringify({ ...f.config, stateDir: 'relative/runs' }));
  cases.push(['invalid config', invalidConfig, f.scopePath, 2, 'usage', /config.stateDir must be an absolute path/]);

  const malformedScope = join(f.dir, 'malformed-scope.json'); writeFileSync(malformedScope, '{');
  cases.push(['malformed scope', f.configPath, malformedScope, 2, 'intake-invalid', /not valid JSON/]);

  const unknownScope = join(f.dir, 'unknown-scope.json');
  writeFileSync(unknownScope, JSON.stringify({ ...f.scope, extra: true }));
  cases.push(['unknown scope field', f.configPath, unknownScope, 2, 'intake-invalid', /unknown field.*extra/]);

  const mismatchScope = join(f.dir, 'mismatch-scope.json');
  writeFileSync(mismatchScope, JSON.stringify({ ...f.scope, run: 'different-run' }));
  cases.push(['run mismatch', f.configPath, mismatchScope, 3, 'intake-run-mismatch', /does not match/]);

  for (const [name, configPath, scopePath, code, reason, match] of cases) {
    await t.test(name, () => {
      const result = jsonResult(['--config', configPath, '--scope', scopePath]);
      assert.equal(result.code, code);
      assert.equal(result.body.reason, reason);
      assert.equal(result.body.exitCode, code);
      assert.match(result.body.message, match);
      assert.match(result.stderr, match);
    });
  }
});

test('capture conflicts and filesystem failures map to exit 3 and exit 6 without overwriting authority', (t) => {
  const f = fixture(t);
  const first = jsonResult(['--config', f.configPath, '--scope', f.scopePath]);
  assert.equal(first.code, 0);
  const original = readFileSync(f.intakePath, 'utf8');

  writeFileSync(f.scopePath, JSON.stringify({ ...f.scope, selection: 'changed after capture' }));
  const conflict = jsonResult(['--config', f.configPath, '--scope', f.scopePath]);
  assert.equal(conflict.code, 3);
  assert.equal(conflict.body.reason, 'intake-already-captured');
  assert.equal(readFileSync(f.intakePath, 'utf8'), original);

  chmodSync(f.intakePath, 0o600);
  const writable = jsonResult(['--config', f.configPath, '--scope', f.scopePath]);
  assert.equal(writable.code, 3);
  assert.equal(writable.body.reason, 'intake-writable');
  chmodSync(f.intakePath, 0o400);

  const io = fixture(t);
  const stateBlocker = join(io.dir, 'state-blocker'); writeFileSync(stateBlocker, 'not a directory');
  const badConfig = { ...io.config, stateDir: join(stateBlocker, 'runs') };
  writeFileSync(io.configPath, JSON.stringify(badConfig));
  const failedWrite = jsonResult(['--config', io.configPath, '--scope', io.scopePath]);
  assert.equal(failedWrite.code, 6);
  assert.equal(failedWrite.body.reason, 'intake-io');
  assert.equal(failedWrite.body.exitCode, 6);
  assert.match(failedWrite.body.message, /cannot capture durable intake snapshot/);
});

test('non-JSON failures write diagnostics only to stderr', () => {
  const result = invoke([]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /missing required flag --config/);
});
