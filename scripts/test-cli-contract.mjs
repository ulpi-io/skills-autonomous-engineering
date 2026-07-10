#!/usr/bin/env node
// test-cli-contract.mjs — behavior contract tests for
// autonomous-pipeline/scripts/lib/cli-contract.mjs.
//
// cli-contract.mjs is the SINGLE SOURCE OF TRUTH for three pinned contracts the coordinator
// depends on and a refactor could silently drift:
//   (a) the EXACT Codex executor argv (an ARRAY, never a shell string) — global flags before
//       `exec`, prompt only on stdin, and a hard rejection of every unsafe flag/interpolation;
//   (b) the public pipeline CLI grammar (five forms) + the one-object-on-stdout JSON rule;
//   (c) the pinned exit-code table 0/2/3/4/5/6/7.
// Each test asserts a load-bearing guarantee that prose alone cannot enforce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOD = join(HERE, '..', 'autonomous-pipeline', 'scripts', 'lib', 'cli-contract.mjs');
const C = await import(MOD);

// ---------------------------------------------------------------------------
// (a) Codex executor argv
// ---------------------------------------------------------------------------

const OK_CODEX = () => ({
  sandbox: 'workspace-write',
  cd: '/repo/.ulpi/worktrees/task-1',
  schemaFile: '/repo/.ulpi/schema/eng.json',
  outputLastMessage: '/repo/.ulpi/runs/last-1.txt',
});

test('buildCodexArgv emits the EXACT pinned global-before-exec argv array', () => {
  const argv = C.buildCodexArgv(OK_CODEX());
  assert.deepEqual(argv, [
    'codex',
    '--ask-for-approval', 'never',
    '--sandbox', 'workspace-write',
    '--cd', '/repo/.ulpi/worktrees/task-1',
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--json',
    '--output-schema', '/repo/.ulpi/schema/eng.json',
    '--output-last-message', '/repo/.ulpi/runs/last-1.txt',
    '-',
  ]);
  // global flags MUST precede `exec`; exec flags MUST follow it.
  const execIdx = argv.indexOf('exec');
  assert.ok(argv.indexOf('--ask-for-approval') < execIdx, 'ask-for-approval is a global flag');
  assert.ok(argv.indexOf('--sandbox') < execIdx, 'sandbox is a global flag');
  assert.ok(argv.indexOf('--cd') < execIdx, 'cd is a global flag');
  assert.ok(argv.indexOf('--output-schema') > execIdx, 'output-schema is an exec flag');
  assert.equal(argv[argv.length - 1], '-', 'trailing `-` reads the prompt from stdin');
});

test('buildCodexArgv returns a plain string[] (never a shell string) with no prompt embedded', () => {
  const argv = C.buildCodexArgv(OK_CODEX());
  assert.ok(Array.isArray(argv));
  for (const a of argv) assert.equal(typeof a, 'string');
  // no argument may carry a prompt / newline / shell wrapper
  for (const a of argv) assert.ok(!/[\n\r]/.test(a), `no newline in argv token: ${a}`);
});

test('buildCodexArgv accepts read-only sandbox', () => {
  const argv = C.buildCodexArgv({ ...OK_CODEX(), sandbox: 'read-only' });
  assert.ok(argv.includes('read-only'));
});

test('buildCodexArgv REJECTS danger-full-access sandbox', () => {
  assert.throws(() => C.buildCodexArgv({ ...OK_CODEX(), sandbox: 'danger-full-access' }), C.CliContractError);
});

test('buildCodexArgv REJECTS an unknown sandbox value', () => {
  assert.throws(() => C.buildCodexArgv({ ...OK_CODEX(), sandbox: 'full' }), C.CliContractError);
});

test('buildCodexArgv REJECTS a relative --cd (must be absolute worktree)', () => {
  assert.throws(() => C.buildCodexArgv({ ...OK_CODEX(), cd: 'relative/path' }), C.CliContractError);
});

test('buildCodexArgv REJECTS path traversal in --cd', () => {
  assert.throws(() => C.buildCodexArgv({ ...OK_CODEX(), cd: '/repo/../etc/passwd' }), C.CliContractError);
});

test('buildCodexArgv REJECTS string interpolation / shell metacharacters', () => {
  for (const bad of ['/repo/$HOME', '/repo/`whoami`', '/repo/a;rm -rf /', '/repo/a|b', '/repo/a&b', '/repo/a$(id)']) {
    assert.throws(() => C.buildCodexArgv({ ...OK_CODEX(), cd: bad }), C.CliContractError, `cd=${bad} must reject`);
  }
  assert.throws(() => C.buildCodexArgv({ ...OK_CODEX(), schemaFile: '/repo/`x`.json' }), C.CliContractError);
  assert.throws(() => C.buildCodexArgv({ ...OK_CODEX(), outputLastMessage: '/repo/a;b.txt' }), C.CliContractError);
});

test('buildCodexArgv REJECTS a value that smuggles a forbidden flag', () => {
  // a value that looks like a flag must never slip into the argv
  assert.throws(() => C.buildCodexArgv({ ...OK_CODEX(), cd: '--add-dir' }), C.CliContractError);
  assert.throws(() => C.buildCodexArgv({ ...OK_CODEX(), schemaFile: '--dangerously-bypass-approvals-and-sandbox' }), C.CliContractError);
});

test('buildCodexArgv REJECTS unknown/smuggled option keys', () => {
  assert.throws(() => C.buildCodexArgv({ ...OK_CODEX(), addDir: '/x' }), C.CliContractError);
  assert.throws(() => C.buildCodexArgv({ ...OK_CODEX(), extra: true }), C.CliContractError);
});

test('buildCodexArgv REJECTS missing required options', () => {
  assert.throws(() => C.buildCodexArgv({ sandbox: 'read-only' }), C.CliContractError);
  assert.throws(() => C.buildCodexArgv(null), C.CliContractError);
});

test('the produced argv never contains any forbidden Codex flag', () => {
  const argv = C.buildCodexArgv(OK_CODEX());
  for (const f of C.FORBIDDEN_CODEX_FLAGS) assert.ok(!argv.includes(f), `argv must not contain ${f}`);
  assert.ok(!argv.includes('add-dir'));
  assert.ok(!argv.includes('search'));
  assert.ok(!argv.includes('--skip-git-repo-check'));
});

test('FORBIDDEN_CODEX_FLAGS pins the exact deny set', () => {
  assert.deepEqual([...C.FORBIDDEN_CODEX_FLAGS].sort(), [
    '--add-dir',
    '--dangerously-bypass-approvals-and-sandbox',
    '--ignore-rules',
    '--search',
    '--skip-git-repo-check',
  ]);
});

// ---------------------------------------------------------------------------
// (b) Pipeline CLI grammar
// ---------------------------------------------------------------------------

test('PIPELINE_COMMANDS pins exactly the five public forms', () => {
  assert.deepEqual([...C.PIPELINE_COMMANDS].sort(), ['approve', 'authorize', 'resume', 'start', 'status']);
});

test('approve --plan <p> --config <c> parses', () => {
  const r = C.parseCli(['approve', '--plan', '/repo/.ulpi/plans/p.json', '--config', '/repo/.ulpi/run.json']);
  assert.equal(r.command, 'approve');
  assert.equal(r.plan, '/repo/.ulpi/plans/p.json');
  assert.equal(r.config, '/repo/.ulpi/run.json');
  assert.equal(r.json, false);
});

test('start/resume/status --run <id> parse; --json sets json true', () => {
  for (const cmd of ['start', 'resume', 'status']) {
    const r = C.parseCli([cmd, '--run', 'run-2026-07-10', '--json']);
    assert.equal(r.command, cmd);
    assert.equal(r.run, 'run-2026-07-10');
    assert.equal(r.json, true);
  }
});

test('authorize --run <id> --action <a> parses for every allowed action', () => {
  for (const action of C.AUTHORIZE_ACTIONS) {
    const r = C.parseCli(['authorize', '--run', 'r1', '--action', action]);
    assert.equal(r.command, 'authorize');
    assert.equal(r.action, action);
  }
  assert.deepEqual([...C.AUTHORIZE_ACTIONS].sort(), ['deploy', 'publish', 'remote-merge', 'ship']);
});

test('parseCli supports --flag=value form', () => {
  const r = C.parseCli(['status', '--run=r9', '--json']);
  assert.equal(r.run, 'r9');
  assert.equal(r.json, true);
});

test('parseCli REJECTS an unknown command (usage → exit 2)', () => {
  const e = tryThrow(() => C.parseCli(['deploy', '--run', 'r1']));
  assert.ok(e instanceof C.CliContractError);
  assert.equal(e.code, C.EXIT.USAGE);
});

test('parseCli REJECTS an unknown flag', () => {
  assert.throws(() => C.parseCli(['start', '--run', 'r1', '--force']), C.CliContractError);
});

test('parseCli REJECTS a duplicate flag', () => {
  assert.throws(() => C.parseCli(['start', '--run', 'r1', '--run', 'r2']), C.CliContractError);
  assert.throws(() => C.parseCli(['start', '--run', 'r1', '--json', '--json']), C.CliContractError);
});

test('parseCli REJECTS positional ambiguity (a bare non-flag token)', () => {
  assert.throws(() => C.parseCli(['start', 'r1']), C.CliContractError);
  assert.throws(() => C.parseCli(['start', '--run', 'r1', 'extra']), C.CliContractError);
});

test('parseCli REJECTS a value passed to the boolean --json flag', () => {
  assert.throws(() => C.parseCli(['status', '--run', 'r1', '--json=1']), C.CliContractError);
});

test('parseCli REJECTS a missing required flag', () => {
  assert.throws(() => C.parseCli(['start']), C.CliContractError);
  assert.throws(() => C.parseCli(['authorize', '--run', 'r1']), C.CliContractError);
  assert.throws(() => C.parseCli(['approve', '--plan', '/p.json']), C.CliContractError);
});

test('parseCli REJECTS a flag with no value', () => {
  assert.throws(() => C.parseCli(['start', '--run']), C.CliContractError);
});

test('parseCli REJECTS an unsafe run id (traversal / injection / flag-like)', () => {
  for (const bad of ['../etc', 'a;b', 'a b', 'a|b', '$HOME', '`x`', '-x', 'a$(id)']) {
    assert.throws(() => C.parseCli(['start', '--run', bad]), C.CliContractError, `run=${bad} must reject`);
  }
});

test('parseCli REJECTS an unsafe path in --plan/--config', () => {
  assert.throws(() => C.parseCli(['approve', '--plan', '/repo/$(id).json', '--config', '/c.json']), C.CliContractError);
  assert.throws(() => C.parseCli(['approve', '--plan', '/p.json', '--config', '/repo/`x`.json']), C.CliContractError);
});

test('parseCli REJECTS an unauthorized --action', () => {
  assert.throws(() => C.parseCli(['authorize', '--run', 'r1', '--action', 'rm-rf']), C.CliContractError);
  assert.throws(() => C.parseCli(['authorize', '--run', 'r1', '--action', 'merge']), C.CliContractError);
});

// ---------------------------------------------------------------------------
// (b2) config / plan payload validation
// ---------------------------------------------------------------------------

test('parseRunConfig accepts a well-formed object', () => {
  const cfg = C.parseRunConfig('{"simplify":true,"performance":false}');
  assert.equal(cfg.simplify, true);
});

test('parseRunConfig REJECTS malformed JSON (config → exit 2)', () => {
  const e = tryThrow(() => C.parseRunConfig('{not json'));
  assert.ok(e instanceof C.CliContractError);
  assert.equal(e.code, C.EXIT.USAGE);
});

test('parseRunConfig REJECTS a non-object (array / null / scalar)', () => {
  assert.throws(() => C.parseRunConfig('[]'), C.CliContractError);
  assert.throws(() => C.parseRunConfig('null'), C.CliContractError);
  assert.throws(() => C.parseRunConfig('42'), C.CliContractError);
});

test('parseCanonicalPlan accepts a plan with tasks + layers', () => {
  const p = C.parseCanonicalPlan('{"tasks":[],"layers":[]}');
  assert.deepEqual(p.tasks, []);
  assert.deepEqual(p.layers, []);
});

test('parseCanonicalPlan REJECTS a schema-invalid plan (schema → exit 2)', () => {
  const e = tryThrow(() => C.parseCanonicalPlan('{"tasks":[]}'));
  assert.ok(e instanceof C.CliContractError);
  assert.equal(e.code, C.EXIT.USAGE);
  assert.throws(() => C.parseCanonicalPlan('{bad'), C.CliContractError);
  assert.throws(() => C.parseCanonicalPlan('{"tasks":{},"layers":[]}'), C.CliContractError);
});

// ---------------------------------------------------------------------------
// (b3) one-object-on-stdout JSON rule
// ---------------------------------------------------------------------------

test('emit produces a single-line JSON object that round-trips', () => {
  const s = C.emit({ ok: true, run: 'r1' });
  assert.ok(!/\n/.test(s), 'emit must not embed a newline');
  const obj = C.assertSingleStdoutObject(s);
  assert.deepEqual(obj, { ok: true, run: 'r1' });
});

test('assertSingleStdoutObject REJECTS contaminated stdout (diagnostics mixed in)', () => {
  assert.throws(() => C.assertSingleStdoutObject('[info] starting\n{"ok":true}'), C.CliContractError);
  assert.throws(() => C.assertSingleStdoutObject('{"ok":true}\nlog line'), C.CliContractError);
});

test('assertSingleStdoutObject REJECTS more than one object on stdout', () => {
  assert.throws(() => C.assertSingleStdoutObject('{"a":1}\n{"b":2}'), C.CliContractError);
});

test('assertSingleStdoutObject REJECTS a non-object payload (array / scalar / empty)', () => {
  assert.throws(() => C.assertSingleStdoutObject('[1,2]'), C.CliContractError);
  assert.throws(() => C.assertSingleStdoutObject('"hi"'), C.CliContractError);
  assert.throws(() => C.assertSingleStdoutObject(''), C.CliContractError);
});

// ---------------------------------------------------------------------------
// (c) exit-code table
// ---------------------------------------------------------------------------

test('EXIT pins the exact code map 0/2/3/4/5/6/7', () => {
  assert.equal(C.EXIT.SUCCESS, 0);
  assert.equal(C.EXIT.USAGE, 2);
  assert.equal(C.EXIT.PREFLIGHT, 3);
  assert.equal(C.EXIT.BLOCKED, 4);
  assert.equal(C.EXIT.BUDGET, 5);
  assert.equal(C.EXIT.CHECKPOINT, 6);
  assert.equal(C.EXIT.DRIFT, 7);
});

test('EXIT_TABLE documents every pinned code and NEVER uses reserved 1', () => {
  const codes = Object.keys(C.EXIT_TABLE).map(Number).sort((a, b) => a - b);
  assert.deepEqual(codes, [0, 2, 3, 4, 5, 6, 7]);
  assert.ok(!(1 in C.EXIT_TABLE), 'exit 1 is reserved for unexpected crashes, never a pinned meaning');
  for (const c of codes) assert.equal(typeof C.EXIT_TABLE[c], 'string');
});

test('CliContractError carries a numeric exit code from the pinned table', () => {
  const e = new C.CliContractError('x', C.EXIT.PREFLIGHT);
  assert.equal(e.code, 3);
  assert.equal(e.name, 'CliContractError');
});

// small helper: capture a thrown error for code assertions
function tryThrow(fn) {
  try { fn(); } catch (e) { return e; }
  throw new assert.AssertionError({ message: 'expected function to throw' });
}
