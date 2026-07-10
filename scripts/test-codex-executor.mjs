#!/usr/bin/env node
// test-codex-executor.mjs — behavior contract tests for the process runner + Codex adapter:
//   autonomous-pipeline/scripts/lib/process-runner.mjs   (argv-only, group-killing child runner)
//   autonomous-pipeline/scripts/lib/codex-executor.mjs   (pinned, fail-closed Codex adapter)
//
// NO real network / real codex is ever touched — a tiny FAKE codex CLI fixture (a node script written
// into a temp dir, its behavior selected by env vars) stands in for the real binary. The tests prove the
// load-bearing guarantees prose alone cannot enforce:
//   * the EXACT pinned global-before-exec argv is emitted and the prompt arrives on stdin;
//   * preflight FAILS closed on an absent pinned version and on a missing required flag;
//   * a schema-conforming final message yields role/evidence/usage + process metadata, and the bypass
//     flag is never emitted;
//   * non-zero exit / timeout / cancellation / output-ceiling / malformed JSON / missing final output /
//     a surviving descendant each yield a TYPED blocked result with the whole process group terminated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', 'autonomous-pipeline', 'scripts', 'lib');
const RUNNER = await import(join(LIB, 'process-runner.mjs'));
const EXEC = await import(join(LIB, 'codex-executor.mjs'));
const CONTRACT = await import(join(LIB, 'cli-contract.mjs'));

const NODE = process.execPath;
const PIN = EXEC.PINNED_CODEX_VERSION;

// ── the FAKE codex CLI fixture ────────────────────────────────────────────────────────────────────
// One script, many behaviors chosen by env. It answers `--version` and `exec --help` for preflight,
// and in exec mode records the argv it received + the prompt it read on stdin, then acts per FAKE_MODE.
const FAKE_CODEX = `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const argv = process.argv.slice(2);
const env = process.env;

if (argv.includes('--version')) {
  process.stdout.write('codex-cli ' + (env.FAKE_VERSION || '${PIN}') + '\\n');
  process.exit(0);
}
if (argv.includes('--help')) {
  const flags = ['--ask-for-approval','--sandbox','--cd','--ephemeral','--ignore-user-config','--json','--output-schema','--output-last-message'];
  const omit = env.FAKE_OMIT_FLAG || '';
  process.stdout.write(flags.filter(f => f !== omit).join('\\n') + '\\n');
  process.exit(0);
}

// exec mode
if (env.FAKE_RECORD_ARGV) fs.writeFileSync(env.FAKE_RECORD_ARGV, JSON.stringify(argv));
function outPath() {
  const i = argv.indexOf('--output-last-message');
  return i >= 0 ? argv[i + 1] : null;
}
const mode = env.FAKE_MODE || 'ok';

function act(stdinStr) {
  if (env.FAKE_RECORD_STDIN != null) fs.writeFileSync(env.FAKE_RECORD_STDIN, stdinStr);
  const out = outPath();
  if (mode === 'ok') {
    fs.writeFileSync(out, JSON.stringify({ role: 'engineer', status: 'built', evidence: ['ran node --test','all green'], usage: { input_tokens: 11, output_tokens: 22 } }));
    process.exit(0);
  }
  if (mode === 'schema') { fs.writeFileSync(out, JSON.stringify({ status: 'built', evidence: [] })); process.exit(0); }
  if (mode === 'malformed') { fs.writeFileSync(out, '{ this is : not json'); process.exit(0); }
  if (mode === 'missing') { process.exit(0); }
  if (mode === 'exit') { process.stderr.write('boom\\n'); process.exit(2); }
  process.exit(0);
}

function main() {
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'ceiling') { process.stdout.write('x'.repeat(200000)); setInterval(() => {}, 1000); return; }
  if (mode === 'descendant') {
    // spawn a grandchild in the SAME process group that outlives us, then exit clean.
    spawn(process.execPath, ['-e', "require('fs').writeFileSync(process.env.PIDF, String(process.pid)); setInterval(()=>{},1000);"], { env: { ...env, PIDF: env.FAKE_DESC_PIDFILE }, stdio: 'ignore' }).unref();
    const out = outPath();
    if (out) fs.writeFileSync(out, JSON.stringify({ role: 'engineer', evidence: [], usage: {} }));
    setTimeout(() => process.exit(0), 150); // give the grandchild time to fork
    return;
  }
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { buf += d; });
  process.stdin.on('end', () => act(buf));
}
main();
`;

function mkEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'codexexec-'));
  const fake = join(dir, 'fake-codex.mjs');
  writeFileSync(fake, FAKE_CODEX);
  const schemaFile = join(dir, 'schema.json');
  writeFileSync(schemaFile, JSON.stringify({ type: 'object' }));
  return {
    dir,
    fake,
    schemaFile,
    outputLastMessage: join(dir, 'last.txt'),
    cd: dir,
    argvFile: join(dir, 'argv.json'),
    stdinFile: join(dir, 'stdin.txt'),
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } },
  };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// process-runner
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

test('runProcess: clean exit → ok with captured stdout, no shell', async () => {
  const res = await RUNNER.runProcess({ file: NODE, args: ['-e', "process.stdout.write('hello')"] });
  assert.equal(res.status, 'ok');
  assert.equal(res.ok, true);
  assert.equal(res.reason, null);
  assert.equal(res.code, 0);
  assert.equal(res.stdout, 'hello');
  assert.equal(res.timedOut, false);
});

test('runProcess: prompt is delivered on stdin', async () => {
  const res = await RUNNER.runProcess({
    file: NODE,
    args: ['-e', "let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>process.stdout.write(b.toUpperCase()))"],
    stdin: 'from-stdin',
  });
  assert.equal(res.status, 'ok');
  assert.equal(res.stdout, 'FROM-STDIN');
});

test('runProcess: non-zero exit → blocked reason=exit', async () => {
  const res = await RUNNER.runProcess({ file: NODE, args: ['-e', 'process.exit(3)'] });
  assert.equal(res.status, 'blocked');
  assert.equal(res.reason, 'exit');
  assert.equal(res.code, 3);
});

test('runProcess: spawn error (missing binary) → blocked reason=spawn-error', async () => {
  const res = await RUNNER.runProcess({ file: join(tmpdir(), 'no-such-binary-xyz'), args: [] });
  assert.equal(res.status, 'blocked');
  assert.equal(res.reason, 'spawn-error');
});

test('runProcess: timeout kills the whole group and blocks', async () => {
  const env = mkEnv();
  try {
    const res = await RUNNER.runProcess({ file: NODE, args: [env.fake], env: { ...process.env, FAKE_MODE: 'hang' }, timeoutMs: 250 });
    assert.equal(res.status, 'blocked');
    assert.equal(res.reason, 'timeout');
    assert.equal(res.timedOut, true);
    assert.equal(res.killed, true);
    assert.equal(alive(res.pid), false, 'process group must be terminated after timeout');
  } finally { env.cleanup(); }
});

test('runProcess: AbortSignal cancellation kills the group and blocks', async () => {
  const env = mkEnv();
  const ac = new AbortController();
  try {
    const p = RUNNER.runProcess({ file: NODE, args: [env.fake], env: { ...process.env, FAKE_MODE: 'hang' }, timeoutMs: 5000, signal: ac.signal });
    await sleep(150);
    ac.abort();
    const res = await p;
    assert.equal(res.status, 'blocked');
    assert.equal(res.reason, 'cancelled');
    assert.equal(res.cancelled, true);
    assert.equal(alive(res.pid), false, 'process group must be terminated after cancel');
  } finally { env.cleanup(); }
});

test('runProcess: output ceiling truncates, kills the group, blocks', async () => {
  const env = mkEnv();
  try {
    const res = await RUNNER.runProcess({ file: NODE, args: [env.fake], env: { ...process.env, FAKE_MODE: 'ceiling' }, timeoutMs: 5000, maxOutputBytes: 1024 });
    assert.equal(res.status, 'blocked');
    assert.equal(res.reason, 'output-ceiling');
    assert.equal(res.truncated, true);
    assert.ok(res.stdout.length <= 1024, 'stdout is capped at the ceiling');
    assert.equal(alive(res.pid), false, 'process group must be terminated after ceiling breach');
  } finally { env.cleanup(); }
});

test('runProcess: surviving descendant → blocked and the group is terminated', async () => {
  const env = mkEnv();
  const pidFile = join(env.dir, 'gc.pid');
  try {
    const res = await RUNNER.runProcess({
      file: NODE, args: [env.fake],
      env: { ...process.env, FAKE_MODE: 'descendant', FAKE_DESC_PIDFILE: pidFile },
      timeoutMs: 5000,
    });
    assert.equal(res.status, 'blocked');
    assert.equal(res.reason, 'surviving-descendant');
    // the grandchild pid recorded by the fixture must be dead after finalize.
    await sleep(100);
    assert.ok(existsSync(pidFile), 'fixture recorded a grandchild pid');
    const gcPid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(Number.isInteger(gcPid) && gcPid > 0);
    assert.equal(alive(gcPid), false, 'leaked descendant must be killed with the group');
  } finally { env.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// codex-executor — happy path + argv/stdin proof
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

test('runCodexTask: emits the EXACT pinned argv, prompt on stdin, returns role/evidence/usage', async () => {
  const env = mkEnv();
  try {
    const prompt = 'implement TASK-004 and report evidence';
    const res = await EXEC.runCodexTask({
      prompt,
      sandbox: 'workspace-write',
      cd: env.cd,
      schemaFile: env.schemaFile,
      outputLastMessage: env.outputLastMessage,
      bin: NODE,
      // the fake is the real "codex program"; but bin is NODE and the first arg must be the fake path.
      // We inject the fake path by prepending it via env-less trick: use codexArgvPrefix below.
      env: { ...process.env, FAKE_MODE: 'ok', FAKE_RECORD_ARGV: env.argvFile, FAKE_RECORD_STDIN: env.stdinFile },
      // route the executor's argv through the fake by making bin=NODE and the fake the program:
      // handled via `program` option below.
      program: env.fake,
    });
    assert.equal(res.status, 'ok', JSON.stringify(res));
    assert.equal(res.role, 'engineer');
    assert.deepEqual(res.evidence, ['ran node --test', 'all green']);
    assert.deepEqual(res.usage, { input_tokens: 11, output_tokens: 22 });
    assert.equal(res.version, PIN);
    assert.ok(res.process && res.process.durationMs >= 0);

    // exact argv: what the fake received (after the fake path) must equal buildCodexArgv(...).slice(1).
    const recorded = JSON.parse(readFileSync(env.argvFile, 'utf8'));
    const expected = CONTRACT.buildCodexArgv({
      sandbox: 'workspace-write', cd: env.cd, schemaFile: env.schemaFile, outputLastMessage: env.outputLastMessage,
    }).slice(1);
    assert.deepEqual(recorded, expected, 'exec argv must be the exact pinned argv (minus bin)');
    // prompt arrived only on stdin, never in argv.
    assert.equal(readFileSync(env.stdinFile, 'utf8'), prompt);
    for (const tok of recorded) assert.notEqual(tok, prompt);
    // the bypass flag (and the rest of the forbidden set) is NEVER present.
    for (const f of CONTRACT.FORBIDDEN_CODEX_FLAGS) assert.ok(!recorded.includes(f), `forbidden flag leaked: ${f}`);
  } finally { env.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// codex-executor — preflight fail-closed
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

test('preflightCodex: FAILS on a version other than the pinned one', async () => {
  const env = mkEnv();
  try {
    const pf = await EXEC.preflightCodex({ bin: NODE, program: env.fake, cwd: env.cd, env: { ...process.env, FAKE_VERSION: '9.9.9' } });
    assert.equal(pf.ok, false);
    assert.equal(pf.reason, 'preflight-version');
  } finally { env.cleanup(); }
});

test('preflightCodex: FAILS when a required flag is absent from the CLI', async () => {
  const env = mkEnv();
  try {
    const pf = await EXEC.preflightCodex({ bin: NODE, program: env.fake, cwd: env.cd, env: { ...process.env, FAKE_OMIT_FLAG: '--output-last-message' } });
    assert.equal(pf.ok, false);
    assert.equal(pf.reason, 'preflight-flags');
    assert.ok(pf.detail.includes('--output-last-message'));
  } finally { env.cleanup(); }
});

test('preflightCodex: passes for the pinned version with every required flag', async () => {
  const env = mkEnv();
  try {
    const pf = await EXEC.preflightCodex({ bin: NODE, program: env.fake, cwd: env.cd, env: { ...process.env } });
    assert.equal(pf.ok, true);
    assert.equal(pf.version, PIN);
  } finally { env.cleanup(); }
});

test('runCodexTask: preflight version drift blocks the whole task (never runs exec)', async () => {
  const env = mkEnv();
  try {
    const res = await EXEC.runCodexTask({
      prompt: 'x', sandbox: 'read-only', cd: env.cd, schemaFile: env.schemaFile, outputLastMessage: env.outputLastMessage,
      bin: NODE, program: env.fake,
      env: { ...process.env, FAKE_VERSION: '1.2.3', FAKE_MODE: 'ok', FAKE_RECORD_ARGV: env.argvFile },
    });
    assert.equal(res.status, 'blocked');
    assert.equal(res.reason, 'preflight-version');
    assert.ok(!existsSync(env.argvFile), 'exec must not run when preflight fails');
  } finally { env.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// codex-executor — typed blocked failure modes (skipPreflight to isolate the exec path)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

function runExec(env, extraEnv, opts = {}) {
  return EXEC.runCodexTask({
    prompt: 'do the task',
    sandbox: 'workspace-write',
    cd: env.cd,
    schemaFile: env.schemaFile,
    outputLastMessage: env.outputLastMessage,
    bin: NODE,
    program: env.fake,
    skipPreflight: true,
    env: { ...process.env, ...extraEnv },
    ...opts,
  });
}

test('runCodexTask: non-zero exit → blocked reason=exit', async () => {
  const env = mkEnv();
  try {
    const res = await runExec(env, { FAKE_MODE: 'exit' });
    assert.equal(res.status, 'blocked');
    assert.equal(res.reason, 'exit');
    assert.equal(res.process.code, 2);
  } finally { env.cleanup(); }
});

test('runCodexTask: malformed final JSON → blocked reason=malformed-json', async () => {
  const env = mkEnv();
  try {
    const res = await runExec(env, { FAKE_MODE: 'malformed' });
    assert.equal(res.status, 'blocked');
    assert.equal(res.reason, 'malformed-json');
  } finally { env.cleanup(); }
});

test('runCodexTask: missing final output file → blocked reason=missing-final-output', async () => {
  const env = mkEnv();
  try {
    const res = await runExec(env, { FAKE_MODE: 'missing' });
    assert.equal(res.status, 'blocked');
    assert.equal(res.reason, 'missing-final-output');
  } finally { env.cleanup(); }
});

test('runCodexTask: off-schema final output → blocked reason=schema-invalid', async () => {
  const env = mkEnv();
  try {
    const res = await runExec(env, { FAKE_MODE: 'schema' });
    assert.equal(res.status, 'blocked');
    assert.equal(res.reason, 'schema-invalid');
  } finally { env.cleanup(); }
});

test('runCodexTask: timeout → blocked reason=timeout, group terminated', async () => {
  const env = mkEnv();
  try {
    const res = await runExec(env, { FAKE_MODE: 'hang' }, { timeoutMs: 250 });
    assert.equal(res.status, 'blocked');
    assert.equal(res.reason, 'timeout');
    assert.equal(res.process.timedOut, true);
    assert.equal(alive(res.process.pid), false);
  } finally { env.cleanup(); }
});

test('runCodexTask: cancellation → blocked reason=cancelled, group terminated', async () => {
  const env = mkEnv();
  const ac = new AbortController();
  try {
    const p = runExec(env, { FAKE_MODE: 'hang' }, { timeoutMs: 5000, signal: ac.signal });
    await sleep(150);
    ac.abort();
    const res = await p;
    assert.equal(res.status, 'blocked');
    assert.equal(res.reason, 'cancelled');
    assert.equal(alive(res.process.pid), false);
  } finally { env.cleanup(); }
});

test('runCodexTask: output ceiling → blocked reason=output-ceiling, group terminated', async () => {
  const env = mkEnv();
  try {
    const res = await runExec(env, { FAKE_MODE: 'ceiling' }, { timeoutMs: 5000, maxOutputBytes: 1024 });
    assert.equal(res.status, 'blocked');
    assert.equal(res.reason, 'output-ceiling');
    assert.equal(alive(res.process.pid), false);
  } finally { env.cleanup(); }
});

test('runCodexTask: surviving descendant → blocked and the leaked process is killed', async () => {
  const env = mkEnv();
  const pidFile = join(env.dir, 'gc.pid');
  try {
    const res = await runExec(env, { FAKE_MODE: 'descendant', FAKE_DESC_PIDFILE: pidFile }, { timeoutMs: 5000 });
    assert.equal(res.status, 'blocked');
    assert.equal(res.reason, 'surviving-descendant');
    await sleep(100);
    const gcPid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.equal(alive(gcPid), false, 'leaked descendant must be killed with the group');
  } finally { env.cleanup(); }
});

// ── argv/forbidden-flag fail-closed at the adapter boundary ─────────────────────────────────────────

test('runCodexTask: rejects an unsafe sandbox before spawning anything', async () => {
  const env = mkEnv();
  try {
    const res = await EXEC.runCodexTask({
      prompt: 'x', sandbox: 'danger-full-access', cd: env.cd, schemaFile: env.schemaFile, outputLastMessage: env.outputLastMessage,
      bin: NODE, program: env.fake, skipPreflight: true,
      env: { ...process.env, FAKE_MODE: 'ok', FAKE_RECORD_ARGV: env.argvFile },
    });
    assert.equal(res.status, 'blocked');
    assert.equal(res.reason, 'usage');
    assert.equal(res.stage, 'argv');
    assert.ok(!existsSync(env.argvFile), 'no exec may run when argv building fails');
  } finally { env.cleanup(); }
});

test('runCodexTask: empty prompt is a usage block (never spawns)', async () => {
  const env = mkEnv();
  try {
    const res = await EXEC.runCodexTask({
      prompt: '', sandbox: 'read-only', cd: env.cd, schemaFile: env.schemaFile, outputLastMessage: env.outputLastMessage,
      bin: NODE, program: env.fake, skipPreflight: true,
    });
    assert.equal(res.status, 'blocked');
    assert.equal(res.reason, 'usage');
  } finally { env.cleanup(); }
});
