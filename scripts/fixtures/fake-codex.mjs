#!/usr/bin/env node
// fake-codex.mjs — a ZERO-NETWORK stand-in for the `codex` CLI, faithful to the pipeline coordinator's
// cli-contract argv (autonomous-pipeline/scripts/lib/cli-contract.mjs) and codex-executor.mjs preflight.
//
// It answers the exact three shapes the coordinator invokes:
//   1. `<fake> --version`               → prints the PINNED version so preflight's version gate passes.
//   2. `<fake> exec --help`             → lists every REQUIRED_CODEX_FLAG so preflight's flag gate passes.
//   3. `<fake> … exec … --output-last-message <f> -`
//         → the real task run. It first VERIFIES the pinned argv contract (global flags before `exec`,
//           the prompt on stdin via a trailing `-`, `--ask-for-approval never`, a valid `--sandbox`, and
//           the three `exec` flags) — exiting non-zero on any violation so a smuggled/incorrect argv
//           surfaces as a blocked task — then WRITES the task's single in-scope file into the isolated
//           worktree (`--cd`) and a schema-conforming final message to `--output-last-message`.
//
// Deterministic behavior is driven ENTIRELY by fixture env/config, never by plan/config bytes (so a test
// can flip a task from red→green between start and resume WITHOUT tripping the coordinator's drift gate):
//   • FAKE_CODEX_TASK    — the task id this invocation is implementing (chooses the file it writes).
//   • FAKE_CODEX_CONTROL — path to a JSON control file `{ "redTasks": ["<id>", …] }`. A task listed there
//                          is written with a `MODE:RED` marker (the coordinator's independent slice-validate
//                          then goes red and integration is refused) — the FORCED-RED result. Any other task
//                          is written `MODE:OK`.
//
// Zero external deps (node: builtins only).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

// The version codex-executor.mjs pins to (PINNED_CODEX_VERSION). Kept in lock-step by CI parity checks.
const PINNED_VERSION = '0.44.0';
// Every flag codex-executor.mjs requires the binary's `exec --help` to advertise (REQUIRED_CODEX_FLAGS).
const REQUIRED_FLAGS = [
  '--ask-for-approval', '--sandbox', '--cd', '--ephemeral',
  '--ignore-user-config', '--json', '--output-schema', '--output-last-message',
];

const argv = process.argv.slice(2);

// Drain stdin (the prompt) — the coordinator feeds it and closes it. Never fail if it is empty/closed.
function drainStdin() { try { return readFileSync(0, 'utf8'); } catch { return ''; } }
const valueOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; };
const die = (code, msg) => { process.stderr.write(`fake-codex: ${msg}\n`); process.exit(code); };

// ── (1) preflight: version ────────────────────────────────────────────────────────────────────────────
if (argv.includes('--version')) {
  process.stdout.write(`codex-cli ${PINNED_VERSION}\n`);
  process.exit(0);
}

// ── (2) preflight: `exec --help` advertises every required flag ─────────────────────────────────────────
if (argv.includes('--help')) {
  process.stdout.write(`Usage: codex exec [options]\n${REQUIRED_FLAGS.map((f) => `  ${f} <value>`).join('\n')}\n`);
  process.exit(0);
}

// ── (3) exec: verify the pinned argv contract, then act ─────────────────────────────────────────────────
const problems = [];
if (!argv.includes('exec')) problems.push("missing 'exec' subcommand");
if (argv[argv.length - 1] !== '-') problems.push("prompt must be read from stdin (trailing '-')");
if (valueOf('--ask-for-approval') !== 'never') problems.push('--ask-for-approval must be never');
const sandbox = valueOf('--sandbox');
if (sandbox !== 'workspace-write' && sandbox !== 'read-only') problems.push(`invalid --sandbox ${JSON.stringify(sandbox)}`);
for (const f of ['--ephemeral', '--ignore-user-config', '--json']) if (!argv.includes(f)) problems.push(`missing ${f}`);
// The `exec` subcommand boundary: global flags must precede it, exec flags must follow it.
const execIdx = argv.indexOf('exec');
if (execIdx >= 0) {
  if (argv.slice(0, execIdx).includes('--output-schema')) problems.push('--output-schema must come AFTER exec');
  if (argv.slice(execIdx).includes('--cd')) problems.push('--cd (global) must come BEFORE exec');
}
const cd = valueOf('--cd');
const schemaFile = valueOf('--output-schema');
const outFile = valueOf('--output-last-message');
if (!cd) problems.push('missing --cd');
if (!schemaFile) problems.push('missing --output-schema');
if (!outFile) problems.push('missing --output-last-message');
if (problems.length) die(3, `argv contract violation: ${problems.join('; ')}`);

drainStdin();

const task = process.env.FAKE_CODEX_TASK || 'task';
let control = {};
const controlPath = process.env.FAKE_CODEX_CONTROL;
if (controlPath && existsSync(controlPath)) {
  try { control = JSON.parse(readFileSync(controlPath, 'utf8')); } catch { control = {}; }
}
const redTasks = Array.isArray(control.redTasks) ? control.redTasks : [];
const mode = redTasks.includes(task) ? 'RED' : 'OK';

// Write the task's single in-scope file INTO THE ISOLATED WORKTREE (--cd). The `MODE:` marker is what the
// coordinator's independent slice-validate keys on — a RED marker makes that validation fail (forced red).
const rel = join('src', `${task}.js`);
const abs = join(cd, rel);
mkdirSync(dirname(abs), { recursive: true });
const ident = String(task).replace(/[^A-Za-z0-9_$]/g, '_');
writeFileSync(abs, `export const ${ident} = ${JSON.stringify(task)};\n// MODE:${mode}\n`);

// Write the schema-conforming final message (engineer-output shape: role/evidence/usage) that
// codex-executor.mjs validates before accepting the run.
const finalMessage = {
  role: 'engineer',
  evidence: [{ type: 'file', path: rel, mode }],
  usage: { model: 'fake-codex', input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};
writeFileSync(outFile, `${JSON.stringify(finalMessage, null, 2)}\n`);
process.exit(0);
