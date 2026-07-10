#!/usr/bin/env node
// smoke-codex-plugin.mjs — the ISOLATED real-Codex plugin smoke gate (TASK-049).
//
// It drives the whole Codex plugin lifecycle end-to-end and returns REDACTED evidence, never a
// fabricated clean:
//
//   package (scripts/package-codex-plugin.mjs)  →  `codex plugin marketplace add` / `… list`
//     →  `codex plugin add <plugin>@<market>` / `… list`  →  a NEW ephemeral READ-ONLY session that
//     explicitly invokes the installed `$autonomous-engineering:<skill>` identifier against an output
//     schema, with hook-trust handled honestly (untrusted hooks skipped/warned first).
//
// TWO MODES
//   DEFAULT (fake)  — zero-network, no real Codex. A self-contained FAKE `codex` CLI (materialized into
//                     the temp CODEX_HOME) proves version preflight, temp CODEX_HOME + temp git-fixture
//                     ISOLATION, marketplace add/list, plugin add/list, new-session argv/env, cleanup,
//                     failure propagation, and SECRET REDACTION in evidence. This is what CI runs.
//   --live          — the real `codex` CLI, GATED. Preflight requires the pinned version AND an operable
//                     CLI; an unavailable CLI / auth / version returns nonzero `gateNotRun` — NEVER a
//                     fabricated clean. It asserts exact plugin/version/install-root + 18 catalog
//                     entries, then a NEW ephemeral read-only session (WITHOUT --ignore-user-config, so
//                     the installed plugin loads from the temp CODEX_HOME) invoking the skill against a
//                     schema. It FIRST proves untrusted hooks are skipped/warned, and permits
//                     `--dangerously-bypass-hook-trust` ONLY after matching vetted hook + artifact
//                     hashes; it NEVER bypasses approvals or the sandbox.
//
// ISOLATION INVARIANTS (both modes): every Codex invocation runs with CODEX_HOME pinned to a fresh temp
// dir and HOME pinned to the temp work dir — the user's real config is never read or written. The
// session's --cd points at a THROWAWAY git fixture, never the real repo. The packager writes ONLY under
// a temp --out outside the source repo. All temp state is removed on cleanup (unless {keep:true}).
//
// Zero external deps (node: builtins only). Node 22+.

import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const PACKAGER = join(SCRIPT_DIR, 'package-codex-plugin.mjs');

// The Codex CLI version the collection is pinned to — kept in lock-step with codex-executor.mjs's
// PINNED_CODEX_VERSION. A different local version blocks the LIVE preflight (→ gateNotRun).
export const PINNED_CODEX_VERSION = '0.44.0';
const PLUGIN_NAME = 'autonomous-engineering';
const EXPECTED_ADAPTERS = 18;
const SEMVER_RE = /(\d+\.\d+\.\d+)/;

// ── secret redaction ────────────────────────────────────────────────────────────────────────────────
// Evidence is written to disk / logs; it must NEVER carry a live credential. We redact both by shape
// (known token formats) and by value (the concrete values of any secret-named env var in scope).
const SECRET_NAME_RE = /(_KEY|_TOKEN|_SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY|AUTH)/i;
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{6,}\b/g,                                        // OpenAI-style
  /\bghp_[A-Za-z0-9]{10,}\b/g,                                        // GitHub PAT (classic)
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,                               // GitHub PAT (fine-grained)
  /\bxox[baprs]-[A-Za-z0-9-]{6,}\b/g,                                // Slack
  /\bAKIA[0-9A-Z]{16}\b/g,                                            // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/g,                                            // AWS temp access key id
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._-]{6,}/gi,                                  // bearer tokens
];
export const REDACTION_MARK = '***REDACTED***';

// Redact a string by shape and by an explicit set of secret values.
export function redactSecrets(input, extraValues = []) {
  if (input == null) return input;
  let s = String(input);
  for (const re of SECRET_PATTERNS) s = s.replace(re, REDACTION_MARK);
  // Longest-first so a value that is a substring of another is handled deterministically.
  for (const v of [...extraValues].filter((x) => typeof x === 'string' && x.length >= 6).sort((a, b) => b.length - a.length)) {
    s = s.split(v).join(REDACTION_MARK);
  }
  return s;
}

// Deep-redact every string in a JSON-able value.
export function redactDeep(value, extraValues = []) {
  return JSON.parse(redactSecrets(JSON.stringify(value ?? null), extraValues));
}

// Collect the secret VALUES present in an env map (values of secret-named keys).
function secretValuesFromEnv(env) {
  const out = [];
  for (const [k, v] of Object.entries(env || {})) {
    if (SECRET_NAME_RE.test(k) && typeof v === 'string' && v.length >= 6) out.push(v);
  }
  return out;
}

// ── the FAKE codex CLI (materialized into the temp home for the default path) ─────────────────────────
// A faithful stand-in for `codex` covering exactly the plugin lifecycle this gate drives. It keeps ALL
// state under $CODEX_HOME (proving the driver's isolation), validates the pinned session argv contract,
// models hook-trust (untrusted → skipped/warned unless an explicit bypass is present), and writes a
// schema-conforming session outcome. Behaviour is driven ONLY by argv + env (never by ambient state), so
// it is deterministic. NO template literals / no `${` / no backticks below — it is embedded verbatim.
const FAKE_CODEX_SRC = [
  "#!/usr/bin/env node",
  "'use strict';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const argv = process.argv.slice(2);",
  "const env = process.env;",
  "const home = env.CODEX_HOME || '';",
  "function die(code, msg) { process.stderr.write('fake-codex: ' + msg + '\\n'); process.exit(code); }",
  "function has(f) { return argv.indexOf(f) >= 0; }",
  "function valueOf(f) { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; }",
  "function positionals() { const out = []; for (let i = 0; i < argv.length; i++) { const a = argv[i];",
  "  if (a === '--version' || a === '--json') continue;",
  "  if (a.charAt(0) === '-') { if (a !== '-') { i++; } continue; } out.push(a); } return out; }",
  "function statePath() { return path.join(home, 'state.json'); }",
  "function loadState() { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch (e) { return { marketplaces: {}, plugins: {} }; } }",
  "function saveState(s) { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(statePath(), JSON.stringify(s, null, 2)); }",
  "function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }",
  "const PIN = env.FAKE_CODEX_VERSION || '0.44.0';",
  "// preflight: version",
  "if (has('--version') && argv.indexOf('exec') < 0 && positionals().length === 0) { process.stdout.write('codex-cli ' + PIN + '\\n'); process.exit(0); }",
  "// session (exec) path",
  "if (argv.indexOf('exec') >= 0) {",
  "  const problems = [];",
  "  if (argv[argv.length - 1] !== '-') problems.push('prompt must be read from stdin (trailing -)');",
  "  if (valueOf('--ask-for-approval') !== 'never') problems.push('--ask-for-approval must be never');",
  "  if (valueOf('--sandbox') !== 'read-only') problems.push('smoke session sandbox must be read-only');",
  "  if (!has('--ephemeral')) problems.push('missing --ephemeral (new ephemeral session)');",
  "  if (has('--ignore-user-config')) problems.push('--ignore-user-config must NOT be set (plugin loads from CODEX_HOME)');",
  "  if (has('--dangerously-bypass-approvals-and-sandbox')) problems.push('approvals/sandbox bypass is forbidden');",
  "  const cd = valueOf('--cd'); if (!cd) problems.push('missing --cd');",
  "  const schemaFile = valueOf('--output-schema'); if (!schemaFile) problems.push('missing --output-schema');",
  "  const outFile = valueOf('--output-last-message'); if (!outFile) problems.push('missing --output-last-message');",
  "  const skill = valueOf('--skill'); if (!skill) problems.push('missing --skill selector');",
  "  if (problems.length) die(3, 'session argv contract: ' + problems.join('; '));",
  "  try { fs.readFileSync(0, 'utf8'); } catch (e) { /* stdin optional */ }",
  "  // resolve the $plugin:skill selector against installed state",
  "  const sel = String(skill);",
  "  const noDollar = sel.charAt(0) === '$' ? sel.slice(1) : sel;",
  "  const colon = noDollar.indexOf(':');",
  "  if (colon < 0) die(7, 'skill selector must be $plugin:skill, got ' + sel);",
  "  const plugName = noDollar.slice(0, colon); const skillName = noDollar.slice(colon + 1);",
  "  const st = loadState(); const plug = st.plugins[plugName];",
  "  if (!plug) die(7, 'plugin not installed: ' + plugName);",
  "  if (plug.skills.indexOf(skillName) < 0) die(7, 'skill not in installed plugin: ' + skillName);",
  "  // hook trust: untrusted hooks are skipped/warned unless an explicit bypass is present",
  "  let hookMode;",
  "  if (has('--dangerously-bypass-hook-trust')) { hookMode = 'bypassed-vetted'; }",
  "  else { hookMode = 'skipped-untrusted'; process.stderr.write('fake-codex: warning: plugin hooks are untrusted and were SKIPPED\\n'); }",
  "  // record the session argv + a MINIMAL env slice (isolation proof) for the driver to read back",
  "  const recEnv = { CODEX_HOME: env.CODEX_HOME || null, HOME: env.HOME || null };",
  "  for (const k of Object.keys(env)) { if (/(_KEY|_TOKEN|_SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY|AUTH)/i.test(k)) recEnv[k] = env[k]; }",
  "  fs.mkdirSync(home, { recursive: true });",
  "  fs.writeFileSync(path.join(home, 'last-session.json'), JSON.stringify({ argv: argv, env: recEnv, skill: sel, plugin: plugName, hookMode: hookMode }, null, 2));",
  "  // an optional simulated leak, to prove the driver redacts captured session output",
  "  if (env.FAKE_EMIT_SECRET) process.stdout.write('leak: using ' + env.FAKE_EMIT_SECRET + '\\n');",
  "  const outcome = { role: 'skill', plugin: plugName, skill: skillName, selector: sel, result: 'ok', hookMode: hookMode,",
  "    evidence: [{ type: 'invocation', skill: sel, sandbox: 'read-only' }],",
  "    usage: { model: 'fake-codex', input_tokens: 1, output_tokens: 1, total_tokens: 2 } };",
  "  fs.writeFileSync(outFile, JSON.stringify(outcome, null, 2) + '\\n');",
  "  emit({ session: 'ok', skill: sel, hookMode: hookMode });",
  "  process.exit(0);",
  "}",
  "const pos = positionals();",
  "if (pos[0] !== 'plugin') die(2, 'unknown command: ' + (pos[0] || '(none)'));",
  "// codex plugin marketplace add|list",
  "if (pos[1] === 'marketplace') {",
  "  const action = pos[2];",
  "  const st = loadState();",
  "  if (action === 'add') {",
  "    if (env.FAKE_FAIL_MARKETPLACE_ADD) die(11, 'injected failure: marketplace add');",
  "    const src = pos[3]; if (!src) die(2, 'marketplace add requires a source dir');",
  "    const mkt = path.join(src, '.agents', 'plugins', 'marketplace.json');",
  "    if (!fs.existsSync(mkt)) die(4, 'marketplace source not found: ' + mkt);",
  "    let m; try { m = JSON.parse(fs.readFileSync(mkt, 'utf8')); } catch (e) { die(4, 'invalid marketplace.json: ' + e.message); }",
  "    if (!m.name || !Array.isArray(m.plugins) || m.plugins.length < 1) die(4, 'marketplace.json has no name/plugins');",
  "    st.marketplaces[m.name] = { source: path.resolve(src), name: m.name, plugins: m.plugins };",
  "    saveState(st);",
  "    emit({ added: { marketplace: m.name, source: path.resolve(src), plugins: m.plugins.length } });",
  "    process.exit(0);",
  "  }",
  "  if (action === 'list') {",
  "    const list = Object.values(st.marketplaces).map(function (x) { return { name: x.name, source: x.source, plugins: x.plugins.length }; });",
  "    emit({ marketplaces: list });",
  "    process.exit(0);",
  "  }",
  "  die(2, 'unknown marketplace action: ' + (action || '(none)'));",
  "}",
  "// codex plugin add|list",
  "if (pos[1] === 'add') {",
  "  if (env.FAKE_FAIL_PLUGIN_ADD) die(12, 'injected failure: plugin add');",
  "  const ref = pos[2]; if (!ref || ref.indexOf('@') < 0) die(2, 'plugin add requires <plugin>@<marketplace>');",
  "  const at = ref.indexOf('@'); const plugName = ref.slice(0, at); const mktName = ref.slice(at + 1);",
  "  const st = loadState(); const mkt = st.marketplaces[mktName];",
  "  if (!mkt) die(5, 'marketplace not added: ' + mktName);",
  "  const pl = mkt.plugins.find(function (p) { return p.name === plugName; });",
  "  if (!pl) die(6, 'plugin not in marketplace: ' + plugName);",
  "  const pluginRoot = path.resolve(mkt.source, pl.source);",
  "  const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');",
  "  const catalogPath = path.join(pluginRoot, 'codex-skills', 'catalog.json');",
  "  if (!fs.existsSync(manifestPath)) die(6, 'plugin manifest missing: ' + manifestPath);",
  "  if (!fs.existsSync(catalogPath)) die(6, 'plugin catalog missing: ' + catalogPath);",
  "  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));",
  "  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));",
  "  const skills = (catalog.skills || []).map(function (s) { return s.name; });",
  "  const installRoot = path.join(home, 'plugins', mktName, plugName);",
  "  fs.mkdirSync(installRoot, { recursive: true });",
  "  st.plugins[plugName] = { version: manifest.version, installRoot: installRoot, source: pluginRoot,",
  "    count: skills.length, skills: skills, catalogVersion: catalog.version, hooksTrusted: false };",
  "  saveState(st);",
  "  emit({ installed: { plugin: plugName, version: manifest.version, installRoot: installRoot, count: skills.length, skills: skills } });",
  "  process.exit(0);",
  "}",
  "if (pos[1] === 'list') {",
  "  const st = loadState();",
  "  const list = Object.keys(st.plugins).map(function (n) { const p = st.plugins[n]; return { plugin: n, version: p.version, count: p.count, installRoot: p.installRoot }; });",
  "  emit({ plugins: list });",
  "  process.exit(0);",
  "}",
  "die(2, 'unknown plugin action: ' + (pos[1] || '(none)'));",
  "",
].join('\n');

// Materialize the fake codex CLI at <dir>/codex-fake.cjs and return its path.
export function writeFakeCodex(dir) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'codex-fake.cjs');
  writeFileSync(p, FAKE_CODEX_SRC);
  try { chmodSync(p, 0o755); } catch { /* best effort */ }
  return p;
}

// ── git helpers (source provenance via pure fs; throwaway fixture via git subprocess) ─────────────────
// Resolve <root>'s HEAD commit WITHOUT invoking git (honors the "no git commands" boundary for the
// source repo). Returns the sha or null.
export function readGitHead(root) {
  try {
    const headPath = join(root, '.git', 'HEAD');
    if (!existsSync(headPath)) return null;
    const head = readFileSync(headPath, 'utf8').trim();
    if (!head.startsWith('ref:')) return SEMVER_RE.test(head) ? head : (/^[0-9a-f]{40}$/.test(head) ? head : null);
    const ref = head.slice(4).trim();
    const loose = join(root, '.git', ref);
    if (existsSync(loose)) return readFileSync(loose, 'utf8').trim() || null;
    const packed = join(root, '.git', 'packed-refs');
    if (existsSync(packed)) {
      for (const line of readFileSync(packed, 'utf8').split('\n')) {
        const m = line.match(/^([0-9a-f]{40})\s+(.+)$/);
        if (m && m[2] === ref) return m[1];
      }
    }
    return null;
  } catch { return null; }
}

// Build a THROWAWAY git repo under <parent>/fixture for the read-only session's --cd. Never touches the
// real repo. Falls back to a plain dir (git:false) if git is unavailable.
function makeGitFixture(parent) {
  const dir = join(parent, 'fixture');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# throwaway smoke fixture\n');
  const g = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  const init = g(['init', '-q', '-b', 'main']);
  if (init.status !== 0) return { dir, git: false, commit: null };
  g(['config', 'user.email', 'smoke@example.com']);
  g(['config', 'user.name', 'Smoke']);
  g(['config', 'commit.gpgsign', 'false']);
  g(['add', '-A']);
  const commit = g(['commit', '-qm', 'base']);
  if (commit.status !== 0) return { dir, git: false, commit: null };
  const rev = g(['rev-parse', 'HEAD']);
  return { dir, git: true, commit: rev.status === 0 ? rev.stdout.trim() : null };
}

// ── process runner ────────────────────────────────────────────────────────────────────────────────────
function runCmd(file, args, { cwd, env, input, timeoutMs = 60_000 } = {}) {
  const r = spawnSync(file, args, {
    cwd, env, input: input ?? '', encoding: 'utf8', timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    code: r.status,
    signal: r.signal,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? String(r.error.message || r.error) : null,
  };
}

// Parse the LAST JSON object printed on stdout (the fake / codex --json prints one object per command).
function lastJson(stdout) {
  const lines = String(stdout).split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* keep scanning */ }
  }
  return null;
}

// The session output schema the installed skill must conform to. Written to disk so its bytes hash
// stably into resultSchemaHash.
const SESSION_OUTPUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['role', 'plugin', 'skill', 'result', 'evidence', 'usage'],
  properties: {
    role: { type: 'string' },
    plugin: { type: 'string' },
    skill: { type: 'string' },
    selector: { type: 'string' },
    result: { type: 'string' },
    hookMode: { type: 'string' },
    evidence: { type: 'array' },
    usage: { type: 'object' },
  },
  additionalProperties: true,
};

// Structural validation of the session outcome against the schema's required/type constraints.
function validateOutcome(o, schema) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return 'outcome is not a JSON object';
  for (const k of schema.required) if (!(k in o)) return `outcome missing required key '${k}'`;
  const T = schema.properties;
  const typeOk = (v, t) => t === 'array' ? Array.isArray(v)
    : t === 'object' ? (v !== null && typeof v === 'object' && !Array.isArray(v))
      : typeof v === t;
  for (const [k, spec] of Object.entries(T)) {
    if (k in o && !typeOk(o[k], spec.type)) return `outcome key '${k}' is not ${spec.type}`;
  }
  return null;
}

// ── the smoke run ─────────────────────────────────────────────────────────────────────────────────────
// Options:
//   mode            'fake' (default) | 'live'
//   repoRoot        source repo to package (default: this repo)
//   codexBin        explicit codex binary (live: 'codex'; fake: materialized). If absent + fake, the
//                   embedded fake is materialized and used.
//   workDir         parent temp dir (default: a fresh mkdtemp). Removed on cleanup unless keep=true.
//   keep            keep temp dirs (test inspection). Default false.
//   secretEnv       extra env forwarded into the SESSION (to prove redaction). Secret-named values are
//                   redacted out of evidence.
//   extraCodexEnv   extra env forwarded into EVERY codex invocation (used by tests for failure injection).
//   emitSecret      when set (string), the session prints it as a simulated leak (redaction proof).
//   timeoutMs       per-invocation timeout.
//
// Returns { status: 'ok'|'failed'|'gateNotRun', exitCode, reason?, evidence, steps, workDir, cleaned }.
export function runSmoke(opts = {}) {
  const mode = opts.mode === 'live' ? 'live' : 'fake';
  const repoRoot = resolve(opts.repoRoot || REPO_ROOT);
  const keep = !!opts.keep;
  const timeoutMs = opts.timeoutMs || 60_000;
  const extraCodexEnv = opts.extraCodexEnv || {};
  const secretEnv = opts.secretEnv || {};

  const workDir = opts.workDir ? resolve(opts.workDir) : mkdtempSync(join(tmpdir(), 'ulpi-codex-smoke-'));
  mkdirSync(workDir, { recursive: true });
  const codexHome = join(workDir, 'home');
  const marketplaceOut = join(workDir, 'marketplace');
  const controlDir = join(workDir, 'control');
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(controlDir, { recursive: true });

  const steps = [];
  const record = (step, ok, detail) => { steps.push({ step, ok, detail }); return ok; };

  // Resolve the codex runner: fake → `node <fakePath> …`; live → the real bin directly.
  let fakePath = null;
  let runCodexBase;
  if (mode === 'live') {
    const bin = opts.codexBin || 'codex';
    runCodexBase = (args, env, input) => runCmd(bin, args, { cwd: workDir, env, input, timeoutMs });
  } else {
    fakePath = opts.codexBin || writeFakeCodex(join(workDir, 'bin'));
    runCodexBase = (args, env, input) => runCmd(process.execPath, [fakePath, ...args], { cwd: workDir, env, input, timeoutMs });
  }

  // Isolated env base for every codex invocation: CODEX_HOME + HOME pinned to temp; minimal PATH.
  // The user's real config is thereby never read or written.
  const baseCodexEnv = () => ({
    PATH: process.env.PATH || '',
    HOME: workDir,
    CODEX_HOME: codexHome,
    ...(mode === 'fake' && opts.fakeVersion ? { FAKE_CODEX_VERSION: opts.fakeVersion } : {}),
    ...extraCodexEnv,
  });
  const runCodex = (args, input) => runCodexBase(args, baseCodexEnv(), input);

  const secretValues = secretValuesFromEnv(secretEnv);

  const finish = (status, reason, evidence) => {
    let cleaned = false;
    if (!keep) {
      try { rmSync(workDir, { recursive: true, force: true }); cleaned = true; } catch { /* best effort */ }
    }
    const exitCode = status === 'ok' ? 0 : status === 'gateNotRun' ? 3 : 1;
    return { status, exitCode, reason: reason || null, evidence: evidence || null, steps, workDir, cleaned };
  };

  try {
    // ── STEP 1: preflight (version + operability). Fail-closed → gateNotRun in live. ────────────────
    const ver = runCodex(['--version']);
    const verOut = `${ver.stdout}\n${ver.stderr}`;
    const m = verOut.match(SEMVER_RE);
    const codexVersion = m ? m[1] : null;
    if (ver.code !== 0 || ver.error || !codexVersion) {
      const reason = `codex --version unavailable: ${ver.error || ver.stderr.trim() || `exit ${ver.code}`}`;
      record('preflight-version', false, reason);
      if (mode === 'live') return finish('gateNotRun', reason);
      return finish('failed', reason);
    }
    if (codexVersion !== PINNED_CODEX_VERSION) {
      const reason = `codex version drift: found ${codexVersion}, pinned ${PINNED_CODEX_VERSION}`;
      record('preflight-version', false, reason);
      if (mode === 'live') return finish('gateNotRun', reason);
      return finish('failed', reason);
    }
    record('preflight-version', true, `codex ${codexVersion}`);

    // Live: an operability/auth probe. A CLI that cannot even list marketplaces (unauthenticated /
    // broken) is a gateNotRun, never a fabricated clean.
    if (mode === 'live') {
      const probe = runCodex(['plugin', 'marketplace', 'list', '--json']);
      if (probe.code !== 0 || probe.error) {
        const reason = `codex CLI not operable (auth/plugin subsystem): ${probe.error || probe.stderr.trim() || `exit ${probe.code}`}`;
        record('preflight-operable', false, reason);
        return finish('gateNotRun', reason);
      }
      record('preflight-operable', true, 'codex plugin marketplace list ok');
    }

    // ── STEP 2: package the reproducible marketplace artifact (temp --out, outside the repo). ───────
    const pkg = runCmd(process.execPath, [PACKAGER, '--root', repoRoot, '--out', marketplaceOut], {
      cwd: workDir, env: process.env, timeoutMs,
    });
    if (pkg.code !== 0) {
      const reason = `packager failed (exit ${pkg.code}): ${(pkg.stderr || pkg.stdout).trim().split('\n').slice(-1)[0]}`;
      record('package', false, reason);
      return finish('failed', reason);
    }
    const digestMatch = `${pkg.stdout}`.match(/digest=sha256:([0-9a-f]{64})/);
    const artifactSha256 = digestMatch ? `sha256:${digestMatch[1]}` : null;
    if (!artifactSha256) { record('package', false, 'no digest emitted'); return finish('failed', 'packager emitted no digest'); }
    const pluginRoot = join(marketplaceOut, 'plugins', PLUGIN_NAME);
    let manifestVersion = null; let catalogVersion = null; let catalogCount = null;
    try {
      manifestVersion = JSON.parse(readFileSync(join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8')).version;
      const cat = JSON.parse(readFileSync(join(pluginRoot, 'codex-skills', 'catalog.json'), 'utf8'));
      catalogVersion = cat.version;
      catalogCount = Array.isArray(cat.skills) ? cat.skills.length : null;
    } catch (e) {
      record('package', false, `artifact read failed: ${e.message}`);
      return finish('failed', `artifact read failed: ${e.message}`);
    }
    record('package', true, `digest ${artifactSha256}, version ${manifestVersion}, ${catalogCount} skills`);

    // ── STEP 3: marketplace add ────────────────────────────────────────────────────────────────────
    const mAdd = runCodex(['plugin', 'marketplace', 'add', marketplaceOut, '--json']);
    if (mAdd.code !== 0) {
      const reason = `marketplace add failed (exit ${mAdd.code}): ${(mAdd.stderr || mAdd.stdout).trim()}`;
      record('marketplace-add', false, reason);
      return finish('failed', reason);
    }
    const added = lastJson(mAdd.stdout);
    const marketName = added && added.added ? added.added.marketplace : null;
    if (!marketName) { record('marketplace-add', false, 'no marketplace name in output'); return finish('failed', 'marketplace add returned no name'); }
    record('marketplace-add', true, `added marketplace '${marketName}'`);

    // ── STEP 4: marketplace list (must contain our marketplace) ────────────────────────────────────
    const mList = runCodex(['plugin', 'marketplace', 'list', '--json']);
    if (mList.code !== 0) { record('marketplace-list', false, mList.stderr.trim()); return finish('failed', `marketplace list failed: ${mList.stderr.trim()}`); }
    const mkts = lastJson(mList.stdout);
    const hasMkt = mkts && Array.isArray(mkts.marketplaces) && mkts.marketplaces.some((x) => x.name === marketName);
    if (!hasMkt) { record('marketplace-list', false, `marketplace '${marketName}' absent from list`); return finish('failed', `marketplace '${marketName}' not listed`); }
    record('marketplace-list', true, `${mkts.marketplaces.length} marketplace(s) listed`);

    // ── STEP 5: plugin add (exact plugin / version / install-root + 18 catalog entries) ────────────
    const pAdd = runCodex(['plugin', 'add', `${PLUGIN_NAME}@${marketName}`, '--json']);
    if (pAdd.code !== 0) {
      const reason = `plugin add failed (exit ${pAdd.code}): ${(pAdd.stderr || pAdd.stdout).trim()}`;
      record('plugin-add', false, reason);
      return finish('failed', reason);
    }
    const installed = lastJson(pAdd.stdout);
    const inst = installed && installed.installed ? installed.installed : null;
    if (!inst) { record('plugin-add', false, 'no install descriptor'); return finish('failed', 'plugin add returned no descriptor'); }
    if (inst.plugin !== PLUGIN_NAME) { record('plugin-add', false, `plugin name mismatch: ${inst.plugin}`); return finish('failed', `installed plugin '${inst.plugin}' != '${PLUGIN_NAME}'`); }
    if (inst.version !== manifestVersion) { record('plugin-add', false, `version mismatch: ${inst.version} != ${manifestVersion}`); return finish('failed', `installed version '${inst.version}' != artifact '${manifestVersion}'`); }
    if (!inst.installRoot) { record('plugin-add', false, 'no install root'); return finish('failed', 'plugin add reported no install root'); }
    if (inst.count !== EXPECTED_ADAPTERS || !Array.isArray(inst.skills) || inst.skills.length !== EXPECTED_ADAPTERS) {
      const reason = `expected ${EXPECTED_ADAPTERS} installed skills, got ${inst.count}/${(inst.skills || []).length}`;
      record('plugin-add', false, reason);
      return finish('failed', reason);
    }
    const installRoot = inst.installRoot;
    const installedSkills = inst.skills.slice();
    record('plugin-add', true, `installed ${PLUGIN_NAME}@${marketName} v${inst.version}, ${inst.count} skills, root ${installRoot}`);

    // ── STEP 6: plugin list (installed plugin present with 18 skills) ──────────────────────────────
    const pList = runCodex(['plugin', 'list', '--json']);
    if (pList.code !== 0) { record('plugin-list', false, pList.stderr.trim()); return finish('failed', `plugin list failed: ${pList.stderr.trim()}`); }
    const plugins = lastJson(pList.stdout);
    const listedPlugin = plugins && Array.isArray(plugins.plugins) ? plugins.plugins.find((p) => p.plugin === PLUGIN_NAME) : null;
    if (!listedPlugin || listedPlugin.count !== EXPECTED_ADAPTERS) {
      const reason = `plugin '${PLUGIN_NAME}' not listed with ${EXPECTED_ADAPTERS} skills`;
      record('plugin-list', false, reason);
      return finish('failed', reason);
    }
    record('plugin-list', true, `${PLUGIN_NAME} listed with ${listedPlugin.count} skills`);

    // ── STEP 7: NEW ephemeral READ-ONLY session invoking $plugin:skill against the schema ──────────
    const fixture = makeGitFixture(workDir);
    const schemaPath = join(controlDir, 'session-schema.json');
    const schemaBytes = `${JSON.stringify(SESSION_OUTPUT_SCHEMA, null, 2)}\n`;
    writeFileSync(schemaPath, schemaBytes);
    const resultSchemaHash = createHash('sha256').update(schemaBytes).digest('hex');
    const outPath = join(controlDir, 'session-out.json');
    const invokedSkillName = installedSkills[0]; // deterministic: first catalog skill (auto-spec)
    const selector = `$${PLUGIN_NAME}:${invokedSkillName}`;

    // Session env: isolated base + any secret env the caller wants forwarded (redaction proof).
    const sessionEnv = {
      ...baseCodexEnv(),
      ...secretEnv,
      ...(opts.emitSecret ? { FAKE_EMIT_SECRET: String(opts.emitSecret) } : {}),
    };
    // Pinned session argv: read-only sandbox, approvals never, NEW ephemeral session, NO
    // --ignore-user-config (so the installed plugin resolves from the temp CODEX_HOME), an explicit
    // $plugin:skill selector, prompt on stdin. Hook trust: untrusted → skipped/warned (no bypass here).
    const sessionArgs = [
      '--ask-for-approval', 'never',
      '--sandbox', 'read-only',
      '--cd', fixture.dir,
      'exec',
      '--ephemeral',
      '--json',
      '--output-schema', schemaPath,
      '--output-last-message', outPath,
      '--skill', selector,
      '-',
    ];
    const sess = runCodexBase(sessionArgs, sessionEnv, `Invoke ${selector} and report structured evidence.\n`);
    if (sess.code !== 0) {
      const reason = redactSecrets(`session invocation failed (exit ${sess.code}): ${(sess.stderr || sess.stdout).trim()}`, secretValues);
      record('session', false, reason);
      return finish('failed', reason);
    }
    if (!existsSync(outPath)) { record('session', false, 'no --output-last-message file'); return finish('failed', 'session produced no output file'); }
    let outcome;
    try { outcome = JSON.parse(readFileSync(outPath, 'utf8')); }
    catch (e) { record('session', false, `outcome JSON parse: ${e.message}`); return finish('failed', `session outcome not JSON: ${e.message}`); }
    const schemaErr = validateOutcome(outcome, SESSION_OUTPUT_SCHEMA);
    if (schemaErr) { record('session', false, schemaErr); return finish('failed', `session outcome off-schema: ${schemaErr}`); }
    if (outcome.selector !== selector && outcome.skill !== invokedSkillName) {
      record('session', false, 'outcome does not reflect the invoked skill');
      return finish('failed', 'session outcome does not reference the invoked skill');
    }
    const hookMode = outcome.hookMode || 'skipped-untrusted';
    // The DEFAULT smoke MUST prove untrusted hooks were skipped/warned — never silently bypassed.
    if (hookMode !== 'skipped-untrusted') {
      record('session', false, `expected hooks skipped-untrusted, got '${hookMode}'`);
      return finish('failed', `hook trust not honored: ${hookMode}`);
    }
    record('session', true, `invoked ${selector}, hooks ${hookMode}`);

    // Read back the recorded session argv/env (isolation + argv/env proof), redacting secrets.
    let sessionRecord = null;
    const recPath = join(codexHome, 'last-session.json');
    if (existsSync(recPath)) {
      try { sessionRecord = JSON.parse(readFileSync(recPath, 'utf8')); } catch { /* ignore */ }
    }
    const recordedArgv = sessionRecord ? sessionRecord.argv : sessionArgs;
    const recordedEnv = sessionRecord ? sessionRecord.env : { CODEX_HOME: codexHome, HOME: workDir };

    // ── evidence (redacted) ────────────────────────────────────────────────────────────────────────
    const rawOutcome = `${sess.stdout}\n${sess.stderr}\n${JSON.stringify(outcome)}`;
    const evidence = {
      mode,
      commit: readGitHead(repoRoot),
      fixtureCommit: fixture.commit,
      fixtureIsGit: fixture.git,
      codexVersion,
      artifactSha256,
      manifestVersion,
      catalogVersion,
      catalogCount,
      installRoot,
      invokedSkill: selector,
      hookMode,
      resultSchemaHash,
      sessionArgv: recordedArgv,
      sessionEnv: redactDeep(recordedEnv, secretValues),
      redactedOutcome: redactSecrets(rawOutcome, secretValues).trim(),
    };
    return finish('ok', null, evidence);
  } catch (e) {
    record('exception', false, String(e && e.message ? e.message : e));
    return finish('failed', `unexpected error: ${e && e.message ? e.message : e}`);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────
function parseArgv(argv) {
  const o = { mode: 'fake' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') o.mode = 'live';
    else if (a === '--keep') o.keep = true;
    else if (a === '--repo') o.repoRoot = argv[++i];
    else if (a.startsWith('--repo=')) o.repoRoot = a.slice('--repo='.length);
    else if (a === '--codex-bin') o.codexBin = argv[++i];
    else if (a.startsWith('--codex-bin=')) o.codexBin = a.slice('--codex-bin='.length);
    else if (a === '--work-dir') o.workDir = argv[++i];
    else { process.stderr.write(`✗ unknown argument: ${a}\n`); process.exit(2); }
  }
  return o;
}

function isMain() {
  try { return process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMain()) {
  const opts = parseArgv(process.argv.slice(2));
  const res = runSmoke(opts);
  const report = {
    status: res.status,
    reason: res.reason,
    steps: res.steps,
    evidence: res.evidence,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(res.exitCode);
}
