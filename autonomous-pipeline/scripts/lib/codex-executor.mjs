// codex-executor.mjs — the Codex adapter for the Codex-native pipeline coordinator.
//
// It turns "run this engineering task under Codex" into a SAFE, PINNED, VERIFIABLE process invocation
// and a TYPED result — never a raw exec, never a fabricated success:
//
//   1. PREFLIGHT (fail-closed). Before any task runs we confirm the local `codex` is the PINNED version
//      and still exposes every flag our argv depends on. A drifted / missing binary blocks the run with
//      a PREFLIGHT reason — we never fall back to a bypass flag or a different flag shape.
//   2. EXACT ARGV via cli-contract.buildCodexArgv(). Global flags before `exec`, the prompt ONLY on
//      stdin, and the whole forbidden set (`--dangerously-bypass-approvals-and-sandbox`, `--add-dir`,
//      `--search`, `--skip-git-repo-check`, `--ignore-rules`) structurally impossible. A defense-in-depth
//      scan re-asserts none slipped in.
//   3. STRICT final output. Codex writes its final message (constrained by our JSON schema) to the
//      `--output-last-message` file; we require that file to exist, parse as JSON, and satisfy the
//      engineer-output shape (role / evidence / usage). A missing file, malformed JSON, or off-schema
//      object is BLOCKED — not silently accepted.
//   4. TYPED failure. Non-zero exit, timeout, cancellation, output-ceiling, or a leaked descendant all
//      arrive from process-runner as a blocked result and are surfaced verbatim with the group already
//      terminated.
//
// Zero external deps. Node 22+.

import { readFileSync, existsSync } from 'node:fs';
import {
  buildCodexArgv, CODEX_BIN, FORBIDDEN_CODEX_FLAGS,
} from './cli-contract.mjs';
import { runProcess } from './process-runner.mjs';

// The Codex CLI version this adapter is pinned to. A different local version blocks preflight — the
// coordinator must be re-pinned deliberately, never drift silently onto an unverified CLI.
export const PINNED_CODEX_VERSION = '0.44.0';

// Every flag our argv depends on. Preflight requires the binary's help to mention ALL of them; a
// missing flag means the local CLI cannot honor our pinned invocation → block.
export const REQUIRED_CODEX_FLAGS = Object.freeze([
  '--ask-for-approval',
  '--sandbox',
  '--cd',
  '--ephemeral',
  '--ignore-user-config',
  '--json',
  '--output-schema',
  '--output-last-message',
]);

const SEMVER_RE = /(\d+\.\d+\.\d+)/;

function blocked(fields) {
  return {
    status: 'blocked', ok: false, blocked: true,
    role: null, evidence: null, usage: null,
    ...fields,
  };
}

// Distil the process-runner result into the metadata we always attach to a Codex result.
function processMeta(res) {
  return {
    code: res.code,
    signal: res.signal,
    reason: res.reason,
    timedOut: res.timedOut,
    cancelled: res.cancelled,
    killed: res.killed,
    truncated: res.truncated,
    durationMs: res.durationMs,
    pid: res.pid,
  };
}

// The engineer-output contract the Codex final message must satisfy. This is the STRUCTURAL gate the
// schema file enforces server-side; we re-check it here because a local CLI could be stubbed/patched.
function validateEngineerOutput(o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return { ok: false, error: 'final output is not a JSON object' };
  if (typeof o.role !== 'string' || o.role.length === 0) return { ok: false, error: 'final output missing string `role`' };
  if (!Array.isArray(o.evidence)) return { ok: false, error: 'final output missing `evidence` array' };
  if (o.usage === null || typeof o.usage !== 'object' || Array.isArray(o.usage)) return { ok: false, error: 'final output missing `usage` object' };
  return { ok: true };
}

// ── preflight ───────────────────────────────────────────────────────────────────────────────────────
// Confirm the local codex is the pinned version AND still exposes every required flag. Any failure —
// including a missing/unspawnable binary — returns { ok:false, reason, detail } so the caller blocks.
export async function preflightCodex({
  bin = CODEX_BIN,
  program,
  cwd,
  env,
  expectedVersion = PINNED_CODEX_VERSION,
  timeoutMs = 15_000,
  maxOutputBytes = 1 * 1024 * 1024,
  signal,
} = {}) {
  // `program`, when set, is a leading arg prepended to every invocation — the seam that lets `bin` be a
  // runtime (`node <fake-codex.mjs> …`) in tests or a wrapper interpreter in an unusual install. In
  // production `program` is unset and `bin` IS the codex executable.
  const lead = program == null ? [] : [program];
  // (a) version
  const ver = await runProcess({ file: bin, args: [...lead, '--version'], cwd, env, stdin: '', timeoutMs, maxOutputBytes, signal });
  if (ver.status !== 'ok') {
    return { ok: false, reason: 'preflight-unavailable', detail: `codex --version failed: ${ver.reason || ver.error || 'unknown'}`, process: processMeta(ver) };
  }
  const m = SEMVER_RE.exec(ver.stdout || '');
  const found = m ? m[1] : null;
  if (found !== expectedVersion) {
    return { ok: false, reason: 'preflight-version', detail: `pinned codex ${expectedVersion}, found ${found || 'no version in output'}` };
  }

  // (b) required flags
  const help = await runProcess({ file: bin, args: [...lead, 'exec', '--help'], cwd, env, stdin: '', timeoutMs, maxOutputBytes, signal });
  if (help.status !== 'ok') {
    return { ok: false, reason: 'preflight-unavailable', detail: `codex exec --help failed: ${help.reason || help.error || 'unknown'}`, process: processMeta(help) };
  }
  const helpText = `${help.stdout || ''}\n${help.stderr || ''}`;
  const missing = REQUIRED_CODEX_FLAGS.filter((f) => !helpText.includes(f));
  if (missing.length) {
    return { ok: false, reason: 'preflight-flags', detail: `codex is missing required flags: ${missing.join(', ')}` };
  }

  return { ok: true, version: found };
}

// ── task execution ───────────────────────────────────────────────────────────────────────────────────
// Run one engineering task under Codex. Returns either
//   { status:'ok', role, evidence, usage, output, process, version }
// or a typed blocked result { status:'blocked', reason, ... , process? }. NEVER throws for a child
// failure (only for a programming error in the CALL, surfaced by buildCodexArgv).
export async function runCodexTask(opts = {}) {
  const {
    prompt,
    sandbox,
    cd,
    schemaFile,
    outputLastMessage,
    bin = CODEX_BIN,
    program,
    cwd = cd,
    env,
    timeoutMs,
    maxOutputBytes,
    signal,
    expectedVersion = PINNED_CODEX_VERSION,
    skipPreflight = false,
  } = opts;

  if (typeof prompt !== 'string' || prompt.length === 0) {
    return blocked({ reason: 'usage', stage: 'call', detail: 'runCodexTask requires a non-empty `prompt` string' });
  }

  // Build the EXACT pinned argv first — this also fail-closes on any unsafe value / forbidden flag.
  let argv;
  try {
    argv = buildCodexArgv({ sandbox, cd, schemaFile, outputLastMessage });
  } catch (err) {
    return blocked({ reason: 'usage', stage: 'argv', detail: String((err && err.message) || err) });
  }

  // Defense in depth: the bypass flag (and the rest of the forbidden set) must never be present.
  const smuggled = FORBIDDEN_CODEX_FLAGS.filter((f) => argv.includes(f));
  if (smuggled.length) {
    return blocked({ reason: 'forbidden-flag', stage: 'argv', detail: `forbidden Codex flag present: ${smuggled.join(', ')}` });
  }

  // Preflight the binary unless the caller already vouched for it this run.
  if (!skipPreflight) {
    const pf = await preflightCodex({ bin, program, cwd, env, expectedVersion, signal });
    if (!pf.ok) {
      return blocked({ reason: pf.reason, stage: 'preflight', detail: pf.detail, process: pf.process });
    }
  }

  // argv[0] is the pinned bin NAME ('codex'); the executable we spawn is `bin` (identical in prod, a
  // fake fixture under test). The remaining tokens are the exact pinned arguments.
  const args = program == null ? argv.slice(1) : [program, ...argv.slice(1)];
  const res = await runProcess({ file: bin, args, cwd, env, stdin: prompt, timeoutMs, maxOutputBytes, signal });
  if (res.status !== 'ok') {
    return blocked({ reason: res.reason, stage: 'exec', detail: res.error || `codex exec ${res.reason}`, process: processMeta(res), stdout: res.stdout, stderr: res.stderr });
  }

  // Require the schema-constrained final message file.
  if (!existsSync(outputLastMessage)) {
    return blocked({ reason: 'missing-final-output', stage: 'output', detail: `codex wrote no final message at ${outputLastMessage}`, process: processMeta(res) });
  }
  let raw;
  try { raw = readFileSync(outputLastMessage, 'utf8'); }
  catch (err) { return blocked({ reason: 'missing-final-output', stage: 'output', detail: `cannot read final message: ${String((err && err.message) || err)}`, process: processMeta(res) }); }

  let obj;
  try { obj = JSON.parse(raw); }
  catch (err) { return blocked({ reason: 'malformed-json', stage: 'output', detail: `final message is not valid JSON: ${String((err && err.message) || err)}`, process: processMeta(res) }); }

  const v = validateEngineerOutput(obj);
  if (!v.ok) {
    return blocked({ reason: 'schema-invalid', stage: 'output', detail: v.error, process: processMeta(res) });
  }

  return {
    status: 'ok', ok: true, blocked: false,
    role: obj.role,
    evidence: obj.evidence,
    usage: obj.usage,
    output: obj,
    process: processMeta(res),
    version: expectedVersion,
  };
}
