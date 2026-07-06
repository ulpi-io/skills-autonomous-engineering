#!/usr/bin/env node
// checkpoint.mjs — the runnable side of the checkpoint-resume skill.
// Zero-dependency Node CLI for the durable status file (.ulpi/runs/<id>.json):
//   init, patch a unit/phase, query, compute the resume set, finalize.
// All writes are ATOMIC (tmp + rename) and INCREMENTAL (read-modify-write), and every
// command is NON-FATAL by design at the call site: `node checkpoint.mjs ... || true`.
//
// Usage:
//   node checkpoint.mjs init <file> --task "<desc>" [--units "a,b,c"] [--id <id>]
//   node checkpoint.mjs unit <file> <unit-id> <pending|in_progress|done|blocked|dep_blocked> [--note "<why>"] [--deps "x,y"]
//   node checkpoint.mjs phase <file> <phase> <pending|running|done|blocked|skipped>
//   node checkpoint.mjs get <file> [--summary]
//   node checkpoint.mjs resume <file>          # prints JSON { skip: [...], eligible: [...], dep_blocked: {unit: rootDep} }
//   node checkpoint.mjs item <file> --json '<object-or-array>'   # append durable openItems (register persistence)
//   node checkpoint.mjs finalize <file> <done|needs_attention|aborted> [--result "<summary>"]
//   node checkpoint.mjs gc <dir> [--keep-days 7]   # archive TERMINAL runs older than N days (never touches running)
//
// Exit codes: 0 ok · 1 usage/parse error · 2 refused (e.g. init would clobber a live checkpoint)

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmdirSync, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function fail(msg, code = 1) { console.error(`checkpoint: ${msg}`); process.exit(code); }

function readDoc(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { fail(`cannot read/parse ${file}: ${e.message}`); }
}

function writeDoc(file, doc) {
  doc.updatedAt = now();
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  renameSync(tmp, file); // atomic on same filesystem
}

// Concurrent writers (parallel agents each finishing a unit) race on read-modify-write:
// atomic rename alone prevents torn FILES but still LOSES updates. Serialize mutations with a
// mkdir lock (mkdir is atomic on POSIX). Stale locks (>5s — a crashed holder) are stolen.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let ownedLock = null;
process.on('exit', () => { if (ownedLock) { try { rmdirSync(ownedLock); } catch {} } });  // a refusal (process.exit) inside the lock must still release it
function withLock(file, fn) {
  const lock = `${file}.lock`;
  for (let i = 0; i < 400; i++) {           // ~4s worst-case wait
    try { mkdirSync(lock); }
    catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 5000) { rmdirSync(lock); continue; } } catch {}
      sleep(10); continue;
    }
    ownedLock = lock;
    try { return fn(); }
    finally { try { rmdirSync(lock); } catch {} ownedLock = null; }
  }
  fail(`could not acquire lock on ${file} (stuck ${lock}?)`);
}

function opt(args, name, dflt = undefined) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
}

const [cmd, file, ...rest] = process.argv.slice(2);
if (!cmd || !file) fail('usage: checkpoint.mjs <init|unit|phase|get|resume|finalize> <file> ...');

const UNIT_STATES = ['pending', 'in_progress', 'done', 'blocked', 'dep_blocked'];
const PHASE_STATES = ['pending', 'running', 'done', 'blocked', 'skipped'];

switch (cmd) {
  case 'init': {
    // REFUSE to clobber a live checkpoint — resume means skip-done, never re-init.
    if (existsSync(file)) {
      const cur = readDoc(file);
      if (['running', 'needs_attention', 'initializing'].includes(cur.status)) {
        fail(`${file} is a LIVE checkpoint (status=${cur.status}). Resume it — do not re-init. (Delete the file only if you explicitly intend to discard the run.)`, 2);
      }
    }
    const task = opt(rest, '--task') ?? fail('init requires --task "<desc>"');
    const id = opt(rest, '--id', `run-${now().replace(/[:.]/g, '').replace('T', '-').replace('Z', 'Z')}`);
    const units = {};
    for (const u of (opt(rest, '--units', '') || '').split(',').map(s => s.trim()).filter(Boolean)) {
      units[u] = { status: 'pending', dependsOn: [], note: '' };
    }
    mkdirSync(dirname(file), { recursive: true });
    writeDoc(file, {
      schemaVersion: 1, id, task, status: 'running',
      createdAt: now(), updatedAt: now(),
      phases: {}, units, openItems: [], result: null,
    });
    console.log(id);
    break;
  }

  case 'unit': {
    withLock(file, () => {
      const [unit, status] = rest;
      if (!unit || !UNIT_STATES.includes(status)) fail(`unit requires <unit-id> <${UNIT_STATES.join('|')}>`);
      const doc = readDoc(file);
      doc.units ??= {};
      const u = (doc.units[unit] ??= { status: 'pending', dependsOn: [], note: '' });
      // Guard the load-bearing rule: done is terminal-forward; a done unit is never quietly demoted.
      if (u.status === 'done' && status !== 'done') {
        fail(`unit '${unit}' is already done — refusing to demote it (resume must skip done units)`, 2);
      }
      u.status = status;
      const note = opt(rest, '--note'); if (note !== undefined) u.note = note;
      const deps = opt(rest, '--deps'); if (deps !== undefined) u.dependsOn = deps.split(',').map(s => s.trim()).filter(Boolean);
      if (status === 'in_progress' && !u.startedAt) u.startedAt = now();
      if (['done', 'blocked', 'dep_blocked'].includes(status)) u.finishedAt = now();
      writeDoc(file, doc);
    });
    break;
  }

  case 'phase': {
    withLock(file, () => {
      const [phase, status] = rest;
      if (!phase || !PHASE_STATES.includes(status)) fail(`phase requires <phase> <${PHASE_STATES.join('|')}>`);
      const doc = readDoc(file);
      doc.phases ??= {};
      doc.phases[phase] = { ...(doc.phases[phase] || {}), status };
      if (status === 'running') doc.currentPhase = phase;
      writeDoc(file, doc);
    });
    break;
  }

  case 'get': {
    const doc = readDoc(file);
    if (rest.includes('--summary')) {
      const units = Object.entries(doc.units || {});
      const by = s => units.filter(([, u]) => u.status === s).map(([k]) => k);
      console.log(JSON.stringify({
        id: doc.id, status: doc.status, task: doc.task, currentPhase: doc.currentPhase ?? null,
        total: units.length, done: by('done').length,
        blocked: by('blocked'), dep_blocked: by('dep_blocked'), in_progress: by('in_progress'),
        updatedAt: doc.updatedAt,
      }, null, 2));
    } else {
      console.log(JSON.stringify(doc, null, 2));
    }
    break;
  }

  case 'resume': {
    // The skip-done contract, computed: done → skip; everything else re-eligible IFF deps are done;
    // a unit whose dependency chain isn't done is dep_blocked, pointing at the root.
    const doc = readDoc(file);
    const units = doc.units || {};
    const skip = [], eligible = [], depBlocked = {};
    for (const [id, u] of Object.entries(units)) {
      if (u.status === 'done') { skip.push(id); continue; }
      const missing = (u.dependsOn || []).filter(d => units[d]?.status !== 'done');
      if (missing.length) depBlocked[id] = missing[0];
      else eligible.push(id); // pending, in_progress (interrupted), and blocked are all re-eligible
    }
    console.log(JSON.stringify({ skip, eligible, dep_blocked: depBlocked }, null, 2));
    break;
  }

  case 'item': {
    // Append durable openItems — how a workflow persists register entries the moment a phase ends,
    // so a resume rebuilds the register instead of re-running completed phases (any-point resume).
    withLock(file, () => {
      const raw = opt(rest, '--json') ?? fail('item requires --json \'<object-or-array>\'');
      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) { fail(`item --json is not valid JSON: ${e.message}`); }
      const doc = readDoc(file);
      doc.openItems ??= [];
      doc.openItems.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      writeDoc(file, doc);
    });
    break;
  }

  case 'gc': {
    // Retention: archive TERMINAL (done/needs_attention/aborted) runs older than --keep-days into
    // <dir>/archive/. NEVER touches running runs. Keeps session-start announcements and guard
    // scoping from being armed forever by long-dead checkpoints.
    const keepDays = Number(opt(rest, '--keep-days', '7'));
    const dir = file; // second positional is the runs DIRECTORY for gc
    if (!existsSync(dir)) { console.log('0 archived (no runs dir)'); break; }
    const cutoff = Date.now() - keepDays * 86400_000;
    let archived = 0;
    for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
      const fp = join(dir, f);
      let doc; try { doc = JSON.parse(readFileSync(fp, 'utf8')); } catch { continue; }
      if (doc.status === 'running' || doc.status === 'initializing') continue;
      const ts = Date.parse(doc.updatedAt || 0);
      if (Number.isFinite(ts) && ts > cutoff) continue;
      mkdirSync(join(dir, 'archive'), { recursive: true });
      renameSync(fp, join(dir, 'archive', f));
      archived++;
    }
    console.log(`${archived} archived to ${dir}/archive (terminal runs older than ${keepDays}d)`);
    break;
  }

  case 'finalize': {
    withLock(file, () => {
      const [status] = rest;
      if (!['done', 'needs_attention', 'aborted'].includes(status)) fail('finalize requires <done|needs_attention|aborted>');
      const doc = readDoc(file);
      // Fail closed: refuse "done" while units are not all done.
      const open = Object.entries(doc.units || {}).filter(([, u]) => u.status !== 'done').map(([k]) => k);
      if (status === 'done' && open.length) {
        fail(`refusing finalize done — ${open.length} unit(s) not done: ${open.join(', ')} (use needs_attention)`, 2);
      }
      doc.status = status;
      const result = opt(rest, '--result'); if (result !== undefined) doc.result = result;
      writeDoc(file, doc);
    });
    break;
  }

  default:
    fail(`unknown command '${cmd}'`);
}
