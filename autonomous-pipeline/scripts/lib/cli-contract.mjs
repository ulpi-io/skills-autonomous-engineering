// cli-contract.mjs — the SINGLE SOURCE OF TRUTH for the Codex-native pipeline coordinator's
// external contracts. Zero-dependency, pure (no I/O, no process.exit) so it is trivially testable
// and every caller pins the same behavior. Three contracts live here:
//
//   (a) buildCodexArgv()  — the EXACT Codex executor argv, built as a string[] (NEVER a shell
//       string). Global flags come BEFORE `exec`, the prompt is passed ONLY via stdin (trailing
//       `-`), and every unsafe flag / sandbox / interpolation is REJECTED (fail closed).
//   (b) parseCli() + parseRunConfig()/parseCanonicalPlan() — the public pipeline CLI grammar (five
//       forms only) and the payload validators. emit()/assertSingleStdoutObject() enforce the
//       one-object-on-stdout JSON rule (diagnostics belong on stderr).
//   (c) EXIT / EXIT_TABLE — the pinned exit-code table.
//
// See ../../references/cli-contract.md for the human-readable spec.

// ── pinned exit-code table ────────────────────────────────────────────────
// 1 is DELIBERATELY absent: it is reserved for an unexpected crash / uncaught throw, never a
// pinned meaning. A caller that wants to signal one of these conditions MUST use its pinned code.
export const EXIT = Object.freeze({
  SUCCESS: 0,    // success / converged
  USAGE: 2,      // usage / config / schema error
  PREFLIGHT: 3,  // preflight / drift / approval-refusal
  BLOCKED: 4,    // blocked / non-converged gate
  BUDGET: 5,     // budget / no-progress / escalation
  CHECKPOINT: 6, // checkpoint / control I/O or corruption
  DRIFT: 7,      // target drift / integration / publication conflict
});

export const EXIT_TABLE = Object.freeze({
  0: 'success / converged',
  2: 'usage / config / schema error',
  3: 'preflight / drift / approval-refusal',
  4: 'blocked / non-converged gate',
  5: 'budget / no-progress / escalation',
  6: 'checkpoint / control I/O or corruption',
  7: 'target drift / integration / publication conflict',
});

// ── error type ────────────────────────────────────────────────────────────
export class CliContractError extends Error {
  constructor(message, code = EXIT.USAGE) {
    super(message);
    this.name = 'CliContractError';
    this.code = code; // one of the pinned EXIT codes
  }
}
const usage = (m) => { throw new CliContractError(m, EXIT.USAGE); };

// ── Codex executor contract ───────────────────────────────────────────────
export const CODEX_BIN = 'codex';
export const VALID_SANDBOXES = Object.freeze(['read-only', 'workspace-write']);
// Flags that MUST NEVER appear — each one either escalates privilege, bypasses the approval/sandbox
// gate, widens the filesystem scope, reaches the network, or defeats git-repo/ignore safety.
export const FORBIDDEN_CODEX_FLAGS = Object.freeze([
  '--dangerously-bypass-approvals-and-sandbox',
  '--add-dir',
  '--search',
  '--skip-git-repo-check',
  '--ignore-rules',
]);
const FORBIDDEN_SANDBOX = 'danger-full-access';
const CODEX_OPT_KEYS = Object.freeze(['sandbox', 'cd', 'schemaFile', 'outputLastMessage']);

// A value that will be placed literally into the argv array. Because we exec an argv (no shell),
// injection is structurally impossible — but we still fail closed on any interpolation/shell
// metacharacter or flag-looking value as defense in depth and to catch smuggling bugs upstream.
const SHELL_META = /[$`;|&<>()\n\r\t\0\\'"*?{}!~ ]/; // whitespace + shell/glob/interp chars
function assertSafeValue(v, label) {
  if (typeof v !== 'string' || v.length === 0) usage(`${label} must be a non-empty string`);
  if (v.startsWith('-')) usage(`${label} must not look like a flag: ${JSON.stringify(v)}`);
  if (SHELL_META.test(v)) usage(`${label} contains an unsafe/interpolation character: ${JSON.stringify(v)}`);
}
function assertAbsolutePath(v, label) {
  assertSafeValue(v, label);
  if (!v.startsWith('/')) usage(`${label} must be an absolute path: ${JSON.stringify(v)}`);
  if (v.split('/').includes('..')) usage(`${label} must not contain a '..' traversal segment`);
}

export function buildCodexArgv(opts) {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) usage('buildCodexArgv requires an options object');
  for (const k of Object.keys(opts)) if (!CODEX_OPT_KEYS.includes(k)) usage(`unknown Codex option: ${k}`);
  const { sandbox, cd, schemaFile, outputLastMessage } = opts;

  if (!VALID_SANDBOXES.includes(sandbox)) {
    if (sandbox === FORBIDDEN_SANDBOX) usage(`sandbox '${FORBIDDEN_SANDBOX}' is forbidden`);
    usage(`sandbox must be one of ${VALID_SANDBOXES.join(' | ')} (got ${JSON.stringify(sandbox)})`);
  }
  assertAbsolutePath(cd, '--cd');
  assertAbsolutePath(schemaFile, '--output-schema');
  assertAbsolutePath(outputLastMessage, '--output-last-message');

  const argv = [
    CODEX_BIN,
    '--ask-for-approval', 'never',   // global: no interactive approval prompts
    '--sandbox', sandbox,            // global: pinned sandbox tier
    '--cd', cd,                      // global: run inside the isolated worktree
    'exec',                          // ── subcommand boundary ──
    '--ephemeral',                   // exec: no persisted session
    '--ignore-user-config',          // exec: ignore ~/.codex config
    '--json',                        // exec: machine-readable event stream
    '--output-schema', schemaFile,   // exec: constrain the final message to our schema
    '--output-last-message', outputLastMessage,
    '-',                             // exec: read the prompt from STDIN
  ];

  // final belt-and-suspenders: no forbidden flag may have slipped in via a value.
  for (const f of FORBIDDEN_CODEX_FLAGS) if (argv.includes(f)) usage(`forbidden Codex flag present: ${f}`);
  return argv;
}

// ── pipeline CLI grammar ──────────────────────────────────────────────────
export const PIPELINE_COMMANDS = Object.freeze(['approve', 'start', 'resume', 'status', 'authorize']);
export const AUTHORIZE_ACTIONS = Object.freeze(['ship', 'deploy', 'publish', 'remote-merge']);

// per-command flag spec: value flags carry a value; `json` is a boolean switch.
const COMMAND_SPEC = Object.freeze({
  approve:   { value: ['plan', 'config'], bool: ['json'] },
  start:     { value: ['run'], bool: ['json'] },
  resume:    { value: ['run'], bool: ['json'] },
  status:    { value: ['run'], bool: ['json'] },
  authorize: { value: ['run', 'action'], bool: ['json'] },
});

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/; // no leading dash/dot, no traversal, no injection
function assertSafeId(v, label) {
  if (typeof v !== 'string' || !SAFE_ID.test(v) || v.includes('..')) usage(`${label} is not a safe id: ${JSON.stringify(v)}`);
}

export function parseCli(argv) {
  if (!Array.isArray(argv) || argv.length === 0) usage('no command given');
  const [command, ...rest] = argv;
  const spec = COMMAND_SPEC[command];
  if (!spec) usage(`unknown command '${command}' (expected one of ${PIPELINE_COMMANDS.join(', ')})`);

  const valueFlags = new Set(spec.value);
  const boolFlags = new Set(spec.bool);
  const seen = new Set();
  const out = { command, json: false };

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (typeof tok !== 'string' || !tok.startsWith('--')) usage(`unexpected positional argument: ${JSON.stringify(tok)}`);
    let name = tok.slice(2);
    let inlineVal;
    const eq = name.indexOf('=');
    if (eq !== -1) { inlineVal = name.slice(eq + 1); name = name.slice(0, eq); }

    if (boolFlags.has(name)) {
      if (inlineVal !== undefined) usage(`--${name} is a boolean flag and takes no value`);
      if (seen.has(name)) usage(`duplicate flag --${name}`);
      seen.add(name);
      out[name] = true;
      continue;
    }
    if (valueFlags.has(name)) {
      if (seen.has(name)) usage(`duplicate flag --${name}`);
      seen.add(name);
      let val = inlineVal;
      if (val === undefined) {
        val = rest[++i];
        if (val === undefined) usage(`--${name} requires a value`);
      }
      out[name] = val;
      continue;
    }
    usage(`unknown flag --${name} for command '${command}'`);
  }

  // required flags = every value flag for the command.
  for (const f of spec.value) if (!(f in out)) usage(`missing required flag --${f} for command '${command}'`);

  // typed validation of the values we accepted.
  if ('run' in out) assertSafeId(out.run, '--run');
  if ('action' in out) { if (!AUTHORIZE_ACTIONS.includes(out.action)) usage(`--action must be one of ${AUTHORIZE_ACTIONS.join(' | ')} (got ${JSON.stringify(out.action)})`); }
  if ('plan' in out) assertAbsolutePath(out.plan, '--plan');
  if ('config' in out) assertAbsolutePath(out.config, '--config');

  return out;
}

// ── payload validators ────────────────────────────────────────────────────
function parseJsonStrict(text, label) {
  if (typeof text !== 'string') usage(`${label} must be a JSON string`);
  try { return JSON.parse(text); }
  catch (e) { usage(`${label} is not valid JSON: ${e.message}`); }
}
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function parseRunConfig(text) {
  const cfg = parseJsonStrict(text, 'run config');
  if (!isPlainObject(cfg)) usage('run config must be a JSON object');
  return cfg;
}

export function parseCanonicalPlan(text) {
  const plan = parseJsonStrict(text, 'canonical plan');
  if (!isPlainObject(plan)) usage('canonical plan must be a JSON object');
  if (!Array.isArray(plan.tasks)) usage('canonical plan must have a `tasks` array');
  if (!Array.isArray(plan.layers)) usage('canonical plan must have a `layers` array');
  return plan;
}

// ── one-object-on-stdout JSON rule ────────────────────────────────────────
// JSON mode emits EXACTLY ONE final object on stdout (single line, no trailing newline embedded).
export function emit(obj) {
  if (!isPlainObject(obj)) throw new CliContractError('emit requires a plain object', EXIT.USAGE);
  return JSON.stringify(obj);
}

// Verifies a captured stdout string is exactly one JSON object and nothing else (no logs, no second
// object, no array/scalar). Used by the CLI's self-check and by tests to prove no contamination.
export function assertSingleStdoutObject(stdout) {
  if (typeof stdout !== 'string' || stdout.trim().length === 0) usage('stdout is empty — expected a single JSON object');
  let obj;
  try { obj = JSON.parse(stdout); }
  catch { usage('stdout is not a single JSON object (contaminated with non-JSON or multiple values)'); }
  if (!isPlainObject(obj)) usage('stdout payload must be a JSON object (not an array or scalar)');
  return obj;
}
