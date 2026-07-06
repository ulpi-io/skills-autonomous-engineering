#!/usr/bin/env node
// validate-skills.mjs — the CI truth-enforcer for this collection (D10, D11).
// Machine-checks every claim the docs make about the repo's operational state:
//   1. every skill dir has SKILL.md with frontmatter: name (== dir), description, allowed-tools
//   2. description + when_to_use ≤ 1536 chars combined (Claude Code truncates past that — routing bug)
//   3. every `references/<file>` and `scripts/<file>` mentioned in a SKILL.md exists; no orphans
//   4. every scripts/*.sh|*.mjs is executable and passes a syntax check (bash -n / node --check;
//      workflow templates are checked wrapped in an async fn, as the Workflow runtime executes them)
//   5. frontmatter hooks (if any) parse and their resolver covers the plugin root path
//   6. no references to external skill packs (non-ulpi GitHub URLs, examples/ paths) in skill content
//   7. plugin manifest (if present) points at real paths
// Exit 0 = all green; exit 1 = violations (printed).

import { readdirSync, readFileSync, statSync, existsSync, accessSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const problems = [];
const p = (msg) => problems.push(msg);

const SKIP_DIRS = new Set(['examples', 'docs', 'hooks', 'scripts', '.git', '.github', '.claude-plugin', 'node_modules', '.ulpi']);
const skillDirs = readdirSync(ROOT).filter(d => {
  try { return statSync(join(ROOT, d)).isDirectory() && !SKIP_DIRS.has(d) && !d.startsWith('.'); }
  catch { return false; }
});

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

for (const dir of skillDirs) {
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

  // 3. referenced files exist (own dir first; a mention may point at ANOTHER skill's file —
  //    accept it if it exists under any skill dir, flag only if it exists nowhere)
  for (const ref of new Set([...text.matchAll(/`?(references|scripts)\/([A-Za-z0-9._-]+)`?/g)].map(m => `${m[1]}/${m[2]}`))) {
    const local = existsSync(join(ROOT, dir, ref));
    const anywhere = local || skillDirs.some(d2 => existsSync(join(ROOT, d2, ref)));
    if (!anywhere) p(`${dir}: SKILL.md mentions ${ref} but the file exists in no skill`);
  }
  for (const sub of ['references', 'scripts']) {
    const subdir = join(ROOT, dir, sub);
    if (!existsSync(subdir)) continue;
    for (const f of readdirSync(subdir)) {
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
    }
  }

  // 5. frontmatter hooks: resolver must cover the plugin root
  if (/^hooks:/m.test(fm)) {
    if (!fm.includes('CLAUDE_PLUGIN_ROOT')) p(`${dir}: frontmatter hooks resolver misses CLAUDE_PLUGIN_ROOT (plugin installs won't enforce)`);
    if (!fm.includes('.agents/skills')) p(`${dir}: frontmatter hooks resolver misses .agents/skills (universal installs won't enforce)`);
  }

  // 6. self-containment: no external pack references
  if (/examples\//.test(text)) p(`${dir}: references the local examples/ folder (must be self-contained)`);
  for (const url of [...text.matchAll(/github\.com\/([A-Za-z0-9-]+)\//g)].map(m => m[1])) {
    if (url !== 'ulpi-io') p(`${dir}: links a non-ulpi GitHub repo (${url}) — the collection must not reference external packs`);
  }
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

// containment: the local-only material must stay ignored (plugin root-scan exposure, D11/U6)
try {
  const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  for (const must of ['examples/', 'docs/DECISIONS.md']) {
    if (!gi.includes(must)) p(`.gitignore: missing '${must}' — local-only material would ship/scan`);
  }
} catch { p('.gitignore missing'); }

if (problems.length) {
  console.error(`✗ ${problems.length} violation(s):\n` + problems.map(x => `  - ${x}`).join('\n'));
  process.exit(1);
}
console.log(`✓ ${skillDirs.length} skills validated: frontmatter, routing budget, refs, scripts, hooks, manifests, self-containment`);
