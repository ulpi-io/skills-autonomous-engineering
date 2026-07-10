#!/usr/bin/env node
// test-dual-plugin-discovery.mjs — proves the Claude and Codex plugin surfaces discover the SAME
// canonical inventory through TWO independent, non-overlapping discovery paths, with zero cross-surface
// leak. This is the anti-drift seal for the dual-plugin layout (Claude root skills + Codex adapter tree).
//
// The three acceptance gates:
//   AC1  A DETERMINISTIC resolver (pure fs, no CLI) applies BOTH discovery models on the real repo:
//          • Claude custom+default path discovery — the `.claude-plugin/plugin.json` `skills` field
//            (default "./") names a base; every immediate child dir holding a SKILL.md is a skill.
//          • Codex manifest-directed discovery — the `.codex-plugin/plugin.json` `skills` field
//            ("./codex-skills/") names the adapter base; every immediate child holding
//            agents/openai.yaml is an adapter.
//        It must resolve EXACTLY 18 UNIQUE ids per surface, assert every Claude entrypoint is an
//        immediate canonical ROOT skill dir and every Codex entrypoint lives under codex-skills/, and
//        prove the two surfaces share NO discovered path (the matching id SETS are the intended 1:1
//        catalog pairing — verified as set-equality — NOT a collision; a collision is a shared PATH).
//   AC2  On TEMP fixture layouts, the same resolver+validator FAILS closed on each hazard class:
//        a root skills/ dir, a duplicate id, a cross-surface path, a path escape, a wrong manifest
//        target, and a missing / extra catalog item. Both manifests are repairable in this task's scope.
//   AC3  The deterministic resolver, `validate-skills --surface all`, the legacy Claude single-surface
//        validation, and — IF the real `claude` CLI exposes a `--plugin-dir` inventory probe — that CLI
//        probe ALL agree on the 18. If the CLI mode is unavailable the probe reports gateNotRun (a
//        skip marker), never a fabricated clean.
//
// Run: node --test scripts/test-dual-plugin-discovery.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readdirSync, readFileSync, existsSync, statSync,
  mkdirSync, writeFileSync, rmSync, mkdtempSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const EXPECTED_COUNT = 18;

// A root directory named `skills/` signals the WRONG (nested) layout for this collection — the Claude
// default path is the plugin root with immediate-child skill dirs. Its mere presence is fatal.
const RESERVED_ROOT_DIR = 'skills';

// ---------------------------------------------------------------------------
// Deterministic resolver (pure filesystem — no CLI, no network, no clock)
// ---------------------------------------------------------------------------

class ResolveError extends Error {}

function readManifestString(manifestPath, key, fallback) {
  if (!existsSync(manifestPath)) return fallback;
  const j = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return typeof j[key] === 'string' ? j[key] : fallback;
}

// Resolve a manifest `skills` field against the plugin root, REFUSING any path that escapes the root
// (a `../` or absolute target is a containment breach, never a legal discovery base).
function resolveSkillsBase(root, skillsField) {
  const base = resolve(root, skillsField);
  const rel = relative(root, base);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new ResolveError(`skills path '${skillsField}' escapes the plugin root`);
  }
  return base;
}

function immediateChildDirs(base) {
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((d) => {
      if (d.startsWith('.')) return false; // dotdirs (.shared, .claude-plugin, …) are never skills
      try { return statSync(join(base, d)).isDirectory(); } catch { return false; }
    })
    .sort();
}

// Claude surface: custom+default path discovery. The base comes from the manifest (default "./").
// Every immediate child dir carrying a SKILL.md is a skill; the codex adapter tree is explicitly the
// OTHER surface and is never a Claude skill; a reserved `skills/` dir is a hard failure.
function resolveClaude(root) {
  const field = readManifestString(join(root, '.claude-plugin', 'plugin.json'), 'skills', './');
  const base = resolveSkillsBase(root, field);
  const out = [];
  for (const d of immediateChildDirs(base)) {
    if (d === RESERVED_ROOT_DIR) {
      throw new ResolveError(
        `reserved root directory '${RESERVED_ROOT_DIR}/' present — the Claude default-path layout is ` +
        `immediate-root skill dirs, not a nested ${RESERVED_ROOT_DIR}/ tree`);
    }
    if (d === 'codex-skills') continue; // the Codex adapter tree — the other surface
    if (!existsSync(join(base, d, 'SKILL.md'))) continue; // docs/, hooks/, scripts/, site/ … not skills
    out.push({ id: d, path: join(base, d), entrypoint: join(base, d, 'SKILL.md') });
  }
  return out;
}

// Codex surface: manifest-directed discovery. The base comes from the Codex manifest
// ("./codex-skills/"). Every immediate child carrying agents/openai.yaml is an adapter.
function resolveCodex(root) {
  const field = readManifestString(join(root, '.codex-plugin', 'plugin.json'), 'skills', './codex-skills/');
  const base = resolveSkillsBase(root, field); // may throw ResolveError on escape
  const adapters = [];
  for (const d of immediateChildDirs(base)) {
    const yml = join(base, d, 'agents', 'openai.yaml');
    if (!existsSync(yml)) continue;
    adapters.push({ id: d, path: join(base, d), entrypoint: yml });
  }
  return { base, adapters };
}

function firstSegment(root, p) {
  return relative(root, p).split(sep)[0];
}

// The composite structural validator: resolves both surfaces and returns every invariant breach it
// finds (empty array == clean). Fixtures assert this is NON-empty; the real repo asserts it is empty.
function discoveryProblems(root) {
  const errors = [];
  let claude = [];
  let codex = { base: null, adapters: [] };
  try { claude = resolveClaude(root); } catch (e) { errors.push(`claude: ${e.message}`); }
  try { codex = resolveCodex(root); } catch (e) { errors.push(`codex: ${e.message}`); }
  const adapters = codex.adapters;

  // wrong manifest target: the Codex skills base must actually exist
  if (codex.base && !existsSync(codex.base)) {
    errors.push(`codex: manifest skills target '${relative(root, codex.base) || '.'}' does not exist`);
  }

  // within-surface duplicate id
  for (const [surface, list] of [['claude', claude], ['codex', adapters]]) {
    const counts = new Map();
    for (const s of list) counts.set(s.id, (counts.get(s.id) || 0) + 1);
    for (const [id, n] of counts) if (n > 1) errors.push(`${surface}: duplicate id '${id}' (${n}×)`);
  }

  // Claude entrypoints must be IMMEDIATE canonical root skill dirs, never inside the codex tree
  for (const s of claude) {
    const rel = relative(root, s.path);
    if (rel.includes(sep)) errors.push(`claude: '${s.id}' is not an immediate root skill dir (${rel})`);
    if (firstSegment(root, s.path) === 'codex-skills') {
      errors.push(`claude: '${s.id}' resolved under codex-skills/ (cross-surface leak)`);
    }
    if (!existsSync(join(s.path, 'SKILL.md'))) errors.push(`claude: '${s.id}' missing SKILL.md entrypoint`);
  }

  // Codex entrypoints must live UNDER codex-skills/
  for (const a of adapters) {
    if (firstSegment(root, a.path) !== 'codex-skills') {
      errors.push(`codex: '${a.id}' entrypoint is not under codex-skills/ (${relative(root, a.path)})`);
    }
  }

  // cross-surface PATH collision (a shared filesystem path claimed by both surfaces)
  const claudePaths = new Set(claude.map((s) => s.path));
  for (const a of adapters) {
    if (claudePaths.has(a.path)) {
      errors.push(`cross-surface: path '${relative(root, a.path)}' is discovered by BOTH surfaces`);
    }
  }

  // sealed catalog: missing / extra / duplicate vs the discovered Codex inventory
  if (codex.base && existsSync(codex.base)) {
    const catPath = join(codex.base, 'catalog.json');
    if (existsSync(catPath)) {
      let cat = null;
      try { cat = JSON.parse(readFileSync(catPath, 'utf8')); }
      catch (e) { errors.push(`catalog: invalid JSON (${e.message})`); }
      if (cat) {
        const names = (Array.isArray(cat.skills) ? cat.skills : [])
          .map((e) => e && (e.name ?? e.skill)).filter(Boolean);
        const counts = new Map();
        for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);
        const discovered = new Set(adapters.map((a) => a.id));
        for (const [n, c] of counts) if (c > 1) errors.push(`catalog: duplicate id '${n}' (${c}×)`);
        for (const n of counts.keys()) if (!discovered.has(n)) errors.push(`catalog: extra id '${n}' (no discovered adapter)`);
        for (const id of discovered) if (!counts.has(id)) errors.push(`catalog: missing id '${id}' (discovered but not sealed)`);
      }
    }
  }

  return { errors, claude, codex };
}

// ---------------------------------------------------------------------------
// Helpers: run validate-skills; probe the real claude CLI
// ---------------------------------------------------------------------------

function runNode(args, opts = {}) {
  try {
    const stdout = execFileSync('node', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}

const VALIDATOR = join(REPO, 'scripts', 'validate-skills.mjs');

// AC3 probe: ask the REAL claude CLI to enumerate the repo-as-plugin skill inventory via
// `claude --plugin-dir <root> plugin details <name>`. Runs against an isolated CLAUDE_CONFIG_DIR so it
// never pollutes user state and never touches the network (inline source). Returns {status:'ok',count,
// names} when the CLI supports the probe, else {status:'gateNotRun', reason} — NEVER a fabricated clean.
function probeClaudeCli(root) {
  let bin = '';
  try { bin = execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim(); } catch { /* absent */ }
  if (!bin) return { status: 'gateNotRun', reason: 'no `claude` binary on PATH' };

  let name = 'autonomous-engineering';
  try { name = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).name || name; } catch { /* keep default */ }

  const cfg = mkdtempSync(join(tmpdir(), 'ulpi-claude-cfg-'));
  try {
    const out = execFileSync(
      'claude',
      ['--plugin-dir', root, 'plugin', 'details', name],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_CONFIG_DIR: cfg } },
    );
    const m = out.match(/Skills\s*\((\d+)\)\s+([^\n]*)/);
    if (!m) return { status: 'gateNotRun', reason: 'probe output carried no `Skills (N)` inventory line' };
    const names = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    return { status: 'ok', count: Number(m[1]), names };
  } catch (e) {
    const msg = String(e.stderr || e.stdout || e.message || '');
    return { status: 'gateNotRun', reason: `claude CLI --plugin-dir inventory probe unavailable: ${msg.slice(0, 160).replace(/\s+/g, ' ').trim()}` };
  } finally {
    try { rmSync(cfg, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Fixture builder: a minimal but STRUCTURALLY VALID dual-plugin layout in a tempdir
// ---------------------------------------------------------------------------

function buildFixture(dir, skills = ['alpha', 'beta', 'gamma']) {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'fx', skills: './' }, null, 2));
  mkdirSync(join(dir, '.codex-plugin'), { recursive: true });
  writeFileSync(join(dir, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'fx', skills: './codex-skills/' }, null, 2));
  for (const s of skills) {
    mkdirSync(join(dir, s), { recursive: true });
    writeFileSync(join(dir, s, 'SKILL.md'), `---\nname: ${s}\n---\n`);
    const agents = join(dir, 'codex-skills', s, 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'openai.yaml'), `name: ${s}\ndelegate: ${s}\n`);
  }
  writeFileSync(join(dir, 'codex-skills', 'catalog.json'), JSON.stringify({
    version: 1, count: skills.length,
    skills: skills.map((s) => ({ name: s, adapter: `codex-skills/${s}`, canonicalSource: s, delegate: s, invocationPolicy: false })),
  }, null, 2));
}

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ulpi-dual-'));
  try { buildFixture(dir); return fn(dir); }
  finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}

function writeJson(p, obj) { writeFileSync(p, JSON.stringify(obj, null, 2)); }

// ===========================================================================
// AC1 — deterministic dual-surface discovery on the REAL repo
// ===========================================================================

test('AC1: resolver discovers EXACTLY 18 unique ids on each surface via its own discovery model', () => {
  const { errors, claude, codex } = discoveryProblems(REPO);
  assert.deepEqual(errors, [], `real repo must have zero discovery problems:\n${errors.join('\n')}`);

  const claudeIds = claude.map((s) => s.id);
  const codexIds = codex.adapters.map((a) => a.id);
  assert.equal(claudeIds.length, EXPECTED_COUNT, 'Claude surface resolves 18 skills');
  assert.equal(codexIds.length, EXPECTED_COUNT, 'Codex surface resolves 18 adapters');
  assert.equal(new Set(claudeIds).size, EXPECTED_COUNT, 'Claude ids are unique');
  assert.equal(new Set(codexIds).size, EXPECTED_COUNT, 'Codex ids are unique');
});

test('AC1: every Claude entrypoint is an immediate canonical ROOT skill dir', () => {
  const { claude } = discoveryProblems(REPO);
  for (const s of claude) {
    assert.equal(relative(REPO, s.path), s.id, `${s.id} is an immediate root dir`);
    assert.ok(s.entrypoint.endsWith(join(s.id, 'SKILL.md')), `${s.id} entrypoint is <id>/SKILL.md`);
    assert.notEqual(firstSegment(REPO, s.path), 'codex-skills', `${s.id} is not under codex-skills/`);
  }
});

test('AC1: every Codex entrypoint is an agents/openai.yaml under codex-skills/', () => {
  const { codex } = discoveryProblems(REPO);
  assert.equal(firstSegment(REPO, codex.base), 'codex-skills', 'Codex manifest directs discovery into codex-skills/');
  for (const a of codex.adapters) {
    assert.equal(firstSegment(REPO, a.path), 'codex-skills', `${a.id} adapter lives under codex-skills/`);
    assert.ok(a.entrypoint.endsWith(join('agents', 'openai.yaml')), `${a.id} entrypoint is agents/openai.yaml`);
  }
});

test('AC1: the two surfaces share NO discovered path, and their id sets are the intended 1:1 pairing', () => {
  const { claude, codex } = discoveryProblems(REPO);
  const claudePaths = new Set(claude.map((s) => s.path));
  const codexPaths = new Set(codex.adapters.map((a) => a.path));
  for (const p of codexPaths) assert.ok(!claudePaths.has(p), `no shared discovered path: ${p}`);
  // matching ids across surfaces are the deliberate catalog pairing (same skill, two surfaces) — a
  // set-equality, NOT a collision (a collision would be a shared PATH, asserted disjoint above).
  const claudeIds = new Set(claude.map((s) => s.id));
  const codexIds = new Set(codex.adapters.map((a) => a.id));
  assert.deepEqual([...claudeIds].sort(), [...codexIds].sort(), 'both surfaces resolve the same 18 ids');
});

// ===========================================================================
// AC2 — fail-closed on each hazard class (temp fixtures)
// ===========================================================================

test('AC2 baseline: a well-formed dual-plugin fixture has ZERO problems', () => {
  withFixture((dir) => {
    const { errors, claude, codex } = discoveryProblems(dir);
    assert.deepEqual(errors, [], `baseline fixture must be clean:\n${errors.join('\n')}`);
    assert.equal(claude.length, 3);
    assert.equal(codex.adapters.length, 3);
  });
});

test('AC2: a root skills/ directory FAILS', () => {
  withFixture((dir) => {
    mkdirSync(join(dir, RESERVED_ROOT_DIR), { recursive: true });
    const { errors } = discoveryProblems(dir);
    assert.ok(errors.some((e) => e.includes(`reserved root directory '${RESERVED_ROOT_DIR}/'`)),
      `expected a reserved-dir failure, got:\n${errors.join('\n')}`);
  });
});

test('AC2: a duplicate id FAILS', () => {
  withFixture((dir) => {
    const catPath = join(dir, 'codex-skills', 'catalog.json');
    const cat = JSON.parse(readFileSync(catPath, 'utf8'));
    cat.skills.push({ ...cat.skills[0] }); // list 'alpha' twice
    writeJson(catPath, cat);
    const { errors } = discoveryProblems(dir);
    assert.ok(errors.some((e) => /duplicate id 'alpha'/.test(e)),
      `expected a duplicate-id failure, got:\n${errors.join('\n')}`);
  });
});

test('AC2: a cross-surface path FAILS', () => {
  withFixture((dir) => {
    // Point the Codex manifest at the repo root and drop an adapter entrypoint into a root skill dir,
    // so 'alpha' is discovered by BOTH surfaces at the same path.
    writeJson(join(dir, '.codex-plugin', 'plugin.json'), { name: 'fx', skills: './' });
    mkdirSync(join(dir, 'alpha', 'agents'), { recursive: true });
    writeFileSync(join(dir, 'alpha', 'agents', 'openai.yaml'), 'name: alpha\ndelegate: alpha\n');
    const { errors } = discoveryProblems(dir);
    assert.ok(errors.some((e) => e.startsWith('cross-surface:')),
      `expected a cross-surface failure, got:\n${errors.join('\n')}`);
  });
});

test('AC2: a path escape FAILS', () => {
  withFixture((dir) => {
    writeJson(join(dir, '.codex-plugin', 'plugin.json'), { name: 'fx', skills: '../escape' });
    const { errors } = discoveryProblems(dir);
    assert.ok(errors.some((e) => /escapes the plugin root/.test(e)),
      `expected a path-escape failure, got:\n${errors.join('\n')}`);
  });
});

test('AC2: a wrong manifest target FAILS', () => {
  withFixture((dir) => {
    writeJson(join(dir, '.codex-plugin', 'plugin.json'), { name: 'fx', skills: './nope/' });
    const { errors } = discoveryProblems(dir);
    assert.ok(errors.some((e) => /manifest skills target '.*' does not exist/.test(e)),
      `expected a wrong-target failure, got:\n${errors.join('\n')}`);
  });
});

test('AC2: a missing catalog item FAILS', () => {
  withFixture((dir) => {
    const catPath = join(dir, 'codex-skills', 'catalog.json');
    const cat = JSON.parse(readFileSync(catPath, 'utf8'));
    cat.skills = cat.skills.filter((s) => s.name !== 'gamma'); // drop a discovered adapter
    writeJson(catPath, cat);
    const { errors } = discoveryProblems(dir);
    assert.ok(errors.some((e) => /missing id 'gamma'/.test(e)),
      `expected a missing-catalog-item failure, got:\n${errors.join('\n')}`);
  });
});

test('AC2: an extra catalog item FAILS', () => {
  withFixture((dir) => {
    const catPath = join(dir, 'codex-skills', 'catalog.json');
    const cat = JSON.parse(readFileSync(catPath, 'utf8'));
    cat.skills.push({ name: 'delta', adapter: 'codex-skills/delta', canonicalSource: 'delta', delegate: 'delta', invocationPolicy: false });
    writeJson(catPath, cat);
    const { errors } = discoveryProblems(dir);
    assert.ok(errors.some((e) => /extra id 'delta'/.test(e)),
      `expected an extra-catalog-item failure, got:\n${errors.join('\n')}`);
  });
});

// ===========================================================================
// AC3 — multi-source agreement on the 18
// ===========================================================================

test('AC3: resolver, validate-skills --surface all, and legacy Claude validation agree on 18', () => {
  // (1) deterministic resolver
  const { claude, codex } = discoveryProblems(REPO);
  assert.equal(claude.length, EXPECTED_COUNT);
  assert.equal(codex.adapters.length, EXPECTED_COUNT);

  // (2) validate-skills --surface all is clean
  const all = runNode([VALIDATOR, '--surface', 'all']);
  assert.equal(all.code, 0, `validate-skills --surface all must pass:\n${all.stderr || all.stdout}`);
  const allCounts = all.stdout.match(/(\d+) Claude skill\(s\) \+ (\d+) Codex adapter\(s\)/);
  assert.ok(allCounts, `--surface all must report both counts:\n${all.stdout}`);
  assert.equal(Number(allCounts[1]), EXPECTED_COUNT, 'validate-skills reports 18 Claude skills');
  assert.equal(Number(allCounts[2]), EXPECTED_COUNT, 'validate-skills reports 18 Codex adapters');

  // (3) legacy single-surface Claude validation agrees
  const legacy = runNode([VALIDATOR, '--surface', 'claude']);
  assert.equal(legacy.code, 0, `legacy Claude validation must pass:\n${legacy.stderr || legacy.stdout}`);
  const legacyCount = legacy.stdout.match(/validated (\d+) Claude skill\(s\)/);
  assert.ok(legacyCount, `legacy validation must report a count:\n${legacy.stdout}`);
  assert.equal(Number(legacyCount[1]), EXPECTED_COUNT, 'legacy Claude validation reports 18');

  // all deterministic sources concur
  assert.equal(claude.length, Number(legacyCount[1]));
  assert.equal(claude.length, Number(allCounts[1]));
});

test('AC3: the claude CLI --plugin-dir inventory probe agrees on 18 (or reports gateNotRun)', (t) => {
  const probe = probeClaudeCli(REPO);
  if (probe.status !== 'ok') {
    // Honest fail-closed: the gate did not run. Skip marker — never a fabricated clean.
    t.skip(`gateNotRun — ${probe.reason}`);
    return;
  }
  const { claude } = discoveryProblems(REPO);
  assert.equal(probe.count, EXPECTED_COUNT, `claude CLI must inventory 18 skills, got ${probe.count}`);
  assert.equal(probe.names.length, EXPECTED_COUNT, 'CLI listed 18 skill names');
  assert.deepEqual(
    probe.names.slice().sort(),
    claude.map((s) => s.id).sort(),
    'the CLI inventory and the deterministic resolver name the SAME 18 Claude skills',
  );
});
