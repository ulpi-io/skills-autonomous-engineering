#!/usr/bin/env node
// route-learnings.mjs — auto-learn's Phase 2 router as CODE (D1: a mechanically-checkable guardrail
// must NOT ship as prose-only). It is the DRY-RUN-FIRST, fail-closed gate that decides whether a
// verified learning is allowed to touch shared, auto-loaded agent context — and, only when it is,
// writes it into the ONE native file both Codex and Claude Code read: the nearest AGENTS.md.
//
// Contract (every clause is enforced here, not just documented):
//   INPUT SHAPE   Each learning MUST carry a stable `id`, an actionable `rule`, an `evidence` ref, a
//                 `verification` marker, and a `scope` (a repo dir the lesson applies to). Any missing
//                 field ⇒ that record is REJECTED (reported), never written.
//   CAP + MERGE   Duplicate ids MERGE their evidence into one survivor. At most FIVE survivors per run;
//                 more than five distinct additions ⇒ the WHOLE run refuses to mutate (reported).
//   FAIL CLOSED   A record that is unverified, evidence-free, carries a secret, path-traverses its
//                 scope, names a nonexistent scope, or is a MACHINE/ENVIRONMENT DEFECT ⇒ NO context
//                 mutation. Defects are surfaced to the user, never self-patched into shared memory.
//   DRY RUN FIRST Default output is a JSON PATCH MANIFEST — nothing is written. `--apply` performs the
//                 writes, and even then only edits the STAMPED, auto-learn-owned block of an AGENTS.md;
//                 every other byte of that file is preserved. It NEVER edits CLAUDE.md or private Codex
//                 memory — only files literally named AGENTS.md, resolved inside the project root.
//
// Usage:  node route-learnings.mjs <learnings.json|-> [--root <dir>] [--apply]
// Exit:   0 = manifest produced (dry run OR apply OR refusal — all are "reported" outcomes)
//         2 = usage error / unreadable / unparseable input (never a silent empty run)

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, join, dirname, isAbsolute, basename } from 'node:path';

const STAMP_VERSION = '0.1.0';
const BLOCK_BEGIN = `<!-- BEGIN auto-learn:learnings v${STAMP_VERSION} (generated; edit via auto-learn, not by hand) -->`;
const BLOCK_END = '<!-- END auto-learn:learnings -->';
// A tolerant matcher for a PRIOR block (any stamp version) so re-runs update in place.
const BLOCK_RE = /<!-- BEGIN auto-learn:learnings[^\n]*-->[\s\S]*?<!-- END auto-learn:learnings -->/;
const MAX_SURVIVORS = 5;
const REQUIRED = ['id', 'rule', 'evidence', 'verification', 'scope'];
const PLACEHOLDER = new Set(['', 'none', 'n/a', 'na', 'tbd', 'todo', '-', '?', 'unknown']);
const DEFECT_KINDS = new Set([
  'machine_defect', 'machine-defect', 'environment_defect', 'environment-defect',
  'defect', 'skill_gap', 'guard_bypass', 'template_bug', 'tooling_bug',
]);
// A learning that is really a bug report about the machine/env — belongs to the USER, not shared memory.
const DEFECT_RE = /\b(skill gap|guard (?:bug|bypass|gap)|template bug|hook bug|machine defect|environment defect|tool(?:ing)? bug|framework bug|our (?:own )?(?:skill|guard|template|hook)|self-?patch)\b/i;

// Secret shapes we refuse to persist into shared context (curated to avoid false positives on prose).
const SECRET_RES = [
  /AKIA[0-9A-Z]{16}/,                                             // AWS access key id
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,  // private key block
  /\bghp_[A-Za-z0-9]{20,}\b/,                                     // GitHub personal token
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,                             // GitHub fine-grained token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,                               // Slack token
  /\bAIza[0-9A-Za-z_-]{20,}\b/,                                   // Google API key
  /\bsk-[A-Za-z0-9]{20,}\b/,                                      // OpenAI-style secret key
  /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*\S+/i, // key=value
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/i,                // url://user:pass@host credentials
  /\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*/i,                         // bearer token
];

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const fail = (msg) => { console.error(msg); process.exit(2); };

// ── args ────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const rootIdx = argv.indexOf('--root');
const ROOT = resolve(rootIdx >= 0 ? (argv[rootIdx + 1] || '.') : '.');
const positional = argv.filter((a, i) => !a.startsWith('--') && !(rootIdx >= 0 && i === rootIdx + 1));
const INPUT = positional[0];
if (!INPUT) fail('usage: route-learnings.mjs <learnings.json|-> [--root <dir>] [--apply]');
if (!existsSync(ROOT) || !statSync(ROOT).isDirectory()) fail(`--root is not a directory: ${ROOT}`);

// ── read + parse input ────────────────────────────────────────────────────────────────
let raw;
try { raw = INPUT === '-' ? readFileSync(0, 'utf8') : readFileSync(INPUT, 'utf8'); }
catch (e) { fail(`cannot read ${INPUT}: ${e.message}`); }
let parsed;
try { parsed = JSON.parse(raw); }
catch (e) { fail(`cannot parse ${INPUT} as JSON: ${e.message}`); }
const learnings = Array.isArray(parsed) ? parsed
  : Array.isArray(parsed?.learnings) ? parsed.learnings
    : null;
if (!learnings) fail('input must be a JSON array of learnings, or {"learnings":[...]}');

// ── per-record validation (fail closed) ─────────────────────────────────────────────────
const scanSecret = (rec) => {
  for (const v of Object.values(rec)) {
    if (typeof v !== 'string') continue;
    if (SECRET_RES.some((re) => re.test(v))) return true;
  }
  return false;
};

const rejected = [];
const reject = (id, reason, detail) => rejected.push({ id: id ?? null, reason, detail });
const accepted = [];

for (let i = 0; i < learnings.length; i++) {
  const rec = learnings[i];
  const at = `learnings[${i}]`;
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) { reject(null, 'malformed', `${at} is not an object`); continue; }
  const id = typeof rec.id === 'string' ? rec.id.trim() : rec.id;

  // required fields present + non-blank strings
  let missing = null;
  for (const f of REQUIRED) {
    const val = rec[f];
    if (typeof val !== 'string' || !val.trim()) { missing = f; break; }
  }
  if (missing) { reject(id, 'missing_field', `${at} missing/blank required field '${missing}'`); continue; }

  const rule = rec.rule.trim();
  const evidence = rec.evidence.trim();
  const verification = rec.verification.trim();
  const scope = rec.scope.trim();

  // machine / environment defect → user's to fix, never written to shared context
  const kind = (typeof rec.kind === 'string' ? rec.kind : '').trim().toLowerCase();
  if (DEFECT_KINDS.has(kind) || rec.defect === true || DEFECT_RE.test(rule) || DEFECT_RE.test(evidence)) {
    reject(id, 'machine_defect', `${at} is a machine/environment defect — surface to the user, do not self-patch shared memory`); continue;
  }

  // evidence must be real, not a placeholder
  if (PLACEHOLDER.has(evidence.toLowerCase())) { reject(id, 'missing_evidence', `${at} evidence is a placeholder ('${evidence}')`); continue; }

  // verification must be affirmative
  if (PLACEHOLDER.has(verification.toLowerCase()) || /^(unverified|pending|false|no|failed|not verified)$/i.test(verification)) {
    reject(id, 'unverified', `${at} verification is not affirmative ('${verification}')`); continue;
  }

  // secrets anywhere in the record
  if (scanSecret(rec)) { reject(id, 'secret', `${at} contains a secret/credential-shaped value`); continue; }

  // scope: no path traversal
  if (isAbsolute(scope) || scope.split(/[\\/]/).includes('..')) {
    reject(id, 'path_traversal', `${at} scope '${scope}' traverses outside the project`); continue;
  }
  const scopeAbs = resolve(ROOT, scope);
  const scopeRel = relative(ROOT, scopeAbs);
  if (scopeRel.startsWith('..') || isAbsolute(scopeRel)) {
    reject(id, 'path_traversal', `${at} scope '${scope}' resolves outside the project root`); continue;
  }
  // scope must exist and be a directory
  if (!existsSync(scopeAbs) || !statSync(scopeAbs).isDirectory()) {
    reject(id, 'nonexistent_scope', `${at} scope '${scope}' is not an existing directory`); continue;
  }

  accepted.push({ id, rule, evidence, verification, scope, scopeAbs });
}

// ── dedupe by id: merge evidence into one survivor ──────────────────────────────────────
const byId = new Map();
for (const rec of accepted) {
  const ev = rec.evidence.split(' | ').map((s) => s.trim()).filter(Boolean);
  if (!byId.has(rec.id)) {
    byId.set(rec.id, { ...rec, evidence: [...new Set(ev)] });
  } else {
    const cur = byId.get(rec.id);
    cur.evidence = [...new Set([...cur.evidence, ...ev])];
    // last non-empty rule/verification/scope win only if the first was empty (they can't be — validated)
  }
}
const survivors = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));

// ── target resolution: nearest existing AGENTS.md at or above scope, else root AGENTS.md ──
function targetFor(scopeAbs) {
  let dir = scopeAbs;
  const rootAbs = ROOT;
  for (;;) {
    const cand = join(dir, 'AGENTS.md');
    if (existsSync(cand)) return cand;
    if (dir === rootAbs) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    // stop once we've walked above root
    const rel = relative(rootAbs, dir);
    if (rel.startsWith('..') || isAbsolute(rel)) break;
  }
  return join(rootAbs, 'AGENTS.md');
}

// ── build the stamped block from a merged learning set ──────────────────────────────────
const lineFor = (l) => `- **${l.id}** — ${l.rule} (evidence: ${(Array.isArray(l.evidence) ? l.evidence : [l.evidence]).join(' | ')}; verified: ${l.verification})`;
const parseLine = (line) => {
  const m = line.match(/^- \*\*(.+?)\*\* — (.*) \(evidence: (.*); verified: (.*)\)\s*$/);
  if (!m) return null;
  return { id: m[1].trim(), rule: m[2], evidence: m[3].split(' | ').map((s) => s.trim()).filter(Boolean), verification: m[4] };
};
function buildBlock(existingText, newLearnings) {
  // seed from prior generated learnings so we never drop what a past run learned
  const merged = new Map();
  const prior = existingText.match(BLOCK_RE);
  if (prior) {
    for (const line of prior[0].split('\n')) {
      const p = parseLine(line);
      if (p) merged.set(p.id, p);
    }
  }
  for (const l of newLearnings) {
    if (merged.has(l.id)) {
      const cur = merged.get(l.id);
      cur.rule = l.rule; cur.verification = l.verification;
      cur.evidence = [...new Set([...cur.evidence, ...l.evidence])];
    } else {
      merged.set(l.id, { id: l.id, rule: l.rule, evidence: [...l.evidence], verification: l.verification });
    }
  }
  const body = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id)).map(lineFor).join('\n');
  return `${BLOCK_BEGIN}\n## Learnings (auto-learn)\n\n${body}\n${BLOCK_END}`;
}
// splice a block into a file's text, preserving every byte outside the block
function splice(existingText, block) {
  if (BLOCK_RE.test(existingText)) return existingText.replace(BLOCK_RE, block);
  if (existingText === '') return block + '\n';
  const sep = existingText.endsWith('\n') ? '\n' : '\n\n';
  return existingText + sep + block + '\n';
}

// ── assemble the patch manifest ───────────────────────────────────────────────────────
const tooMany = survivors.length > MAX_SURVIVORS;
const notes = [];
const patches = [];
let mutated = false;

if (tooMany) {
  notes.push(`too_many_additions: ${survivors.length} distinct survivors > cap ${MAX_SURVIVORS} — refusing to mutate any shared context`);
} else {
  // group survivors by resolved target file
  const groups = new Map();
  for (const s of survivors) {
    const target = targetFor(s.scopeAbs);
    if (basename(target) !== 'AGENTS.md') { reject(s.id, 'bad_target', `resolved target ${target} is not an AGENTS.md — refusing`); continue; }
    if (!groups.has(target)) groups.set(target, []);
    groups.get(target).push(s);
  }
  for (const [target, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const before = existsSync(target) ? readFileSync(target, 'utf8') : '';
    const block = buildBlock(before, group);
    const after = splice(before, block);
    const patch = {
      file: relative(ROOT, target) || 'AGENTS.md',
      action: existsSync(target) ? (BLOCK_RE.test(before) ? 'update-block' : 'append-block') : 'create',
      learnings: group.map((g) => g.id),
      before_sha: before ? sha256(before) : null,
      after_sha: sha256(after),
      changed: before !== after,
    };
    if (APPLY && before !== after) {
      writeFileSync(target, after);
      mutated = true;
      patch.applied = true;
    } else if (APPLY) {
      patch.applied = false; // no-op (already up to date) — still not a mutation
    }
    patches.push(patch);
  }
}

const manifest = {
  mode: APPLY ? 'apply' : 'dry-run',
  root: ROOT,
  received: learnings.length,
  survivors: survivors.map((s) => ({ id: s.id, scope: s.scope, evidence: s.evidence })),
  rejected,
  refused: tooMany ? 'too_many_additions' : null,
  patches,
  mutated,
  notes,
};
console.log(JSON.stringify(manifest, null, 2));
process.exit(0);
