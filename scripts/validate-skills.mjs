#!/usr/bin/env node
// validate-skills.mjs — the CI truth-enforcer for this collection (D10, D11).
// Machine-checks every claim the docs make about the repo's operational state, across BOTH surfaces:
//   Claude surface (root skill dirs):
//     1. every skill dir has SKILL.md with frontmatter: name (== dir), description, allowed-tools
//     2. description + when_to_use ≤ 1536 chars combined (Claude Code truncates past that — routing bug)
//     3. every `references/<file>` and `scripts/<file>` mentioned in a SKILL.md exists; no orphans
//     4. every scripts/*.sh|*.mjs is executable and passes a syntax check (bash -n / node --check;
//        workflow templates are wrapped in an async fn like the runtime executes them, AND linted for
//        Workflow-sandbox-banned constructs: Date.now/Math.random/argless new Date/require/ESM import)
//     5. frontmatter hooks (if any) carry ALL FIVE install-layout resolver paths + AUTO_GUARD_ALWAYS=1
//        (anti-drift: the resolver is hand-copied per skill; a dropped layout silently loses enforcement)
//     6. no references to external skill packs (non-ulpi GitHub URLs, examples/ paths) in skill content
//     6b. RETRY_DELAYS is identical across Workflow templates (a retry tune must land in all, not one)
//     7. plugin manifest (if present) points at real paths
//   Codex surface (codex-skills/ adapter tree — validated separately, absence is fine):
//     C1. codex-skills/manifest.json (if present) is valid JSON with an 'adapters' array
//     C2. every adapter dir has openai.yaml with required fields: name (== dir), description, delegate
//     C3. delegate names a real Claude skill (<delegate>/SKILL.md) — else a broken delegate
//     C4. any adapter hooks.json only wires Codex-SUPPORTED hook events
//   DOC-HONESTY (README.md + every SKILL.md): fail if a banned over-claim is reintroduced
//     ("mechanically impossible", an unattended "spec to ship") or the fail-closed / common-spellings
//     caveat is dropped from README. The legitimate "Spec to a shippable PR" wording stays allowed.
//
// Flags: --surface <claude|codex|all> (default all) restricts which surface(s) run.
//        --skill <name> (repeatable) validates only the requested slice; an unknown name exits nonzero.
//        --root <dir> points the validator at an alternate tree (fixtures/tests); default = repo root.
// Exit 0 = all green; exit 1 = violations (printed); exit 2 = bad invocation.

import { readdirSync, readFileSync, statSync, existsSync, accessSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- invocation ----
const argv = process.argv.slice(2);
let surface = 'all';
let rootOverride = null;
let checkHooks = false;
const wantSkills = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--surface') surface = argv[++i];
  else if (a.startsWith('--surface=')) surface = a.slice('--surface='.length);
  else if (a === '--skill') wantSkills.push(argv[++i]);
  else if (a.startsWith('--skill=')) wantSkills.push(a.slice('--skill='.length));
  else if (a === '--root') rootOverride = argv[++i];
  else if (a.startsWith('--root=')) rootOverride = a.slice('--root='.length);
  else if (a === '--hooks') checkHooks = true;
  else { console.error(`✗ unknown argument: ${a}`); process.exit(2); }
}
if (!['claude', 'codex', 'all'].includes(surface)) {
  console.error(`✗ --surface must be one of claude|codex|all (got '${surface}')`);
  process.exit(2);
}

const ROOT = rootOverride ? resolve(rootOverride) : fileURLToPath(new URL('..', import.meta.url));
const customRoot = rootOverride != null;
const skillFilter = wantSkills.length ? new Set(wantSkills) : null;
const doClaude = surface === 'claude' || surface === 'all';
const doCodex = surface === 'codex' || surface === 'all';

const problems = [];
const p = (msg) => problems.push(msg);

// minimal YAML-frontmatter reader (flat keys + block scalars + simple nesting we actually use)
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  return m[1];
}
function fmScalar(fm, key) {
  // handles `key: value` and `key: |` block scalars
  const lines = fm.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const mm = lines[i].match(new RegExp(`^${key}:\\s*(.*)$`));
    if (!mm) continue;
    if (mm[1] && !/^[|>][+-]?\d*$/.test(mm[1].trim())) return mm[1].trim();
    // block scalar: collect indented lines
    const out = [];
    for (let j = i + 1; j < lines.length && (lines[j].startsWith('  ') || lines[j] === ''); j++) out.push(lines[j].replace(/^  /, ''));
    return out.join('\n').trim();
  }
  return null;
}
// minimal flat-YAML reader for openai.yaml (top-level `key: value` pairs only)
function yamlFlat(text) {
  const o = {};
  for (const line of text.split('\n')) {
    if (/^\s/.test(line)) continue; // only top-level keys
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) o[m[1]] = m[2].trim();
  }
  return o;
}

// ---- discover both surfaces (full lists; filtering to targets happens after) ----
const CLAUDE_SKIP = new Set([
  'examples', 'docs', 'hooks', 'scripts', '.git', '.github', '.claude-plugin',
  'node_modules', '.ulpi', 'codex-skills', 'site',
]);
function subdirs(base, skip) {
  if (!existsSync(base)) return [];
  return readdirSync(base).filter(d => {
    try { return statSync(join(base, d)).isDirectory() && !d.startsWith('.') && !(skip && skip.has(d)); }
    catch { return false; }
  });
}
const allClaude = doClaude ? subdirs(ROOT, CLAUDE_SKIP) : [];
const codexRoot = join(ROOT, 'codex-skills');
const allCodex = doCodex ? subdirs(codexRoot, null) : [];

// unknown-skill guard: a requested --skill that matches no known name in the active surface(s) is fatal
if (skillFilter) {
  const known = new Set([...allClaude, ...allCodex]);
  for (const s of skillFilter) if (!known.has(s)) p(`unknown skill '${s}' — not found in surface '${surface}'`);
}
const claudeTargets = skillFilter ? allClaude.filter(d => skillFilter.has(d)) : allClaude;
const codexTargets = skillFilter ? allCodex.filter(d => skillFilter.has(d)) : allCodex;

// ---- Claude surface: per-skill contract ----
for (const dir of claudeTargets) {
  const skillPath = join(ROOT, dir, 'SKILL.md');
  if (!existsSync(skillPath)) { p(`${dir}: missing SKILL.md`); continue; }
  const text = readFileSync(skillPath, 'utf8');
  const fm = frontmatter(text);
  if (!fm) { p(`${dir}: no frontmatter block`); continue; }

  // 1. identity + required fields
  const name = fmScalar(fm, 'name');
  if (name !== dir) p(`${dir}: frontmatter name '${name}' != directory name`);
  const desc = fmScalar(fm, 'description') || '';
  if (!desc) p(`${dir}: empty description (routing depends on it)`);
  if (!/^\s*allowed-tools:/m.test(fm)) p(`${dir}: missing allowed-tools`);

  // 2. routing budget
  const when = fmScalar(fm, 'when_to_use') || '';
  const budget = desc.length + when.length;
  if (budget > 1536) p(`${dir}: description+when_to_use = ${budget} chars > 1536 (Claude Code truncates — routing degraded)`);

  // 3. referenced files exist (own dir first; a mention may point at ANOTHER skill's file, or a
  //    repo-root scripts/ file like the CI test suites — accept any of those, flag only if nowhere)
  for (const ref of new Set([...text.matchAll(/`?(references|scripts)\/([A-Za-z0-9._-]+)`?/g)].map(m => `${m[1]}/${m[2]}`))) {
    const local = existsSync(join(ROOT, dir, ref));
    const anywhere = local || existsSync(join(ROOT, ref)) || allClaude.some(d2 => existsSync(join(ROOT, d2, ref)));
    if (!anywhere) p(`${dir}: SKILL.md mentions ${ref} but the file exists nowhere (own dir, repo root, or any skill)`);
  }
  for (const sub of ['references', 'scripts']) {
    const subdir = join(ROOT, dir, sub);
    if (!existsSync(subdir)) continue;
    for (const f of readdirSync(subdir)) {
      // subdirectories (e.g. scripts/lib/ coordinator modules) are implementation imported by code,
      // not SKILL.md-referenced assets — orphan-check only the files directly in references/ or scripts/.
      if (statSync(join(subdir, f)).isDirectory()) continue;
      if (!text.includes(f)) p(`${dir}: ${sub}/${f} exists but SKILL.md never mentions it (orphan)`);
    }
  }

  // 4. scripts are executable + syntactically valid
  const scriptsDir = join(ROOT, dir, 'scripts');
  if (existsSync(scriptsDir)) {
    for (const f of readdirSync(scriptsDir)) {
      const fp = join(scriptsDir, f);
      try { accessSync(fp, constants.X_OK); } catch { p(`${dir}: scripts/${f} is not executable (chmod +x)`); }
      try {
        if (f.endsWith('.sh')) execFileSync('bash', ['-n', fp], { stdio: 'pipe' });
        else if (f.endsWith('.mjs') || f.endsWith('.js')) execFileSync('node', ['--check', fp], { stdio: 'pipe' });
      } catch (e) { p(`${dir}: scripts/${f} fails syntax check: ${String(e.stderr || e.message).slice(0, 200)}`); }
    }
  }

  // 4b. workflow templates under references/ syntax-check as the Workflow runtime executes them:
  //     body (after `export const meta = {...}`) wrapped in an async function.
  const refsDir = join(ROOT, dir, 'references');
  if (existsSync(refsDir)) {
    for (const f of readdirSync(refsDir).filter(f => f.endsWith('.js'))) {
      const src = readFileSync(join(refsDir, f), 'utf8');
      const metaMatch = src.match(/export const meta = \{[\s\S]*?\n\}\n/);
      if (!metaMatch) { p(`${dir}: references/${f} has no top-level 'export const meta = {...}' block`); continue; }
      const body = src.replace(metaMatch[0], '');
      const wrapped = `const {agent,parallel,pipeline,phase,log,workflow,args,budget} = globalThis;\nasync function __wf__(){\n${body}\n}\n${metaMatch[0]}`;
      try {
        execFileSync('node', ['--input-type=module', '--check', '-'], { input: wrapped, stdio: 'pipe' });
      } catch (e) { p(`${dir}: references/${f} body fails Workflow-context syntax check: ${String(e.stderr || e.message).slice(0, 300)}`); }
      // A --check proves the body PARSES; it does NOT prove it will RUN in the Workflow sandbox, which
      // BANS Date.now()/Math.random()/argless new Date() (they break resume determinism) and
      // require()/ESM import (no module loader). Lint for them so a template that would throw at runtime
      // fails CI here. Require call syntax so a mention in a comment/prompt string doesn't false-positive.
      for (const [re, name] of [
        [/\bDate\.now\s*\(/, 'Date.now()'],
        [/\bMath\.random\s*\(/, 'Math.random()'],
        [/\bnew\s+Date\s*\(\s*\)/, 'argless new Date()'],
        [/\brequire\s*\(/, 'require()'],
        [/^\s*import\s[^\n]*\sfrom\s/m, 'ESM import'],
      ]) {
        if (re.test(body)) p(`${dir}: references/${f} uses '${name}' — BANNED in the Workflow sandbox (breaks resume / no module loader). Remove it.`);
      }
    }
  }

  // 5. frontmatter hooks: the resolver is hand-copied per skill (self-containment forces it), so CI is
  //    the only thing that keeps the copies from drifting. Require ALL FIVE install layouts (a missing
  //    one silently loses enforcement at that install location) AND the AUTO_GUARD_ALWAYS=1 exec.
  if (/^hooks:/m.test(fm)) {
    const layouts = [
      '${CLAUDE_PLUGIN_ROOT', '${CLAUDE_PROJECT_DIR:-.}/.claude/skills',
      '${CLAUDE_PROJECT_DIR:-.}/.agents/skills', '$HOME/.claude/skills', '$HOME/.agents/skills',
    ];
    for (const layout of layouts) {
      if (!fm.includes(layout)) p(`${dir}: frontmatter hooks resolver missing install layout '${layout}' — enforcement would differ per install location`);
    }
    if (!fm.includes('AUTO_GUARD_ALWAYS=1')) p(`${dir}: frontmatter hooks resolver missing AUTO_GUARD_ALWAYS=1 — the skill-scoped guard wouldn't always enforce while the skill is active`);
  }

  // 6. self-containment: no external pack references
  if (/examples\//.test(text)) p(`${dir}: references the local examples/ folder (must be self-contained)`);
  for (const url of [...text.matchAll(/github\.com\/([A-Za-z0-9-]+)\//g)].map(m => m[1])) {
    if (url !== 'ulpi-io') p(`${dir}: links a non-ulpi GitHub repo (${url}) — the collection must not reference external packs`);
  }
}

// 6b. anti-drift: the retry policy is duplicated across the Workflow templates (the sandbox has no
//     module loader, so runtime sharing is impossible — copy-per-template is the right execution shape).
//     But a retry tune (e.g. 3→10 attempts) that lands in ONE template silently diverges resilience.
//     CI — which already parses both templates — is the legitimate shared home for an equality assertion.
//     Scoped to a full default Claude run (skipped for a --skill slice or an alternate --root).
if (doClaude && !customRoot && !skillFilter) {
  const retrySnippets = [];
  for (const dir of allClaude) {
    const refsDir = join(ROOT, dir, 'references');
    if (!existsSync(refsDir)) continue;
    for (const f of readdirSync(refsDir).filter(f => f.endsWith('.js'))) {
      const src = readFileSync(join(refsDir, f), 'utf8');
      const m = src.match(/RETRY_DELAYS\s*=\s*(\[[^\]]*\])/);
      if (m) retrySnippets.push({ where: `${dir}/references/${f}`, val: m[1].replace(/\s+/g, '') });
    }
  }
  if (new Set(retrySnippets.map(r => r.val)).size > 1) {
    p(`RETRY_DELAYS diverged across Workflow templates — a retry-policy tune must land in ALL of them: ${retrySnippets.map(r => `${r.where}=${r.val}`).join(' vs ')}`);
  }

  // 7. plugin manifest paths are real
  const pluginPath = join(ROOT, '.claude-plugin', 'plugin.json');
  if (existsSync(pluginPath)) {
    try {
      const pj = JSON.parse(readFileSync(pluginPath, 'utf8'));
      const paths = [].concat(pj.skills || [], pj.commands || [], pj.agents || [],
        typeof pj.hooks === 'string' ? [pj.hooks] : []);
      for (const rel of paths) {
        if (typeof rel === 'string' && !existsSync(join(ROOT, rel))) p(`.claude-plugin/plugin.json: path '${rel}' does not exist`);
      }
    } catch (e) { p(`.claude-plugin/plugin.json: invalid JSON (${e.message})`); }
  }

  // hooks.json parses + its script paths exist
  const hooksPath = join(ROOT, 'hooks', 'hooks.json');
  if (existsSync(hooksPath)) {
    try {
      const hj = JSON.parse(readFileSync(hooksPath, 'utf8'));
      for (const arr of Object.values(hj.hooks || {})) for (const entry of arr) for (const h of entry.hooks || []) {
        const mm = (h.command || '').match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"']+)/);
        if (mm && !existsSync(join(ROOT, mm[1]))) p(`hooks/hooks.json: script '${mm[1]}' does not exist in repo`);
      }
    } catch (e) { p(`hooks/hooks.json: invalid JSON (${e.message})`); }
  }

  // repo-level hook scripts must at least parse (they are invisible to the per-skill scan)
  for (const dir of ['hooks']) {
    const hd = join(ROOT, dir);
    if (existsSync(hd)) for (const f of readdirSync(hd).filter(f => f.endsWith('.sh'))) {
      try { execFileSync('bash', ['-n', join(hd, f)], { stdio: 'pipe' }); }
      catch (e) { p(`${dir}/${f}: fails bash -n: ${String(e.stderr || e.message).slice(0, 150)}`); }
    }
  }

  // containment: the local-only material must stay ignored (plugin root-scan exposure, D11/U6)
  try {
    const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    for (const must of ['examples/', 'docs/DECISIONS.md']) {
      if (!gi.includes(must)) p(`.gitignore: missing '${must}' — local-only material would ship/scan`);
    }
  } catch { p('.gitignore missing'); }
}

// ---- Codex surface: the adapter tree (validated separately; absent is fine) ----
const ALLOWED_CODEX_HOOK_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'Stop', 'UserPromptSubmit',
]);
if (doCodex && existsSync(codexRoot)) {
  // C1. adapter-tree manifest is valid JSON with an 'adapters' array
  const manifest = join(codexRoot, 'manifest.json');
  if (existsSync(manifest)) {
    try {
      const mj = JSON.parse(readFileSync(manifest, 'utf8'));
      if (!mj || typeof mj !== 'object' || Array.isArray(mj)) {
        p(`codex-skills/manifest.json: expected a JSON object with an 'adapters' array`);
      } else if (mj.adapters !== undefined && !Array.isArray(mj.adapters)) {
        p(`codex-skills/manifest.json: 'adapters' must be an array`);
      }
    } catch (e) { p(`codex-skills/manifest.json: invalid JSON (${e.message})`); }
  }
  for (const a of codexTargets) {
    const adir = join(codexRoot, a);
    // C2. openai.yaml present with required fields
    const ymlPath = join(adir, 'openai.yaml');
    if (!existsSync(ymlPath)) { p(`codex-skills/${a}: missing openai.yaml (the Codex adapter manifest)`); continue; }
    const y = yamlFlat(readFileSync(ymlPath, 'utf8'));
    for (const field of ['name', 'description', 'delegate']) {
      if (!y[field]) p(`codex-skills/${a}/openai.yaml: missing required field '${field}'`);
    }
    if (y.name && y.name !== a) p(`codex-skills/${a}/openai.yaml: name '${y.name}' != adapter directory name`);
    // C3. delegate resolves to a real Claude skill
    if (y.delegate && !existsSync(join(ROOT, y.delegate, 'SKILL.md'))) {
      p(`codex-skills/${a}/openai.yaml: broken delegate '${y.delegate}' (no Claude skill ${y.delegate}/SKILL.md)`);
    }
    // C4. adapter hooks.json only wires Codex-supported events
    const hooksPath = join(adir, 'hooks.json');
    if (existsSync(hooksPath)) {
      try {
        const hj = JSON.parse(readFileSync(hooksPath, 'utf8'));
        for (const ev of Object.keys(hj.hooks || {})) {
          if (!ALLOWED_CODEX_HOOK_EVENTS.has(ev)) {
            p(`codex-skills/${a}/hooks.json: unsupported Codex hook event '${ev}' (supported: ${[...ALLOWED_CODEX_HOOK_EVENTS].join(', ')})`);
          }
        }
      } catch (e) { p(`codex-skills/${a}/hooks.json: invalid JSON (${e.message})`); }
    }
  }
}

// ---- DOC-HONESTY: no reintroduced over-claims; README keeps its caveats ----
//   Runs on the Claude/all surface, for the whole tree (not a --skill slice). A banned literal in
//   README.md or ANY SKILL.md fails; the README must retain the fail-closed and common-spellings caveats.
if (doClaude && !skillFilter) {
  const BANNED = [
    [/mechanically impossible/i, '"mechanically impossible"'],
    [/spec to ship/i, 'an unattended "spec to ship" (say "Spec to a shippable PR")'],
  ];
  const docs = [];
  const readmePath = join(ROOT, 'README.md');
  if (existsSync(readmePath)) docs.push(['README.md', readFileSync(readmePath, 'utf8')]);
  for (const d of allClaude) {
    const sp = join(ROOT, d, 'SKILL.md');
    if (existsSync(sp)) docs.push([`${d}/SKILL.md`, readFileSync(sp, 'utf8')]);
  }
  for (const [where, text] of docs) {
    for (const [re, label] of BANNED) {
      if (re.test(text)) p(`DOC-HONESTY: ${where} reintroduces the banned over-claim ${label}`);
    }
  }
  if (existsSync(readmePath)) {
    const r = readFileSync(readmePath, 'utf8');
    if (!/fail[- ]closed/i.test(r)) p(`DOC-HONESTY: README.md dropped the fail-closed caveat`);
    if (!/common spelling/i.test(r)) p(`DOC-HONESTY: README.md dropped the common-spellings caveat`);
  }
}

// ---- optional: --hooks provider-aware hook-manifest validation (dual Claude/Codex split) ----
if (checkHooks) {
  const CODEX_EVENTS = new Set(['SessionStart', 'SubagentStart', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'PreCompact', 'PostCompact']);
  const CLAUDE_EVENTS = new Set(['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'SubagentStop', 'PreCompact', 'Notification']);
  const readJson = (rel) => { const fp = join(ROOT, rel); if (!existsSync(fp)) return null; try { return JSON.parse(readFileSync(fp, 'utf8')); } catch (e) { p(`HOOKS: ${rel} is not valid JSON (${e.message})`); return null; } };
  const hookCommands = (doc) => {
    const out = [];
    for (const [evt, groups] of Object.entries(doc?.hooks || {}))
      for (const g of (Array.isArray(groups) ? groups : []))
        for (const h of (g?.hooks || [])) out.push({ evt, command: String(h.command || '') });
    return out;
  };
  const scriptPathOf = (cmd) => { const m = cmd.match(/\$\{[A-Z_]*PLUGIN_ROOT\}\/([A-Za-z0-9._/-]+)/); return m ? m[1] : null; };
  // Claude manifest must point at the Claude hook file (never the Codex one) + keep skills './'
  const cm = readJson('.claude-plugin/plugin.json');
  if (cm) {
    if (cm.hooks !== './hooks/hooks.claude.json') p(`HOOKS: .claude-plugin/plugin.json hooks must be './hooks/hooks.claude.json' (got '${cm.hooks}') — never the Codex hooks/hooks.json`);
    if (cm.skills !== './') p(`HOOKS: .claude-plugin/plugin.json skills must be './' (got '${cm.skills}')`);
  }
  const xm = readJson('.codex-plugin/plugin.json');
  if (xm && xm.hooks !== undefined && xm.hooks !== './hooks/hooks.json') p(`HOOKS: .codex-plugin/plugin.json hooks must be './hooks/hooks.json' (got '${xm.hooks}')`);
  const checkHookFile = (rel, { events, mustVar, banVar, banEvent }) => {
    const doc = readJson(rel);
    if (!doc) { p(`HOOKS: ${rel} is missing`); return; }
    for (const { evt, command } of hookCommands(doc)) {
      if (banEvent && evt === banEvent) p(`HOOKS: ${rel} uses '${banEvent}' — unsupported on this surface`);
      else if (!events.has(evt)) p(`HOOKS: ${rel} uses unsupported event '${evt}'`);
      if (mustVar && !command.includes(mustVar)) p(`HOOKS: ${rel} event '${evt}' must use \${${mustVar}} (wrong/absent provider variable)`);
      if (banVar && command.includes(banVar)) p(`HOOKS: ${rel} event '${evt}' uses \${${banVar}} (wrong provider variable)`);
      const sp = scriptPathOf(command);
      if (sp && !existsSync(join(ROOT, sp))) p(`HOOKS: ${rel} event '${evt}' references missing script ${sp}`);
    }
  };
  checkHookFile('hooks/hooks.claude.json', { events: CLAUDE_EVENTS, mustVar: 'CLAUDE_PLUGIN_ROOT', banVar: 'CODEX_PLUGIN_ROOT' });
  checkHookFile('hooks/hooks.json', { events: CODEX_EVENTS, mustVar: 'CODEX_PLUGIN_ROOT', banVar: 'CLAUDE_PLUGIN_ROOT', banEvent: 'SessionEnd' });
}

if (problems.length) {
  console.error(`✗ ${problems.length} violation(s):\n` + problems.map(x => `  - ${x}`).join('\n'));
  process.exit(1);
}
const parts = [];
if (doClaude) parts.push(`${claudeTargets.length} Claude skill(s)`);
if (doCodex) parts.push(`${codexTargets.length} Codex adapter(s)`);
console.log(`✓ validated ${parts.join(' + ')} [surface=${surface}]: frontmatter, routing, refs, scripts, hooks, manifests, self-containment, doc-honesty`);
