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
//   node run-status.mjs --resume [id]    # print the shell-safe Codex resume command for this run
//   node run-status.mjs --resume --json  # emit ONLY the typed resume descriptor (argv array, no shell)
//   node run-status.mjs --dir <path>     # look in <path> instead of the auto-discovered .ulpi/runs
//   node run-status.mjs --no-color       # plain text (also honors NO_COLOR)
//
// Resume recipe — Codex-native, argv-safe. A run whose persisted `launch` is the coordinator recipe
// ({ scriptPath: …/pipeline.mjs, args:{ command:'resume', run } }) is RUNNABLE: `--resume` prints the
// exact shell-safe command `node pipeline.mjs resume --run <id>` (the id is passed as a discrete argv
// token — never string-interpolated into a shell — and defensively quoted if it isn't a bare token).
// A LEGACY launch (a Claude Workflow() script such as pipeline-workflow.js), or an absent/malformed one,
// is labeled MIGRATION-ONLY / non-runnable and is NEVER presented as a runnable Codex command.
//
// Exit codes: 0 ok (incl. "no runs found") · 1 usage error · 3 requested run id not found.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { readWorkflowStatus } from './lib/workflow-journal.mjs';

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
function projectRootForRunsDir(dir) {
  const ulpiDir = dirname(dir);
  if (basename(dir) === 'runs' && basename(ulpiDir) === '.ulpi') return dirname(ulpiDir);
  return process.cwd();
}

// ── status vocabulary ───────────────────────────────────────────────────────────
const RUN_BADGE = {
  running: cyn('◐ running'), initializing: cyn('◐ initializing'),
  needs_attention: ylw('▲ needs attention'), done: grn('● done'), aborted: red('✗ aborted'),
};
const PH_GLYPH = { done: grn('●'), running: cyn('◐'), blocked: red('✗'), skipped: dim('·'), pending: dim('○') };
const PHASE_ORDER = ['build', 'simplify', 'test', 'review', 'performance', 'ship_prep', 'auto_learn', 'auto_map', 'finalize'];
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
  // External Claude session state is deliberately an optional overlay. The durable document above and
  // below renders identically whether this returns data or null; overlay absence/format drift cannot
  // downgrade a durable unit/run status or block status inspection.
  const live = readWorkflowStatus(projectRootForRunsDir(dir));

  console.log();
  console.log(`  ${bold(d.id || r.name)}   ${RUN_BADGE[d.status] || d.status}`);
  if (d.task) console.log(`  ${dim('task    ')}${d.task}`);
  const started = d.createdAt ? rel(d.createdAt) : '?';
  const took = d.finishedAt && d.createdAt ? `  ${dim('·')} ran ${dur(d.createdAt, d.finishedAt)}` : '';
  console.log(`  ${dim('started ')}${started}   ${dim('·')} updated ${rel(d.updatedAt)}${took}`);
  console.log(`  ${dim('file    ')}${dim(r.file)}`);

  // Integration branch (coordinator runs stamp it under `pipeline`) — where per-task work is serialized
  // before it reaches the target ref. Shown short (the ref tail), with the publish target when present.
  const meta = (d.pipeline && typeof d.pipeline === 'object') ? d.pipeline : {};
  const intRef = meta.integrationRef, tgtRef = meta.targetRef;
  if (intRef || tgtRef) {
    const short = (ref) => String(ref).replace(/^refs\/heads\//, '');
    const arrow = (intRef && tgtRef) ? `${cyn(short(intRef))} ${dim('→')} ${short(tgtRef)}` : short(intRef || tgtRef);
    console.log(`  ${dim('branch  ')}${arrow}   ${dim(intRef && tgtRef ? '(integration → target)' : intRef ? '(integration)' : '(target)')}`);
  }

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
    // A lost checkpoint write recovered from the durable git log becomes the existing `done` state with
    // this note. Surface that provenance even though ordinary done units stay compact.
    for (const id of b.done) {
      const note = d.units[id]?.note;
      if (typeof note === 'string' && note.startsWith('reconciled-from-trailer')) {
        console.log(`          ${grn('↺')} ${id}${dim(' — ' + note)}`);
      }
    }
  }

  console.log();
  if (live) {
    const running = live.running.length
      ? ` ${dim('(' + live.running.slice(0, 6).join(', ') + (live.running.length > 6 ? ', …' : '') + ')')}`
      : '';
    const age = live.stale ? ylw(` · stale (${rel(live.mtime)})`) : dim(` · updated ${rel(live.mtime)}`);
    console.log(`  ${dim('Live workflow')}  ${cyn(live.wf)} · ${live.done} done · ${live.running.length} running${running}${age}`);
    const gap = live.spawned - b.done.length;
    const warning = gap > 0 ? ylw(` · ${gap} more agent start(s) than durable done unit(s)`) : '';
    console.log(`  ${dim('divergence')}     live agents ${live.spawned} vs durable units ${b.done.length}/${total}${warning}`);
  } else {
    console.log(`  ${dim('Live workflow')}  ${dim('no live workflow transcript found — use /workflows for runtime details; durable status remains authoritative')}`);
  }

  // Findings register: the UNRESOLVED (open) findings that gate finalize, plus a one-line count of the
  // durable RESOLVED audit trail (v2 `resolvedItems`) so a converged run still shows what was cleared.
  const items = Array.isArray(d.openItems) ? d.openItems : [];
  const resolved = Array.isArray(d.resolvedItems) ? d.resolvedItems : [];
  if (items.length || resolved.length) {
    console.log();
    console.log(`  ${dim('open')}    ${items.length ? `${items.length} unresolved finding(s) in the register` : grn('0 unresolved — register clear')}`);
    for (const it of items.slice(0, 10)) {
      const label = [it.phase, it.kind].filter(Boolean).join('/');
      const why = it.why || it.issue || it.summary || (it.task ? `task ${it.task}` : '') || JSON.stringify(it).slice(0, 90);
      console.log(`          ${ylw('•')} ${dim((label || '?').padEnd(18))} ${String(why).slice(0, 96)}`);
    }
    if (items.length > 10) console.log(dim(`          … +${items.length - 10} more`));
    if (resolved.length) console.log(`  ${dim('resolved')} ${resolved.length} finding(s) cleared from the register (audit trail)`);
  }

  // Final validation — the run's terminal workspace verdict (green gates finalize done; red/absent is honest).
  if (d.finalValidation && typeof d.finalValidation === 'object') {
    const fv = d.finalValidation;
    const green = fv.status === 'green';
    const badge = green ? grn('✓ validation green') : red(`✗ validation ${fv.status || 'unknown'}`);
    const note = fv.note ? dim(` — ${fv.note}`) : '';
    console.log();
    console.log(`  ${dim('final   ')}${badge}${note}`);
  }

  if (d.result != null) {
    console.log();
    const rs = typeof d.result === 'object' ? (d.result.status || JSON.stringify(d.result)) : d.result;
    const extra = (d.result && typeof d.result === 'object' && d.result.summary) ? ` — ${d.result.summary}` : '';
    console.log(`  ${dim('result')}  ${rs}${extra}`);
  }

  // Honest terminal state + resume affordance. A done run says done; an aborted run says aborted and is
  // NOT presented as resumable; a live/needs-attention run gets the real resume recipe — the Codex-native
  // command when its launch is runnable, otherwise a migration-only pointer (never a fake command).
  const hasOpen = isLive(d) || b.blocked.length || b.dep_blocked.length || b.pending.length || b.in_progress.length;
  console.log();
  if (d.status === 'done') {
    console.log(`  ${grn('●')} done — this run converged and finalized.`);
  } else if (d.status === 'aborted') {
    console.log(`  ${red('✗')} aborted — this run was terminated and is not resumable as-is; re-approve to start over.`);
  } else if (hasOpen) {
    const desc = resumeDescriptor(d);
    if (desc.runnable) {
      console.log(`  ${dim('resume')}  ${desc.shell}`);
    } else if (desc.kind === 'legacy-workflow') {
      console.log(`  ${dim('resume')}  ${ylw('migration-only')} — persisted launch is a Claude Workflow, not a Codex command. Details: node ${SELF} --resume ${d.id || ''}`.trimEnd());
    } else {
      console.log(`  ${dim('resume')}  ${ylw('non-runnable')} — no coordinator launch recipe. Details: node ${SELF} --resume ${d.id || ''}`.trimEnd());
    }
  } else {
    console.log(`  ${grn('✓')} nothing pending — this run is complete.`);
  }
  console.log();
}

// ── resume recipe ──────────────────────────────────────────────────────────────
function resumeSet(units) {
  const skip = [], eligible = [], depBlocked = {};
  const u = units || {};
  // A malformed/foreign checkpoint can hold a null (or non-object) unit value and still parse as JSON —
  // resumeSet is on the READ-ONLY render path (the footer) and must never crash on one.
  for (const [id, unit] of Object.entries(u)) {
    if (unit?.status === 'done') { skip.push(id); continue; }
    const missing = (unit?.dependsOn || []).filter((d) => u[d]?.status !== 'done');
    if (missing.length) {
      let root = missing[0]; const seen = new Set();
      while (!seen.has(root)) { seen.add(root); const next = (u[root]?.dependsOn || []).find((d) => u[d]?.status !== 'done'); if (!next) break; root = next; }
      depBlocked[id] = root;
    } else eligible.push(id);
  }
  return { skip, eligible, dep_blocked: depBlocked };
}
// argv-safe shell quoting: a bare token is emitted verbatim; anything else is single-quoted (with the
// POSIX '\'' escape) so the printed command is safe to paste even for an exotic run id. We NEVER build
// the command by interpolating the id into a shell template — it is a discrete argv token that we quote.
function shquote(s) {
  const str = String(s);
  return /^[A-Za-z0-9._/@:=+-]+$/.test(str) ? str : `'${str.replace(/'/g, `'\\''`)}'`;
}

// Classify a run's persisted launch descriptor into the resume recipe it authorizes.
//   codex-cli      → RUNNABLE: launch is the coordinator recipe (…/pipeline.mjs, args.command==='resume').
//   legacy-workflow→ non-runnable: a Claude Workflow() script (e.g. pipeline-workflow.js) — migration only.
//   no-launch      → non-runnable: nothing persisted (a pre-coordinator / hand-rolled checkpoint).
function classifyLaunch(doc) {
  const launch = doc && doc.launch;
  if (!launch || typeof launch !== 'object' || Array.isArray(launch) || typeof launch.scriptPath !== 'string' || launch.scriptPath.trim() === '') {
    return { kind: 'no-launch' };
  }
  const args = (launch.args && typeof launch.args === 'object' && !Array.isArray(launch.args)) ? launch.args : {};
  if (basename(launch.scriptPath) === 'pipeline.mjs' && args.command === 'resume'
      && typeof args.run === 'string' && args.run.trim() !== '') {
    return { kind: 'codex-cli', run: args.run };
  }
  return { kind: 'legacy-workflow', launch };
}

// The typed resume descriptor — the single object `--resume --json` emits. Purely a projection of the
// durable doc (READ-ONLY). For a runnable run it carries the argv array AND a ready-to-paste shell string;
// for a non-runnable one it is flagged { runnable:false, migrationOnly:true } with the reason.
function resumeDescriptor(doc) {
  const set = resumeSet(doc.units);
  const cls = classifyLaunch(doc);
  if (cls.kind === 'codex-cli') {
    const argv = ['pipeline.mjs', 'resume', '--run', cls.run];
    return {
      runnable: true, kind: 'codex-cli', run: cls.run,
      command: 'node', argv,
      shell: `node ${argv.map(shquote).join(' ')}`,
      resumeSet: set,
    };
  }
  if (cls.kind === 'legacy-workflow') {
    return {
      runnable: false, kind: 'legacy-workflow', migrationOnly: true,
      reason: 'persisted launch is a Claude Workflow() script, not a Codex CLI recipe — it is not runnable as a shell command',
      legacyLaunch: cls.launch,
      resumeSet: set,
    };
  }
  return {
    runnable: false, kind: 'no-launch', migrationOnly: true,
    reason: 'no Codex-native launch recipe was persisted (pre-coordinator or hand-rolled run) — re-approve/relaunch via pipeline.mjs',
    resumeSet: set,
  };
}

function renderResume(r, asJson) {
  const d = r.doc;
  if (!d) {
    if (asJson) { console.log(JSON.stringify({ runnable: false, kind: 'unreadable', migrationOnly: true, reason: r.err, file: r.file }, null, 2)); return; }
    console.log(red(`! ${r.name} is unreadable: ${r.err}`)); return;
  }
  const desc = resumeDescriptor(d);
  if (asJson) { console.log(JSON.stringify(desc, null, 2)); return; } // ONLY the typed descriptor — nothing else

  const set = desc.resumeSet;
  const setLine = `// skip ${set.skip.length} done · re-run ${set.eligible.length} eligible · ${Object.keys(set.dep_blocked).length} dep-blocked`;
  if (desc.runnable) {
    console.log('// Resume with the Codex-native pipeline coordinator — reads the durable checkpoint, skips done units:');
    console.log(desc.shell);
    console.log(setLine);
  } else if (desc.kind === 'legacy-workflow') {
    // Keep the read-only migration inspection: echo the persisted descriptor with statusFile re-pinned to
    // THIS run — but label it MIGRATION-ONLY. This is a Claude Workflow() launch, never a runnable command.
    const args = { ...(desc.legacyLaunch.args || {}) };
    if (!args.statusFile) args.statusFile = r.file;
    console.log('// MIGRATION ONLY — this run\'s persisted launch is a Claude Workflow() script, NOT a runnable Codex command.');
    console.log('// Do NOT run it as a shell command. To resume under the coordinator, re-approve/relaunch via pipeline.mjs.');
    console.log('// The original Workflow launch (statusFile re-pinned to this run) for migration reference only:');
    console.log(setLine);
    console.log(JSON.stringify({ scriptPath: desc.legacyLaunch.scriptPath, args }, null, 2));
  } else {
    console.log('// NON-RUNNABLE — no Codex-native launch recipe was persisted (pre-coordinator or hand-rolled run).');
    console.log('// Relaunch via the coordinator: node pipeline.mjs approve … then node pipeline.mjs start --run <id>.');
    console.log(setLine);
    console.log(JSON.stringify(set, null, 2));
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

if (wantResume) renderResume(target, wantJson);
else if (wantJson) console.log(JSON.stringify(target.doc ?? { file: target.file, error: target.err }, null, 2));
else render(target, dir);
