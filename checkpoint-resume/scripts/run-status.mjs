#!/usr/bin/env node
// run-status.mjs — legible, READ-ONLY status for autonomous-pipeline (and any checkpoint-resume) runs.
//
// The counterpart to checkpoint.mjs's writes: point it at nothing and it finds the newest run under
// this project's `.ulpi/runs/` and renders where it is — phases, per-task progress, the open findings
// register, and (for a live/interrupted run) the one command to resume it. It NEVER writes: it only
// reads the durable `.ulpi/runs/<id>.json` files checkpoint.mjs already maintains, so running it can
// never disturb a run in flight. Timestamps come straight from the file (every unit/phase/item is
// stamped), so "updated 3m ago" and per-task durations are real, not guessed.
//
// Usage:
//   node run-status.mjs                  # newest run for THIS project (walks up to find .ulpi/runs), rendered
//   node run-status.mjs <id>             # a specific run (id prefix is enough)
//   node run-status.mjs --list           # every run under this project, one line each, newest first
//   node run-status.mjs --json [id]      # machine-readable: the raw durable doc (or a list with --list)
//   node run-status.mjs --resume [id]    # print the exact Workflow({scriptPath,args}) call to RESUME it
//   node run-status.mjs --dir <path>     # look in <path> instead of the auto-discovered .ulpi/runs
//   node run-status.mjs --no-color       # plain text (also honors NO_COLOR)
//
// Exit codes: 0 ok (incl. "no runs found") · 1 usage error · 3 requested run id not found.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const ARGV = process.argv.slice(2);
const SELF = process.argv[1];
const flag = (f) => ARGV.includes(f);
const optVal = (f) => { const i = ARGV.indexOf(f); return i >= 0 ? ARGV[i + 1] : undefined; };
// positionals = args that aren't flags and aren't the value consumed by --dir
const VALUE_FLAGS = new Set(['--dir']);
const positional = ARGV.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(ARGV[i - 1])));

// ── color (TTY + NO_COLOR aware) ──────────────────────────────────────────────
const COLOR = process.stdout.isTTY && !flag('--no-color') && !process.env.NO_COLOR;
const c = (code) => (s) => COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s);
const dim = c('2'), bold = c('1'), red = c('31'), grn = c('32'), ylw = c('33'), cyn = c('36');

// ── time helpers ──────────────────────────────────────────────────────────────
function rel(iso) {
  if (!iso) return 'unknown';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 48) return `${h}h ${m % 60}m ago`;
  return `${Math.round(h / 24)}d ago`;
}
function dur(aIso, bIso) {
  const a = Date.parse(aIso), b = Date.parse(bIso);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return '';
  const s = Math.round((b - a) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`;
  const h = Math.floor(m / 60); return `${h}h ${m % 60}m`;
}

// ── discover + load runs ────────────────────────────────────────────────────────
function findRunsDir() {
  const override = optVal('--dir');
  if (override) return resolve(override);
  let d = process.cwd();
  for (let i = 0; i < 60; i++) {
    const p = join(d, '.ulpi', 'runs');
    if (existsSync(p)) return p;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return join(process.cwd(), '.ulpi', 'runs'); // default (may not exist → "no runs")
}
function loadRuns(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const file = join(dir, f);
    let mtime = 0; try { mtime = statSync(file).mtimeMs; } catch {}
    try { out.push({ file, name: f, doc: JSON.parse(readFileSync(file, 'utf8')), mtime }); }
    catch (e) { out.push({ file, name: f, doc: null, err: e.message, mtime }); }
  }
  const key = (r) => r.doc?.updatedAt || r.doc?.createdAt || new Date(r.mtime).toISOString();
  out.sort((a, b) => String(key(b)).localeCompare(String(key(a)))); // newest first
  return out;
}

// ── status vocabulary ───────────────────────────────────────────────────────────
const RUN_BADGE = {
  running: cyn('◐ running'), initializing: cyn('◐ initializing'),
  needs_attention: ylw('▲ needs attention'), done: grn('● done'), aborted: red('✗ aborted'),
};
const PH_GLYPH = { done: grn('●'), running: cyn('◐'), blocked: red('✗'), skipped: dim('·'), pending: dim('○') };
const PHASE_ORDER = ['build', 'simplify', 'test', 'review', 'performance', 'ship_prep', 'finalize'];
function orderedPhases(phases) {
  return Object.keys(phases || {})
    .sort((a, b) => {
      const ia = PHASE_ORDER.indexOf(a), ib = PHASE_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    })
    .map((k) => [k, phases[k] || {}]);
}
function buckets(units) {
  const b = { pending: [], in_progress: [], done: [], blocked: [], dep_blocked: [] };
  // A malformed/foreign/truncated file can hold a null (or non-object) unit value and still parse
  // as JSON — a READ-ONLY status tool must render it, never crash (one bad unit must not blank every run).
  for (const [id, u] of Object.entries(units || {})) {
    const s = (u && typeof u === 'object' && u.status) ? u.status : 'malformed';
    (b[s] || (b[s] = [])).push(id);
  }
  return b;
}
function bar(done, total, width = 22) {
  if (!total) return dim('— no tasks —');
  const fill = Math.round((width * done) / total);
  return `${grn('█'.repeat(fill))}${dim('░'.repeat(width - fill))} ${done}/${total}`;
}
const isLive = (d) => ['running', 'needs_attention', 'initializing'].includes(d?.status);

// ── renderers ────────────────────────────────────────────────────────────────────
function statusDot(status) {
  return ({ running: cyn('◐'), initializing: cyn('◐'), needs_attention: ylw('▲'), done: grn('●'), aborted: red('✗') })[status] || dim('○');
}

function renderList(runs, dir) {
  if (!runs.length) { console.log(dim(`no runs found under ${dir}`)); return; }
  console.log(dim(`${runs.length} run(s) under ${dir} — newest first\n`));
  for (const r of runs) {
    const d = r.doc;
    if (!d) { console.log(`${red('!')} ${r.name} ${dim('(unreadable: ' + r.err + ')')}`); continue; }
    const b = buckets(d.units), total = Object.keys(d.units || {}).length;
    const id = (d.id || r.name).replace(/\.json$/, '');
    console.log(`${statusDot(d.status)} ${bold(id.padEnd(26))} ${dim((d.currentPhase || '—').padEnd(12))} ${String(`${b.done.length}/${total}`).padEnd(7)} ${dim(rel(d.updatedAt))}`);
  }
}

function render(r, dir) {
  const d = r.doc;
  if (!d) { console.log(red(`! ${r.name} is unreadable: ${r.err}`)); return; }
  const b = buckets(d.units), total = Object.keys(d.units || {}).length;

  console.log();
  console.log(`  ${bold(d.id || r.name)}   ${RUN_BADGE[d.status] || d.status}`);
  if (d.task) console.log(`  ${dim('task    ')}${d.task}`);
  const started = d.createdAt ? rel(d.createdAt) : '?';
  const took = d.finishedAt && d.createdAt ? `  ${dim('·')} ran ${dur(d.createdAt, d.finishedAt)}` : '';
  console.log(`  ${dim('started ')}${started}   ${dim('·')} updated ${rel(d.updatedAt)}${took}`);
  console.log(`  ${dim('file    ')}${dim(r.file)}`);

  const phases = orderedPhases(d.phases);
  if (phases.length) {
    console.log();
    const line = phases.map(([k, v]) => {
      const label = (k === d.currentPhase && d.status === 'running') ? bold(k) : k;
      return `${PH_GLYPH[v.status] || dim('○')} ${label}`;
    }).join(dim('  →  '));
    console.log(`  ${dim('phases')}  ${line}`);
  }

  if (total) {
    console.log();
    console.log(`  ${dim('build')}   ${bar(b.done.length, total)}`);
    const chips = [];
    if (b.in_progress.length) chips.push(cyn(`◐ ${b.in_progress.length} in progress`));
    if (b.blocked.length) chips.push(red(`✗ ${b.blocked.length} blocked`));
    if (b.dep_blocked.length) chips.push(ylw(`⧗ ${b.dep_blocked.length} dep-blocked`));
    if (b.pending.length) chips.push(dim(`○ ${b.pending.length} pending`));
    if (chips.length) console.log(`          ${chips.join(dim('  ·  '))}`);
    // detail lines for anything not moving forward, with its note + duration
    for (const id of [...b.in_progress, ...b.blocked, ...b.dep_blocked]) {
      const u = d.units[id];
      const g = u.status === 'in_progress' ? cyn('◐') : u.status === 'dep_blocked' ? ylw('⧗') : red('✗');
      const t = u.startedAt ? dim(` (${dur(u.startedAt, u.finishedAt || new Date().toISOString())})`) : '';
      console.log(`          ${g} ${id}${u.note ? dim(' — ' + u.note) : ''}${t}`);
    }
  }

  const items = d.openItems || [];
  if (items.length) {
    console.log();
    console.log(`  ${dim('open')}    ${items.length} finding(s) in the register`);
    for (const it of items.slice(0, 10)) {
      const label = [it.phase, it.kind].filter(Boolean).join('/');
      const why = it.why || it.issue || it.summary || (it.task ? `task ${it.task}` : '') || JSON.stringify(it).slice(0, 90);
      console.log(`          ${ylw('•')} ${dim((label || '?').padEnd(18))} ${String(why).slice(0, 96)}`);
    }
    if (items.length > 10) console.log(dim(`          … +${items.length - 10} more`));
  }

  if (d.result != null) {
    console.log();
    const rs = typeof d.result === 'object' ? (d.result.status || JSON.stringify(d.result)) : d.result;
    const extra = (d.result && typeof d.result === 'object' && d.result.summary) ? ` — ${d.result.summary}` : '';
    console.log(`  ${dim('result')}  ${rs}${extra}`);
  }

  console.log();
  if (isLive(d) || b.blocked.length || b.dep_blocked.length || b.pending.length || b.in_progress.length) {
    console.log(`  ${dim('resume')}  node ${SELF} --resume ${d.id || ''}`.trimEnd());
  } else {
    console.log(`  ${grn('✓')} nothing pending — this run is complete.`);
  }
  console.log();
}

// ── resume recipe ──────────────────────────────────────────────────────────────
function resumeSet(units) {
  const skip = [], eligible = [], depBlocked = {};
  const u = units || {};
  for (const [id, unit] of Object.entries(u)) {
    if (unit.status === 'done') { skip.push(id); continue; }
    const missing = (unit.dependsOn || []).filter((d) => u[d]?.status !== 'done');
    if (missing.length) {
      let root = missing[0]; const seen = new Set();
      while (!seen.has(root)) { seen.add(root); const next = (u[root]?.dependsOn || []).find((d) => u[d]?.status !== 'done'); if (!next) break; root = next; }
      depBlocked[id] = root;
    } else eligible.push(id);
  }
  return { skip, eligible, dep_blocked: depBlocked };
}
function renderResume(r) {
  const d = r.doc;
  if (!d) { console.log(red(`! ${r.name} is unreadable: ${r.err}`)); return; }
  const rs = resumeSet(d.units);
  if (d.launch && d.launch.scriptPath) {
    // Ensure the relaunch reuses THIS status file so the workflow reads the checkpoint and skips done.
    const args = { ...(d.launch.args || {}) };
    if (!args.statusFile) args.statusFile = r.file;
    console.log('// Resume — paste into the Workflow tool. It reads the checkpoint and skips done units.');
    console.log(`// skip ${rs.skip.length} done · re-run ${rs.eligible.length} eligible · ${Object.keys(rs.dep_blocked).length} dep-blocked`);
    console.log(JSON.stringify({ scriptPath: d.launch.scriptPath, args }, null, 2));
  } else {
    console.log('// No launch recipe was persisted at init (run predates `checkpoint.mjs init --launch`).');
    console.log('// Relaunch the pipeline Workflow with the SAME args you used originally, plus this exact');
    console.log('// status file so it resumes in place:');
    console.log(`//   statusFile: ${JSON.stringify(r.file)}`);
    console.log(`// Resume set: skip ${rs.skip.length} done · re-run ${rs.eligible.length} eligible · ${Object.keys(rs.dep_blocked).length} dep-blocked`);
    console.log(JSON.stringify(rs, null, 2));
  }
}

// ── main ────────────────────────────────────────────────────────────────────────
const dir = findRunsDir();
const runs = loadRuns(dir);
const wantList = flag('--list');
const wantJson = flag('--json');
const wantResume = flag('--resume');
const idArg = positional[0];

function pick(id) {
  if (!id) return runs.find((r) => r.doc) || runs[0]; // newest readable
  const m = runs.find((r) => (r.doc?.id === id) || r.name === id || r.name === `${id}.json`)
        || runs.find((r) => (r.doc?.id || r.name).startsWith(id));
  return m;
}

if (wantList) {
  if (wantJson) console.log(JSON.stringify(runs.map((r) => r.doc || { file: r.file, error: r.err }), null, 2));
  else renderList(runs, dir);
  process.exit(0);
}

if (!runs.length) {
  console.log(dim(`no runs found under ${dir}`));
  console.log(dim('(a pipeline creates one at .ulpi/runs/<id>.json when it launches)'));
  process.exit(0);
}

const target = pick(idArg);
if (!target) { console.error(red(`no run matches "${idArg}" under ${dir}`)); process.exit(3); }

if (wantResume) renderResume(target);
else if (wantJson) console.log(JSON.stringify(target.doc ?? { file: target.file, error: target.err }, null, 2));
else render(target, dir);
