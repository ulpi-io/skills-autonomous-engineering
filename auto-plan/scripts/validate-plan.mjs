#!/usr/bin/env node
// validate-plan.mjs — auto-plan's DAG gate as CODE (D1: mechanically checkable guardrails never
// ship as prose-only). The build's safety depends on the plan's graph being right; this script is
// the deterministic judge — the self-review critics argue semantics, this proves structure.
//
// Enforces, on a .ulpi/plans/<name>.json:
//   1. SHAPE       — tasks[] with unique id, title, writeScope[], validate, acceptance[] (≥2 criteria);
//                    layers[][] covering every task exactly once, no unknown ids.
//   2. ACYCLIC     — dependsOn references exist and form no cycle.
//   3. TOPO ORDER  — every task's layer is strictly AFTER all its dependencies' layers
//                    (the build integrates layer-by-layer; a violation = building on a missing base).
//   4. INDEPENDENT — within a layer, write scopes are disjoint (prefix-aware: src/api and
//                    src/api/handlers.ts overlap) — parallel writers must never race.
//   5. ATOMIC      — ≤3 entries per writeScope (split bigger tasks).
//   6. SCOPE       — executable plans carry binding selectedScope[]; every id maps to task.scopeItems[]
//                    or a separately acknowledged scopeDrops[] entry. Unknown/duplicate/uncovered ids fail.
//   7. SLICE VALIDATE — non-empty per task; BLOCKS whole-suite e2e gates (a bare playwright/cypress
//                    runner that only greens at end-state); WARNS (non-blocking) on the ambiguous
//                    `<runner> test -- <file>` form — the vitest footgun (`--` drops the positional)
//                    but ALSO canonical for Jest, so it advises an explicit runner without blocking.
//
// Usage:  node validate-plan.mjs <plan.json> [--json] [--render]   (--render prints the derived human view)
// Exit:   0 = plan is structurally safe to build · 1 = violations (listed) · 2 = unreadable

import { readFileSync } from 'node:fs';

const [file, ...rest] = process.argv.slice(2);
if (!file) { console.error('usage: validate-plan.mjs <plan.json> [--json] [--render]'); process.exit(2); }
let plan;
try { plan = JSON.parse(readFileSync(file, 'utf8')); }
catch (e) { console.error(`cannot read/parse ${file}: ${e.message}`); process.exit(2); }

const problems = [];
const p = (task, issue) => problems.push({ task, issue });
const warnings = [];                              // non-blocking advisories (heuristics, not structural facts)
const warn = (task, issue) => warnings.push({ task, issue });

// ── provider-neutral slice command: prefer the execution-native `validateCommand`, fall back to
// the legacy `validate` — normalize BOTH to one trimmed nonempty string ('' when neither is set).
// Both a Claude-Code plan (`validate`) and a Codex-native/coordinator plan (`validateCommand`) map
// through here, so every downstream check judges ONE command regardless of which field carried it.
const sliceCommandOf = (t) => {
  for (const k of ['validateCommand', 'validate']) {
    const v = t?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
};

// ── safe task-ID charset (executable plans only). An executable task's id is constructed into
// `git worktree add <path> -b task/<id>` and a worktree filesystem path (see auto-build's
// build-contract). So it MUST be inert: only [A-Za-z0-9_-] and MUST start alphanumeric — that bars
// path traversal ('../'), shell metacharacters (';', spaces, '$', backticks) AND a leading '-'
// (which git would read as a flag). Canonical form: TASK-<n> (e.g. TASK-001).
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// ── end-state-only (whole-suite) validate detector (executable plans only, BLOCKING). A task's
// validate must green on ITS slice; a bare whole-suite runner only greens at end-state, so every
// slice looks broken mid-build. This fires ONLY when the command is a bare suite runner with NO
// task-specific slice token anywhere (a path with '/', a *.test/*.spec/*_test file, or any known
// source-file extension) — so a compound, slice-referencing command (e.g.
// `node scripts/validate-skills.mjs && bash scripts/test-x.sh`) is NOT flagged.
const hasSliceToken = (c) =>
  /(^|\s)\S*\/\S*/.test(c)              // any path containing a slash
  || /\.(test|spec)\.[A-Za-z]+/i.test(c) // a *.test.* / *.spec.* file
  || /_test\.[A-Za-z]+/i.test(c)         // a go-style *_test.* file
  || /\.(sh|mjs|cjs|js|ts|tsx|jsx|py|rb|go|rs|java|kt)\b/i.test(c); // any known source-file token
const isEndStateOnly = (cmd) => {
  const c = String(cmd).trim();
  if (!c) return false;
  if (hasSliceToken(c)) return false;
  return /^(npm|pnpm|yarn|bun)(\s+run)?(\s+(-w|-r|--recursive|--workspaces?|--filter\s+\S+))*\s+test\s*$/i.test(c)
    || /^(jest|vitest(\s+run)?)\s*$/i.test(c)
    || /^go\s+test\s+\.\/\.\.\.\s*$/i.test(c)
    || /^(pytest|cargo\s+test|mvn\s+test|gradle\s+test|rspec)\s*$/i.test(c);
};

const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
const layers = Array.isArray(plan.layers) ? plan.layers : [];
if (!tasks.length) p('(plan)', 'no tasks[] array');
if (!layers.length) p('(plan)', 'no layers[][] array');

// ── EXECUTABLE plan? A coordinator-run plan whose ids build worktrees/branches and whose
// validateCommand is executed. Opted into EITHER explicitly (`executable:true`, or `mode` one of
// executable/expansion/codex) OR implicitly by any task carrying a nonempty execution-native
// `validateCommand`. Descriptive Claude-Code plans (only `validate`) are NOT executable, so the
// hardened id/field/end-state checks below never gate them.
const isExecutable = plan.executable === true
  || (typeof plan.mode === 'string' && /^(executable|expansion|codex)$/i.test(plan.mode.trim()))
  || tasks.some((t) => typeof t?.validateCommand === 'string' && t.validateCommand.trim());

// ── binding selected-scope coverage ───────────────────────────────────────────────────
// The spec is not the scope authority: selectedScope[] is captured at intake and survives spec/plan.
// A proposed drop is resolved only when the plan records a distinct, per-id user acknowledgement with
// evidence; general plan approval is deliberately not accepted here as a substitute.
const selectedScope = Array.isArray(plan.selectedScope) ? plan.selectedScope : [];
const scopeDrops = Array.isArray(plan.scopeDrops) ? plan.scopeDrops : [];
const scopeById = new Map();
const mappedById = new Map();
const droppedById = new Map();

if (isExecutable && selectedScope.length === 0) {
  p('(scope)', 'executable plan is missing nonempty selectedScope[] — intake scope authority is absent');
}
if (plan.selectedScope !== undefined && !Array.isArray(plan.selectedScope)) p('(scope)', 'selectedScope must be an array');
if (plan.scopeDrops !== undefined && !Array.isArray(plan.scopeDrops)) p('(scope)', 'scopeDrops must be an array');

for (const item of selectedScope) {
  const id = item?.id;
  if (typeof id !== 'string' || !SAFE_ID.test(id)) { p('(scope)', `selectedScope entry has invalid id ${JSON.stringify(id)}`); continue; }
  if (scopeById.has(id)) p(id, 'duplicate selectedScope id');
  else scopeById.set(id, item);
  if (typeof item?.title !== 'string' || item.title.trim() === '') p(id, 'selectedScope item is missing a nonempty title');
  if (typeof item?.source !== 'string' || item.source.trim() === '') p(id, 'selectedScope item is missing a nonempty source');
}

for (const t of tasks) {
  if (isExecutable && !Array.isArray(t?.scopeItems)) {
    p(t?.id || '(task)', 'executable task is missing scopeItems[]');
    continue;
  }
  if (t?.scopeItems !== undefined && !Array.isArray(t.scopeItems)) {
    p(t?.id || '(task)', 'scopeItems must be an array of selectedScope ids');
    continue;
  }
  for (const raw of t?.scopeItems || []) {
    const id = String(raw);
    if (!scopeById.has(id)) p(t.id, `scopeItems references unknown selectedScope id '${id}'`);
    const owners = mappedById.get(id) || [];
    if (owners.includes(t.id)) p(t.id, `scopeItems repeats '${id}'`);
    else owners.push(t.id);
    mappedById.set(id, owners);
  }
}

for (const drop of scopeDrops) {
  const id = drop?.scopeId;
  if (typeof id !== 'string' || !scopeById.has(id)) { p('(scope)', `scopeDrops references unknown selectedScope id '${String(id)}'`); continue; }
  if (droppedById.has(id)) { p(id, 'duplicate scopeDrops entry'); continue; }
  const validReason = typeof drop?.reason === 'string' && drop.reason.trim() !== '';
  const validAck = drop?.acknowledgedByUser === true
    && typeof drop?.acknowledgement === 'string' && drop.acknowledgement.trim() !== '';
  if (!validReason) p(id, 'scope drop is missing a nonempty reason');
  if (!validAck) p(id, 'scope drop lacks explicit per-id user acknowledgement evidence');
  if (validReason && validAck) droppedById.set(id, drop);
}

const scopeCoverage = { total: scopeById.size, covered: [], dropped: [], uncovered: [] };
for (const id of scopeById.keys()) {
  const mapped = (mappedById.get(id) || []).length > 0;
  const dropped = droppedById.has(id);
  if (mapped && dropped) p(id, 'selectedScope id is both task-mapped and dropped');
  if (mapped) scopeCoverage.covered.push(id);
  else if (dropped) scopeCoverage.dropped.push(id);
  else {
    scopeCoverage.uncovered.push(id);
    p(id, 'UNCOVERED selected-scope item — map it to task.scopeItems[] or record an explicit per-id user-approved drop');
  }
}

// ── 1. shape ──────────────────────────────────────────────────────────────────────
const byId = {};
for (const t of tasks) {
  const id = t?.id;
  if (!id) { p('(task)', 'task without id'); continue; }
  if (byId[id]) p(id, 'duplicate task id');
  byId[id] = t;
  if (!t.title) p(id, 'missing title');
  if (!Array.isArray(t.writeScope) || !t.writeScope.length) p(id, 'missing/empty writeScope[]');
  if (!sliceCommandOf(t)) p(id, 'missing validate/validateCommand slice command');
  const acc = t.acceptance ?? t.acceptanceCriteria;
  if (!Array.isArray(acc) || acc.length < 2) p(id, `needs ≥2 testable acceptance criteria (has ${Array.isArray(acc) ? acc.length : 0})`);
}
const layerOf = {};
layers.forEach((layer, i) => {
  if (!Array.isArray(layer)) { p('(plan)', `layers[${i}] is not an array`); return; }
  for (const id of layer) {
    if (!byId[id]) p(id, `appears in layers[${i}] but is not a defined task`);
    if (layerOf[id] !== undefined) p(id, `appears in multiple layers (${layerOf[id]} and ${i})`);
    layerOf[id] = i;
  }
});
for (const id of Object.keys(byId)) if (layerOf[id] === undefined) p(id, 'defined but missing from layers (would never build)');

// ── 2. deps exist + acyclic ─────────────────────────────────────────────────────
for (const t of tasks) for (const d of t?.dependsOn || []) {
  if (!byId[d]) p(t.id, `dependsOn '${d}' which does not exist`);
}
const state = {};   // 0=unseen 1=visiting 2=done
function cyclic(id, path) {
  if (state[id] === 2) return null;
  if (state[id] === 1) return [...path, id];
  state[id] = 1;
  for (const d of byId[id]?.dependsOn || []) { if (byId[d]) { const c = cyclic(d, [...path, id]); if (c) return c; } }
  state[id] = 2;
  return null;
}
for (const id of Object.keys(byId)) { const c = cyclic(id, []); if (c) { p(c[0], `dependency cycle: ${c.join(' → ')}`); break; } }

// ── 3. layers are a topological order ─────────────────────────────────────────────
for (const t of tasks) for (const d of t?.dependsOn || []) {
  if (layerOf[t.id] !== undefined && layerOf[d] !== undefined && layerOf[t.id] <= layerOf[d]) {
    p(t.id, `ordered in layer ${layerOf[t.id]} but depends on '${d}' in layer ${layerOf[d]} — would build on a missing base`);
  }
}

// ── 4. intra-layer write scopes disjoint (prefix-aware) ───────────────────────────
const norm = (s) => String(s).replace(/^\.\//, '').replace(/\/+$/, '');
const overlaps = (a, b) => { a = norm(a); b = norm(b); return a === b || a.startsWith(b + '/') || b.startsWith(a + '/'); };
for (const [i, layer] of layers.entries()) {
  if (!Array.isArray(layer)) continue;
  for (let x = 0; x < layer.length; x++) for (let y = x + 1; y < layer.length; y++) {
    const A = byId[layer[x]], B = byId[layer[y]];
    if (!A || !B) continue;
    for (const sa of A.writeScope || []) for (const sb of B.writeScope || []) {
      if (overlaps(sa, sb)) p(`${layer[x]}+${layer[y]}`, `same layer ${i} but overlapping writeScope ('${sa}' vs '${sb}') — parallel writers would race`);
    }
  }
}

// ── 5. atomicity cap ───────────────────────────────────────────────────────────────
for (const t of tasks) if ((t?.writeScope || []).length > 3) p(t.id, `writeScope has ${t.writeScope.length} entries > 3 — split the task`);

// ── 7. slice-validate command form ─────────────────────────────────────────────────
for (const t of tasks) {
  const v = sliceCommandOf(t);   // the command that will actually run (validateCommand preferred, else legacy validate)
  // ADVISORY (non-blocking): `<runner> test -- <file>` is the vitest footgun (the `--` makes vitest
  // ignore the positional and run the WHOLE package) — but it is ALSO the canonical single-file form
  // for Jest / react-scripts / CRA (a huge slice of npm & yarn repos), where it works correctly. The
  // runner is not knowable from the command, so this WARNS (never hard-blocks a possibly-correct plan
  // — auto-build treats exit 1 as "never build"): prefer an explicit `exec vitest run`/`exec jest`.
  if (/\btest\s+--\s+\S/.test(v)) {
    warn(t.id, `validate '${v}' uses the ambiguous '<runner> test -- <file>' form — canonical for Jest but the vitest footgun (the '--' drops the positional, running the whole package). Prefer an explicit runner: '... exec vitest run <file>' or '... exec jest <file>'.`);
  }
  // BLOCKING: a bare e2e runner with NO positional only greens at end-state (structural whole-suite
  // gate). Anchored to end-of-command so an ordinary path that merely CONTAINS "e2e"
  // (e.g. `vitest run src/e2e/x.test.ts`) is not mis-flagged.
  if (/(^|\s)(playwright test|cypress run)\s*$/.test(v)) {
    p(t.id, `validate '${v}' looks like a whole-suite e2e gate that only passes at end-state — slice-scope it to this task's files`);
  }
}

// ── 7. EXECUTABLE-plan hardening (coordinator-run plans only) ────────────────────────
// These properties only matter when a coordinator actually CONSTRUCTS a worktree/branch from the
// id and EXECUTES the validate. Gated to executable plans so descriptive Claude-Code plans (which
// only carry `validate` and never reach git/exec) are untouched and stay green.
if (isExecutable) {
  for (const t of tasks) {
    const id = t?.id;
    if (!id) continue;                       // absent id already reported by the shape check
    const sid = String(id);
    // (a) SAFE ID — this id is built into `git worktree add -b task/<id>` + a worktree path; only the
    // inert charset may be constructed. Task-specific evidence names the offending id.
    if (!SAFE_ID.test(sid)) {
      p(sid, `unsafe task id '${sid}' — an executable id is constructed into 'git worktree add -b task/<id>' and a worktree path; only the safe charset [A-Za-z0-9_-] starting alphanumeric (canonical TASK-<n>) may be constructed. A traversal / shell-metachar / leading-'-' id is refused. Rename it.`);
    }
    // (c) REQUIRED EXECUTION FIELDS — an executable task must carry the fields the coordinator needs
    // to run it: a disjoint writeScope, ≥2 acceptance criteria, and one slice validate command
    // (validateCommand or legacy validate). Emit executable-specific evidence per missing field.
    if (!Array.isArray(t.writeScope) || !t.writeScope.length) {
      p(sid, `missing required execution field: writeScope[] (the coordinator scopes the worktree edits to it)`);
    }
    const acc = t.acceptance ?? t.acceptanceCriteria;
    if (!Array.isArray(acc) || acc.length < 2) {
      p(sid, `missing required execution field: ≥2 acceptance criteria (has ${Array.isArray(acc) ? acc.length : 0})`);
    }
    const cmd = sliceCommandOf(t);
    if (!cmd) {
      p(sid, `missing required execution field: a slice validate command (validateCommand or validate) for the coordinator to execute`);
    } else if (isEndStateOnly(cmd)) {
      // (b) END-STATE-ONLY validate — a bare whole-suite runner only greens at end-state; scope it.
      p(sid, `validateCommand '${cmd}' is an end-state-only whole-suite run (no task slice) — it only greens once EVERYTHING is built, so this slice always looks red. Scope it to this task's own test files.`);
    }
  }
}

if (rest.includes('--render')) {
  // derived human view — rendered on demand from the single canonical JSON; never stored, so it can never drift
  const lines = [`# Plan: ${plan.name || file} — ${tasks.length} tasks, ${layers.length} layers`, ''];
  lines.push(`## SCOPE COVERAGE: ${scopeCoverage.covered.length} of ${scopeCoverage.total} selected-scope items covered`);
  lines.push(`- explicitly dropped: ${scopeCoverage.dropped.length ? scopeCoverage.dropped.join(', ') : 'none'}`);
  lines.push(`- UNCOVERED: ${scopeCoverage.uncovered.length ? scopeCoverage.uncovered.join(', ') : 'none'}`, '');
  layers.forEach((layer, i) => {
    lines.push(`## Layer ${i + 1}`);
    for (const id of layer) {
      const t = byId[id]; if (!t) continue;
      lines.push(`- **${id}** — ${t.title}`);
      lines.push(`  - files: ${(t.writeScope || []).join(', ')}${t.dependsOn?.length ? ` · needs: ${t.dependsOn.join(', ')}` : ''}`);
      lines.push(`  - validate: \`${t.validate}\``);
      for (const a of (t.acceptance ?? t.acceptanceCriteria ?? [])) lines.push(`  - [ ] ${a}`);
    }
    lines.push('');
  });
  console.log(lines.join('\n'));
}

const out = { file, tasks: tasks.length, layers: layers.length, scopeCoverage, violations: problems.length, problems, warnings };
if (rest.includes('--json')) console.log(JSON.stringify(out, null, 2));
else {
  if (warnings.length) console.error(`⚠ ${warnings.length} advisory warning(s) (non-blocking):\n` + warnings.map(x => `  - [${x.task}] ${x.issue}`).join('\n'));
  if (problems.length) console.error(`✗ plan is NOT safe to build: ${problems.length} violation(s)\n` + problems.map(x => `  - [${x.task}] ${x.issue}`).join('\n'));
  else console.log(`✓ plan is structurally safe to build: ${tasks.length} tasks, ${layers.length} layers — acyclic, topologically ordered, intra-layer disjoint, atomic, slice-validated`);
}
process.exit(problems.length ? 1 : 0);
