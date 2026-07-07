#!/usr/bin/env node
// verify-map.mjs — the anti-lie gate of the auto-map skill, as CODE (D1: mechanically
// checkable guardrails never ship as prose-only).
//
// Audits a project's context architecture against reality:
//   1. TIER BUDGETS   — root CLAUDE.md ≤150 lines, .claude/rules/*.md ≤120, nested CLAUDE.md ≤100
//                       (HTML comments excluded — they're stripped from context by Claude Code).
//   2. NO @IMPORTS of generated content — @imports load AT LAUNCH and defeat disclosure tiering.
//                       (Code spans/fences are skipped, matching Claude Code's own parser.)
//   3. PATHS EXIST    — every repo-relative path the map claims (backtick-quoted) is test -e'd.
//   4. COMMANDS RUN   — with --run-commands, every command in generated "verified" blocks is
//                       executed (exit 0 required); otherwise they must carry a (verified: <date>)
//                       or (unverified) marker so no claim ships silently unproven.
//   5. STAMPS         — generated sections carry generation stamps (update-don't-clobber depends
//                       on them); nested maps exist for significant dirs passed via --expect-dirs.
//
// Usage:
//   node verify-map.mjs <project-root> [--run-commands] [--expect-dirs "src/api,src/db"] [--json]
// Exit: 0 = map verifies · 1 = violations (listed) · 2 = no map found
//
// Dogfooding note: this is the same fail-closed philosophy as the guards — a map that cannot be
// verified is reported broken, never assumed fine.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, relative } from 'node:path';

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--'));
if (!ROOT || !existsSync(ROOT)) { console.error('usage: verify-map.mjs <project-root> [--run-commands] [--expect-dirs a,b] [--json]'); process.exit(2); }
const RUN_CMDS = args.includes('--run-commands');
const JSON_OUT = args.includes('--json');
const expIdx = args.indexOf('--expect-dirs');
const EXPECT_DIRS = expIdx >= 0 ? (args[expIdx + 1] || '').split(',').map(s => s.trim()).filter(Boolean) : [];

const problems = [];
const p = (file, msg) => problems.push({ file: relative(ROOT, file) || file, issue: msg });

// ── collect the map files ────────────────────────────────────────────────────────
const SKIP = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'target', '.next', 'examples', '.claude']);
function* walk(dir, depth = 0) {
  if (depth > 6) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) yield* walk(join(dir, e.name), depth + 1);
    else if (e.isFile() && e.name === 'CLAUDE.md') yield join(dir, e.name);
  }
}
const rootMap = ['CLAUDE.md', '.claude/CLAUDE.md'].map(f => join(ROOT, f)).find(existsSync);
const rulesDir = join(ROOT, '.claude', 'rules');
const ruleFiles = existsSync(rulesDir) ? readdirSync(rulesDir).filter(f => f.endsWith('.md')).map(f => join(rulesDir, f)) : [];
const nestedMaps = [...walk(ROOT)].filter(f => f !== rootMap);
if (!rootMap) { console.error('no root CLAUDE.md — no map to verify'); process.exit(2); }

// ── helpers ──────────────────────────────────────────────────────────────────────
const stripForBudget = (text) => text
  .replace(/<!--[\s\S]*?-->/g, '')                 // HTML comments are stripped from context
  .split('\n');
function stripCode(text) {                          // remove fences + inline code (import parsing skips them)
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}
function backtickPaths(text) {                      // repo-relative paths the map CLAIMS exist
  const out = [];
  for (const m of text.matchAll(/`([A-Za-z0-9_./-]+\/[A-Za-z0-9_./-]+)`/g)) {
    const c = m[1];
    if (c.includes('//') || c.startsWith('http') || c.includes('<') || c.startsWith('-')) continue;
    if (/\.(md|ts|tsx|js|jsx|mjs|py|rs|go|json|yml|yaml|toml|sh|sql|prisma)$/.test(c) || (!c.includes('.') && c.endsWith('/'))) out.push(c);
  }
  return out;
}

// ── 1+2+3+5 per file ─────────────────────────────────────────────────────────────
const budget = { root: 150, rule: 120, nested: 100 };
const checkFile = (file, kind) => {
  const text = readFileSync(file, 'utf8');
  const lines = stripForBudget(text).length;
  if (lines > budget[kind]) p(file, `over budget: ${lines} lines > ${budget[kind]} (${kind}) — move content DOWN a tier`);
  // @imports outside code spans (the docs' own parsing rule)
  for (const m of stripCode(text).matchAll(/(?:^|\s)@([A-Za-z0-9_~./-]+)/g)) {
    if (m[1].startsWith('~')) continue;             // home-dir personal imports are a user choice
    p(file, `@import of '${m[1]}' — imports load AT LAUNCH and defeat disclosure tiering; link in backticks instead`);
  }
  // claimed paths exist (relative to the file's own directory, then the root)
  for (const c of backtickPaths(text)) {
    if (!existsSync(join(dirname(file), c)) && !existsSync(join(ROOT, c))) p(file, `claims path '${c}' which does not exist`);
  }
  // generated sections must be stamped; command claims must be verified or marked
  const hasGenerated = /<!-- generated by auto-map/.test(text);
  if (kind === 'root' && !hasGenerated) p(file, `no auto-map generation stamp — update-don't-clobber cannot distinguish generated from human sections`);
  for (const m of text.matchAll(/^\s*[-*]?\s*`([^`\n]+)`\s*—?.*$/gm)) {
    const cmd = m[1];
    // Match a runner binary followed by whitespace or end-of-span — NOT a word boundary, or `go\b`
    // would match `go.mod`/`go.work`/`go.sum` and `node\b` would match `node.js`, mis-flagging an
    // ordinary Key-files bullet as an unproven command.
    if (!/^(npm|pnpm|yarn|bun|deno|make|cargo|go|pytest|python|node|npx|composer|php|rake|bundle|ruby|mvn|gradle|dotnet|poetry|uv|just|task)(\s|$)/.test(cmd)) continue;
    const lineText = m[0];
    const marked = /\((verified[^)]*|unverified)\)/.test(lineText);
    // Long-running verbs (dev/serve/start/watch/preview) never exit — executing one would hang until
    // the timeout and be reported as a failure. Verify these by MARKER only, never by execution.
    const longRunning = /(^|\s)(dev|serve|start|watch|preview)(\s|$)/.test(cmd);
    if (RUN_CMDS && !longRunning) {
      try { execFileSync('bash', ['-c', cmd], { cwd: ROOT, stdio: 'pipe', timeout: 300000 }); }
      catch { p(file, `command \`${cmd}\` FAILS when executed — a map command that fails on first use destroys trust in the whole map`); }
    } else if (!marked) {
      p(file, `command \`${cmd}\` carries no (verified)/(unverified) marker${longRunning ? ' (long-running — must be marker-verified, not executed)' : ' and --run-commands not used'} — unproven claim`);
    }
  }
  return text;
};

checkFile(rootMap, 'root');
for (const f of ruleFiles) {
  const text = checkFile(f, 'rule');
  if (!/^---\n[\s\S]*?paths:/m.test(text)) p(f, `rules file has no 'paths:' frontmatter — it loads EVERY session instead of on demand (belongs in root or needs scoping)`);
}
for (const f of nestedMaps) checkFile(f, 'nested');

// ── 5b: expected significant directories are actually mapped ─────────────────────
for (const d of EXPECT_DIRS) {
  if (!existsSync(join(ROOT, d, 'CLAUDE.md'))) p(join(ROOT, d), `significant directory has no nested CLAUDE.md — Claude works there blind`);
}

// ── report ────────────────────────────────────────────────────────────────────────
const summary = { rootMap: relative(ROOT, rootMap), rules: ruleFiles.length, nested: nestedMaps.length, violations: problems.length, problems };
if (JSON_OUT) console.log(JSON.stringify(summary, null, 2));
else if (problems.length) console.error(`✗ map verification: ${problems.length} violation(s)\n` + problems.map(x => `  - ${x.file}: ${x.issue}`).join('\n'));
else console.log(`✓ map verifies: root + ${ruleFiles.length} rule file(s) + ${nestedMaps.length} nested map(s) — budgets ok, no launch-time imports, all claimed paths exist`);
process.exit(problems.length ? 1 : 0);
