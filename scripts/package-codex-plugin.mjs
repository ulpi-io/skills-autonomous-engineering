#!/usr/bin/env node
// package-codex-plugin.mjs — build a REPRODUCIBLE Codex marketplace artifact from this repo.
//
// Given `--out <dir>` (and optionally `--root <sourceRepo>`, default = repo root), it assembles a
// self-contained Codex marketplace under <out>:
//
//   <out>/.agents/plugins/marketplace.json          the marketplace SOURCE (generated, deterministic)
//   <out>/plugins/autonomous-engineering/            the plugin, whose topology mirrors source EXACTLY:
//       .codex-plugin/plugin.json                    manifest — same strict version + skills:./codex-skills/
//       codex-skills/                                 the 18 Codex adapters (+ .shared/ + catalog.json)
//       <delegate>/ …                                the canonical ROOT delegate skill dirs the adapters
//                                                    delegate to — shipped so delegates resolve, but NOT
//                                                    Codex-discovered (they live OUTSIDE codex-skills/).
//
// REPRODUCIBLE: deterministic file ordering, raw byte copies, no timestamps / absolute paths /
// nondeterministic bytes. A stable sha256 content digest is printed as `digest=sha256:<hex>` and
// recomputes identically across two runs.
//
// WRITES ONLY under --out. Never mutates the source repo.
//
// FAILS nonzero (exit 1, `PACKAGE-FAIL: <class> — <detail>`) on any of the sealed hazard classes:
//   • default 'skills/' directory at the plugin root
//   • a missing delegate (a canonical delegate dir referenced but absent / lacking SKILL.md)
//   • an escaping path (a catalog path or an assembled dest that leaves its root)
//   • a stale catalog (catalog.json vs the actual adapter dirs disagree)
//   • an invalid marketplace source (source manifest can't yield a valid marketplace descriptor)
//   • artifact/source topology drift (assembled tree doesn't match the required topology)
// Exit 2 = bad invocation.

import {
  readdirSync, readFileSync, writeFileSync, existsSync, statSync, lstatSync, mkdirSync, rmSync,
} from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const PLUGIN_NAME = 'autonomous-engineering';
const EXPECTED_ADAPTERS = 18;
const CODEX_SKILLS_POINTER = './codex-skills/';
const RESERVED_ROOT_DIR = 'skills';
// Names never copied into the artifact (git, OS cruft, runtime state, local-only material).
const DENY = new Set(['.git', '.DS_Store', 'node_modules', '.serena', '.ulpi', 'examples']);
// Claude-only Workflow templates: references/*.js that run ONLY under the Claude Code `Workflow` tool.
// The Codex adapter CANNOT select them (a Workflow needs the Claude Code runtime), so they must NOT
// ship in the Codex marketplace artifact. The delegate SKILL.md and its .md references still ship (so
// delegation resolves) — only these Claude-only *.js Workflow templates are dropped from the artifact.
const CLAUDE_ONLY_WORKFLOW_TEMPLATES = new Set(['pipeline-workflow.js', 'review-workflow.js']);
function isClaudeOnlyWorkflowTemplate(relPath) {
  const parts = relPath.split(/[\\/]+/);
  const base = parts[parts.length - 1];
  return parts.includes('references') && CLAUDE_ONLY_WORKFLOW_TEMPLATES.has(base);
}

// ---- outcome helpers -------------------------------------------------------
function fail(cls, detail) {
  console.error(`PACKAGE-FAIL: ${cls} — ${detail}`);
  process.exit(1);
}
function usage(msg) {
  console.error(`✗ ${msg}`);
  console.error('usage: node scripts/package-codex-plugin.mjs --out <dir> [--root <sourceRepo>]');
  process.exit(2);
}

// ---- invocation ------------------------------------------------------------
const argv = process.argv.slice(2);
let outArg = null;
let rootArg = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') outArg = argv[++i];
  else if (a.startsWith('--out=')) outArg = a.slice('--out='.length);
  else if (a === '--root') rootArg = argv[++i];
  else if (a.startsWith('--root=')) rootArg = a.slice('--root='.length);
  else usage(`unknown argument: ${a}`);
}
if (!outArg) usage('--out <dir> is required');

const ROOT = resolve(rootArg ?? fileURLToPath(new URL('..', import.meta.url)));
const OUT = resolve(outArg);
if (!existsSync(ROOT) || !statSync(ROOT).isDirectory()) usage(`--root is not a directory: ${ROOT}`);
// Refuse to write the artifact INTO the source tree — the packager must never mutate the repo.
if (OUT === ROOT || (OUT + sep).startsWith(ROOT + sep)) {
  usage(`--out must be outside --root (out=${OUT} is inside root=${ROOT})`);
}

// ---- path safety -----------------------------------------------------------
function isSafeRel(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (isAbsolute(p)) return false;
  const parts = p.split(/[\\/]+/);
  return !parts.includes('..') && !parts.includes('');
}
function containedUnder(baseAbs, childAbs) {
  const rel = relative(baseAbs, childAbs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// ---- source validation gates ----------------------------------------------

// GATE: marketplace source — the source manifest must yield a valid marketplace descriptor.
const manifestSrcPath = join(ROOT, '.codex-plugin', 'plugin.json');
if (!existsSync(manifestSrcPath)) {
  fail('invalid marketplace source', `missing .codex-plugin/plugin.json under ${ROOT}`);
}
const manifestBytes = readFileSync(manifestSrcPath);
let manifest;
try {
  manifest = JSON.parse(manifestBytes.toString('utf8'));
} catch (e) {
  fail('invalid marketplace source', `.codex-plugin/plugin.json is not valid JSON: ${e.message}`);
}
if (typeof manifest.name !== 'string' || manifest.name.trim() === '') {
  fail('invalid marketplace source', 'manifest.name is missing or empty');
}
if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  fail('invalid marketplace source', `manifest.version is not strict x.y.z semver: ${JSON.stringify(manifest.version)}`);
}
if (typeof manifest.description !== 'string' || manifest.description.trim() === '') {
  fail('invalid marketplace source', 'manifest.description is missing or empty');
}
const VERSION = manifest.version;

// GATE: topology — the skills pointer MUST be exactly ./codex-skills/ (never ./ or a cross-surface path).
if (manifest.skills !== CODEX_SKILLS_POINTER) {
  fail('artifact/source topology drift', `manifest.skills must be '${CODEX_SKILLS_POINTER}', got ${JSON.stringify(manifest.skills)}`);
}

// GATE: no default root skills/ directory at the plugin root.
if (existsSync(join(ROOT, RESERVED_ROOT_DIR)) && statSync(join(ROOT, RESERVED_ROOT_DIR)).isDirectory()) {
  fail('default skills/ directory', `a '${RESERVED_ROOT_DIR}/' directory exists at the plugin root ${ROOT}`);
}

// GATE: catalog — the sealed adapter inventory.
const catalogPath = join(ROOT, 'codex-skills', 'catalog.json');
if (!existsSync(catalogPath)) fail('stale catalog', `missing codex-skills/catalog.json under ${ROOT}`);
let catalog;
try {
  catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
} catch (e) {
  fail('stale catalog', `codex-skills/catalog.json is not valid JSON: ${e.message}`);
}
if (!Array.isArray(catalog.skills)) fail('stale catalog', 'catalog.skills is not an array');

// Validate every catalog path is safe (no escape) BEFORE touching the filesystem with it.
for (const s of catalog.skills) {
  for (const key of ['adapter', 'canonicalSource', 'delegate']) {
    if (!isSafeRel(s[key])) {
      fail('escaping path', `catalog entry '${s.name}' has an unsafe ${key}: ${JSON.stringify(s[key])}`);
    }
  }
  // adapter must be under codex-skills/, delegate/canonicalSource must NOT be.
  if (!s.adapter.replace(/\\/g, '/').startsWith('codex-skills/')) {
    fail('artifact/source topology drift', `catalog entry '${s.name}' adapter is not under codex-skills/: ${s.adapter}`);
  }
  if (s.canonicalSource.replace(/\\/g, '/').startsWith('codex-skills/')) {
    fail('artifact/source topology drift', `catalog entry '${s.name}' canonicalSource must live OUTSIDE codex-skills/: ${s.canonicalSource}`);
  }
}

// Enumerate the ACTUAL adapters on disk: immediate children of codex-skills/ that are non-dotted dirs
// holding agents/openai.yaml.
const codexSkillsDir = join(ROOT, 'codex-skills');
if (!existsSync(codexSkillsDir)) fail('stale catalog', 'codex-skills/ directory is absent');
const actualAdapters = readdirSync(codexSkillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
  .map((d) => d.name)
  .filter((n) => existsSync(join(codexSkillsDir, n, 'agents', 'openai.yaml')))
  .sort();

const catalogNames = catalog.skills.map((s) => s.name).sort();
// Duplicate names in catalog?
if (new Set(catalogNames).size !== catalogNames.length) {
  fail('stale catalog', 'catalog contains duplicate skill names');
}
// Count + set equality between catalog and the real adapters.
if (catalogNames.length !== EXPECTED_ADAPTERS) {
  fail('stale catalog', `catalog lists ${catalogNames.length} skills, expected ${EXPECTED_ADAPTERS}`);
}
if (actualAdapters.length !== EXPECTED_ADAPTERS) {
  fail('stale catalog', `found ${actualAdapters.length} adapter dirs under codex-skills/, expected ${EXPECTED_ADAPTERS}`);
}
if (typeof catalog.count === 'number' && catalog.count !== EXPECTED_ADAPTERS) {
  fail('stale catalog', `catalog.count is ${catalog.count}, expected ${EXPECTED_ADAPTERS}`);
}
if (JSON.stringify(catalogNames) !== JSON.stringify(actualAdapters)) {
  fail('stale catalog', `catalog names ${JSON.stringify(catalogNames)} != actual adapter dirs ${JSON.stringify(actualAdapters)}`);
}

// Each adapter dir must carry SKILL.md + agents/openai.yaml; adapter name must equal its dir.
for (const s of catalog.skills) {
  const adDir = join(ROOT, s.adapter);
  const wantName = s.adapter.replace(/\\/g, '/').split('/').pop();
  if (s.name !== wantName) {
    fail('artifact/source topology drift', `catalog entry name '${s.name}' != adapter dir '${wantName}'`);
  }
  if (!existsSync(join(adDir, 'SKILL.md')) || !existsSync(join(adDir, 'agents', 'openai.yaml'))) {
    fail('artifact/source topology drift', `adapter '${s.name}' is missing SKILL.md or agents/openai.yaml`);
  }
}

// GATE: delegates — every canonical delegate dir must exist with a SKILL.md.
const delegateDirs = [...new Set(catalog.skills.map((s) => s.canonicalSource))].sort();
for (const s of catalog.skills) {
  const delDir = join(ROOT, s.canonicalSource);
  if (!existsSync(delDir) || !statSync(delDir).isDirectory()) {
    fail('missing delegate', `canonical delegate dir '${s.canonicalSource}' for '${s.name}' does not exist`);
  }
  if (!existsSync(join(delDir, 'SKILL.md'))) {
    fail('missing delegate', `canonical delegate '${s.canonicalSource}' for '${s.name}' has no SKILL.md`);
  }
}

// ---- assemble the artifact (deterministic) ---------------------------------
// Collect a flat, sorted list of {rel, absSrc} then materialize. `rel` is the artifact-relative path.

const PLUGIN_REL = join('plugins', PLUGIN_NAME);
const files = []; // { rel, bytes }

// Recursively gather files from a source dir into an artifact-relative prefix, honoring DENY.
function gather(absSrcDir, relPrefix) {
  const entries = readdirSync(absSrcDir, { withFileTypes: true })
    .filter((d) => !DENY.has(d.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const absChild = join(absSrcDir, e.name);
    const relChild = join(relPrefix, e.name);
    // Drop Claude-only Workflow templates (references/*.js) — the Codex adapter cannot run them.
    if (e.isFile() && isClaudeOnlyWorkflowTemplate(relChild)) continue;
    // Refuse symlinks that escape the root (containment breach at the source).
    const lst = lstatSync(absChild);
    if (lst.isSymbolicLink()) {
      const target = resolve(dirname(absChild), readFileSync(absChild).toString());
      if (!containedUnder(ROOT, target)) {
        fail('escaping path', `symlink ${absChild} escapes the source root`);
      }
    }
    if (e.isDirectory()) {
      gather(absChild, relChild);
    } else if (e.isFile()) {
      files.push({ rel: relChild, bytes: readFileSync(absChild) });
    }
  }
}

// 1) the plugin manifest (exact bytes → preserves version exactly)
files.push({ rel: join(PLUGIN_REL, '.codex-plugin', 'plugin.json'), bytes: manifestBytes });

// 2) the codex-skills adapter tree (adapters + .shared + catalog.json), minus DENY
gather(codexSkillsDir, join(PLUGIN_REL, 'codex-skills'));

// 3) the canonical ROOT delegate skill dirs (shipped, NOT Codex-discovered)
for (const del of delegateDirs) {
  gather(join(ROOT, del), join(PLUGIN_REL, del));
}

// 4) the marketplace SOURCE — generated deterministically (stable key order, no timestamps)
const marketplace = {
  name: manifest.name,
  description: manifest.description,
  owner: {
    name: manifest.author?.name ?? 'ulpi.io',
    url: manifest.author?.url ?? manifest.homepage ?? '',
  },
  plugins: [
    {
      name: PLUGIN_NAME,
      version: VERSION,
      source: `./${PLUGIN_REL.split(sep).join('/')}`,
      skills: CODEX_SKILLS_POINTER,
      description: manifest.description,
      homepage: manifest.homepage ?? '',
      license: manifest.license ?? 'MIT',
    },
  ],
};
// Validate the descriptor we just built before we commit it to the artifact.
function marketplaceValid(m) {
  if (!m || typeof m.name !== 'string' || m.name.trim() === '') return false;
  if (!Array.isArray(m.plugins) || m.plugins.length < 1) return false;
  for (const pl of m.plugins) {
    if (typeof pl.name !== 'string' || pl.name.trim() === '') return false;
    if (typeof pl.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pl.version)) return false;
    if (typeof pl.source !== 'string' || !pl.source.startsWith('./plugins/')) return false;
  }
  return true;
}
if (!marketplaceValid(marketplace)) {
  fail('invalid marketplace source', 'generated marketplace descriptor failed validation');
}
const marketplaceBytes = Buffer.from(JSON.stringify(marketplace, null, 2) + '\n', 'utf8');
files.push({ rel: join('.agents', 'plugins', 'marketplace.json'), bytes: marketplaceBytes });

// ---- containment + determinism ---------------------------------------------
// Sort by artifact-relative POSIX path for a stable, platform-independent order.
const posix = (p) => p.split(sep).join('/');
files.sort((a, b) => (posix(a.rel) < posix(b.rel) ? -1 : posix(a.rel) > posix(b.rel) ? 1 : 0));

// Every destination must resolve strictly under OUT.
for (const f of files) {
  const dest = resolve(OUT, f.rel);
  if (!containedUnder(OUT, dest) || dest === OUT) {
    fail('escaping path', `assembled path escapes --out: ${f.rel}`);
  }
}
// No path may claim the plugin-root reserved skills/ dir.
const skillsGuardPrefix = posix(join(PLUGIN_REL, RESERVED_ROOT_DIR)) + '/';
for (const f of files) {
  if ((posix(f.rel) + '/').startsWith(skillsGuardPrefix)) {
    fail('default skills/ directory', `artifact would contain a plugin-root skills/ dir via ${f.rel}`);
  }
}

// ---- write (only now do we touch OUT) --------------------------------------
mkdirSync(OUT, { recursive: true });
for (const f of files) {
  const dest = resolve(OUT, f.rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, f.bytes);
}

// ---- post-assembly topology verification (drift check) ---------------------
const pluginRootAbs = join(OUT, PLUGIN_REL);
function mustExist(relOfOut, cls, detail) {
  if (!existsSync(join(OUT, relOfOut))) fail(cls, detail);
}
mustExist(join('.agents', 'plugins', 'marketplace.json'), 'artifact/source topology drift', 'marketplace.json missing from artifact');
mustExist(join(PLUGIN_REL, '.codex-plugin', 'plugin.json'), 'artifact/source topology drift', 'plugin manifest missing from artifact');
mustExist(join(PLUGIN_REL, 'codex-skills', 'catalog.json'), 'artifact/source topology drift', 'codex-skills/catalog.json missing from artifact');

// artifact manifest version must equal source version EXACTLY
const artManifest = JSON.parse(readFileSync(join(pluginRootAbs, '.codex-plugin', 'plugin.json'), 'utf8'));
if (artManifest.version !== VERSION) {
  fail('artifact/source topology drift', `artifact manifest version ${artManifest.version} != source ${VERSION}`);
}
if (artManifest.skills !== CODEX_SKILLS_POINTER) {
  fail('artifact/source topology drift', `artifact manifest skills pointer drifted: ${artManifest.skills}`);
}
// exactly 18 adapters in the artifact
const artCodex = join(pluginRootAbs, 'codex-skills');
const artAdapters = readdirSync(artCodex, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
  .map((d) => d.name)
  .filter((n) => existsSync(join(artCodex, n, 'agents', 'openai.yaml')))
  .sort();
if (artAdapters.length !== EXPECTED_ADAPTERS) {
  fail('artifact/source topology drift', `artifact has ${artAdapters.length} adapters, expected ${EXPECTED_ADAPTERS}`);
}
// every delegate dir present at the plugin root (outside codex-skills/)
for (const del of delegateDirs) {
  mustExist(join(PLUGIN_REL, del, 'SKILL.md'), 'artifact/source topology drift', `delegate ${del}/SKILL.md missing from artifact`);
}
// no plugin-root skills/ dir
if (existsSync(join(pluginRootAbs, RESERVED_ROOT_DIR))) {
  fail('default skills/ directory', 'artifact plugin root contains a skills/ directory');
}

// ---- content digest (stable, reproducible) ---------------------------------
const digestHash = createHash('sha256');
for (const f of files) {
  const fileHash = createHash('sha256').update(f.bytes).digest('hex');
  digestHash.update(posix(f.rel), 'utf8');
  digestHash.update('\0', 'utf8');
  digestHash.update(fileHash, 'utf8');
  digestHash.update('\n', 'utf8');
}
const digest = digestHash.digest('hex');

console.log(`files=${files.length}`);
console.log(`version=${VERSION}`);
console.log(`out=${OUT}`);
console.log(`digest=sha256:${digest}`);
process.exit(0);
