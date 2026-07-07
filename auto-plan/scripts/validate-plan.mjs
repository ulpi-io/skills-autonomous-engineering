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
//   6. SLICE VALIDATE — non-empty per task; BLOCKS whole-suite e2e gates (a bare playwright/cypress
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

const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
const layers = Array.isArray(plan.layers) ? plan.layers : [];
if (!tasks.length) p('(plan)', 'no tasks[] array');
if (!layers.length) p('(plan)', 'no layers[][] array');

// ── 1. shape ──────────────────────────────────────────────────────────────────────
const byId = {};
for (const t of tasks) {
  const id = t?.id;
  if (!id) { p('(task)', 'task without id'); continue; }
  if (byId[id]) p(id, 'duplicate task id');
  byId[id] = t;
  if (!t.title) p(id, 'missing title');
  if (!Array.isArray(t.writeScope) || !t.writeScope.length) p(id, 'missing/empty writeScope[]');
  if (!t.validate || typeof t.validate !== 'string') p(id, 'missing validate command');
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

// ── 6. slice-validate command form ─────────────────────────────────────────────────
for (const t of tasks) {
  const v = t?.validate || '';
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

if (rest.includes('--render')) {
  // derived human view — rendered on demand from the single canonical JSON; never stored, so it can never drift
  const lines = [`# Plan: ${plan.name || file} — ${tasks.length} tasks, ${layers.length} layers`, ''];
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

const out = { file, tasks: tasks.length, layers: layers.length, violations: problems.length, problems, warnings };
if (rest.includes('--json')) console.log(JSON.stringify(out, null, 2));
else {
  if (warnings.length) console.error(`⚠ ${warnings.length} advisory warning(s) (non-blocking):\n` + warnings.map(x => `  - [${x.task}] ${x.issue}`).join('\n'));
  if (problems.length) console.error(`✗ plan is NOT safe to build: ${problems.length} violation(s)\n` + problems.map(x => `  - [${x.task}] ${x.issue}`).join('\n'));
  else console.log(`✓ plan is structurally safe to build: ${tasks.length} tasks, ${layers.length} layers — acyclic, topologically ordered, intra-layer disjoint, atomic, slice-validated`);
}
process.exit(problems.length ? 1 : 0);
