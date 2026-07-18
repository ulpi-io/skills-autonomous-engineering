// checkpoint-store.mjs — the importable, locked read-modify-write STORE behind the checkpoint-resume
// skill. checkpoint.mjs (the CLI) and any in-process engine both import THIS module, so they share ONE
// atomic, mkdir-locked store instead of racing two parallel implementations. Zero external deps.
//
// Contract preserved from the original CLI:
//   * every write is ATOMIC (tmp + rename) and INCREMENTAL (read-modify-write),
//   * concurrent writers are SERIALIZED by an atomic mkdir lock (stale locks stolen via atomic rename),
//   * `done` is terminal-forward (a done unit is never demoted),
//   * finalize `done` is FAIL-CLOSED (refuses while any end-state fact is still open),
//   * every mutation is TIMESTAMPED (ISO-8601 UTC).
//
// Operations THROW `CheckpointError` (carrying an exit `code`) instead of calling process.exit, so an
// engine can catch them; the CLI translates the code into its process exit status. `code` 1 = usage/parse
// (bad input); `code` 2 = a state REFUSAL (clobber a live run / demote a done unit / finalize-done with
// open work). Store-write failures (EACCES, ENOSPC, rename errors) are NOT swallowed — they propagate.
//
// schemaVersion: new runs are written at v2 (stable-id findings + durable resolvedItems + typed launch).
// A v1 run loads, resumes and finalizes UNCHANGED; the only modification on a mutating write is an
// idempotent, ADD-ONLY in-place upgrade (resolvedItems:[] + schemaVersion bump) that never rewrites
// existing units/phases/openItems/launch — an in-flight v1 run is never broken.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmdirSync, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 2;
export const UNIT_STATES = ['pending', 'in_progress', 'done', 'blocked', 'dep_blocked'];
export const PHASE_STATES = ['pending', 'running', 'done', 'blocked', 'skipped'];

export class CheckpointError extends Error {
  constructor(message, code = 1) { super(message); this.name = 'CheckpointError'; this.code = code; }
}
function fail(msg, code = 1) { throw new CheckpointError(msg, code); }

export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// ── low-level doc IO ────────────────────────────────────────────────────────────
export function readDoc(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { fail(`cannot read/parse ${file}: ${e.message}`); }
}

export function writeDoc(file, doc) {
  doc.updatedAt = now();
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n'); // throws (EACCES/ENOSPC) propagate — never swallowed
  renameSync(tmp, file); // atomic on same filesystem; a rename error propagates too
}

// Idempotent, ADD-ONLY in-place upgrade of an older-schema doc. NEVER rewrites existing data — an
// in-flight v1 run keeps its exact units/phases/openItems/launch; we only add missing v2 fields.
export function upgradeDoc(doc) {
  doc.openItems ??= [];
  doc.resolvedItems ??= [];
  if (!(doc.schemaVersion >= SCHEMA_VERSION)) doc.schemaVersion = SCHEMA_VERSION;
  return doc;
}

// Read for a MUTATING operation: load + upgrade in memory (the paired writeDoc persists the upgrade).
function readForWrite(file) { return upgradeDoc(readDoc(file)); }

// ── the mkdir lock (see the original CLI for the full stale-steal proof) ─────────
// Concurrent writers race on read-modify-write; atomic rename prevents torn files but still LOSES
// updates. Serialize with a mkdir lock (mkdir is atomic on POSIX). A crashed holder leaves a stale
// lock (>5s); steal it via an ATOMIC RENAME (single-winner arbiter), never a bare rmdir.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let ownedLock = null;
process.on('exit', () => { if (ownedLock) { try { rmdirSync(ownedLock); } catch {} } }); // backstop if a throw escapes finally

export function withLock(file, fn) {
  const lock = `${file}.lock`;
  for (let i = 0; i < 800; i++) {           // ~8s worst-case wait — MUST exceed the 5s stale threshold
    try { mkdirSync(lock); }
    catch (e) {
      // ENOENT (parent missing) / EACCES (unwritable dir) will never clear by waiting — fail fast so the
      // store-write failure PROPAGATES instead of spinning for 8s then erroring anyway.
      if (e.code === 'ENOENT') fail(`parent directory of ${file} does not exist — init creates it; check the path`);
      if (e.code === 'EACCES' || e.code === 'EPERM') fail(`cannot write lock for ${file}: ${e.code} (unwritable directory?)`);
      // The lock is held. Steal ONLY if stale, and ONLY via atomic rename (the single-winner arbiter).
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5000) {
          const tomb = `${lock}.dead.${process.pid}.${i}`;
          renameSync(lock, tomb);           // throws ENOENT for every stealer but the one that wins
          try { rmdirSync(tomb); } catch {}
        }
      } catch {}                            // lost the steal race (ENOENT) or not stale → wait and retry
      sleep(10); continue;
    }
    ownedLock = lock;
    try { return fn(); }
    finally { try { rmdirSync(lock); } catch {} ownedLock = null; } // released even when fn() throws (a refusal)
  }
  fail(`could not acquire lock on ${file} (stuck ${lock}?)`);
}

// ── typed launch-descriptor validation ──────────────────────────────────────────
// A launch descriptor persists the exact resume recipe so the run can be relaunched from the status
// file alone. It must be typed: { scriptPath: <non-empty string>, args?: <object> }. An invalid
// descriptor REFUSES init before any checkpoint is written.
export function validateLaunch(launch) {
  if (launch === null || typeof launch !== 'object' || Array.isArray(launch))
    fail('--launch must be a JSON object { scriptPath, args } — got ' + (Array.isArray(launch) ? 'an array' : typeof launch));
  if (typeof launch.scriptPath !== 'string' || launch.scriptPath.trim() === '')
    fail('--launch.scriptPath must be a non-empty string (the relaunch recipe is unusable without it)');
  if ('args' in launch && (launch.args === null || typeof launch.args !== 'object' || Array.isArray(launch.args)))
    fail('--launch.args must be a JSON object when present');
  return launch;
}

// ── stable finding IDs ──────────────────────────────────────────────────────────
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}
// A finding's stable id is its explicit `id` if given, else a deterministic content hash (excluding the
// volatile `at`/`id` fields) — so re-reporting the SAME finding upserts in place instead of duplicating.
export function stableId(item) {
  if (typeof item.id === 'string' && item.id.trim() !== '') return item.id;
  const { at, id, ...content } = item;
  return 'f-' + createHash('sha1').update(JSON.stringify(sortKeys(content))).digest('hex').slice(0, 12);
}

// ── operations ──────────────────────────────────────────────────────────────────
export function init(file, { task, id, units = [], requiredPhases = [], requireValidation = false, launch } = {}) {
  if (!task) fail('init requires a task description');
  // Validate the launch descriptor BEFORE touching the filesystem — an invalid descriptor must refuse
  // init WITHOUT creating a checkpoint (no dir, no lock, no file).
  const launchTyped = launch !== undefined ? validateLaunch(launch) : undefined;
  mkdirSync(dirname(file), { recursive: true });
  return withLock(file, () => {
    // REFUSE to clobber a live checkpoint — resume means skip-done, never re-init.
    if (existsSync(file)) {
      const cur = readDoc(file);
      if (['running', 'needs_attention', 'initializing'].includes(cur.status)) {
        fail(`${file} is a LIVE checkpoint (status=${cur.status}). Resume it — do not re-init. (Delete the file only if you explicitly intend to discard the run.)`, 2);
      }
    }
    const stamp = now();
    const unitsObj = {};
    for (const u of units) {
      // A unit born with whitespace would be permanently un-updatable (the `unit` op rejects /[,\s]/),
      // so the run could never finalize done — refuse it at birth.
      if (/\s/.test(u)) fail(`unit id '${u}' contains whitespace — ids must be shell-safe tokens (the 'unit' command rejects them, so it could never be marked done)`);
      unitsObj[u] = { status: 'pending', dependsOn: [], note: '', createdAt: stamp, updatedAt: stamp };
    }
    const runId = id ?? `run-${stamp.replace(/[:.]/g, '').replace('T', '-').replace('Z', 'Z')}`;
    writeDoc(file, {
      schemaVersion: SCHEMA_VERSION, id: runId, task, status: 'running',
      createdAt: stamp, updatedAt: stamp,
      phases: {}, units: unitsObj, openItems: [], resolvedItems: [], result: null,
      ...(requiredPhases.length ? { requiredPhases } : {}),
      ...(requireValidation ? { requireValidation: true } : {}),
      ...(launchTyped !== undefined ? { launch: launchTyped } : {}),
    });
    return runId;
  });
}

export function unit(file, unitId, status, { note, deps } = {}) {
  if (!unitId || !UNIT_STATES.includes(status)) fail(`unit requires <unit-id> <${UNIT_STATES.join('|')}>`);
  if (/[,\s]/.test(unitId)) fail(`unit id '${unitId}' contains commas/whitespace — inexpressible in --units and unsafe in shell one-liners`);
  return withLock(file, () => {
    const doc = readForWrite(file);
    doc.units ??= {};
    const stamp = now();
    const u = (doc.units[unitId] ??= { status: 'pending', dependsOn: [], note: '', createdAt: stamp });
    // done is terminal-forward; a done unit is never quietly demoted (resume must skip done units).
    if (u.status === 'done' && status !== 'done') {
      fail(`unit '${unitId}' is already done — refusing to demote it (resume must skip done units)`, 2);
    }
    u.status = status;
    if (note !== undefined) u.note = note;
    if (deps !== undefined) u.dependsOn = Array.isArray(deps) ? deps : String(deps).split(',').map(s => s.trim()).filter(Boolean);
    if (status === 'in_progress' && !u.startedAt) u.startedAt = stamp;
    if (['done', 'blocked', 'dep_blocked'].includes(status)) u.finishedAt = stamp;
    u.updatedAt = stamp;
    writeDoc(file, doc);
  });
}

export function phase(file, phaseName, status) {
  if (!phaseName || !PHASE_STATES.includes(status)) fail(`phase requires <phase> <${PHASE_STATES.join('|')}>`);
  return withLock(file, () => {
    const doc = readForWrite(file);
    doc.phases ??= {};
    const stamp = now();
    const ph = { ...(doc.phases[phaseName] || {}), status, updatedAt: stamp };
    if (status === 'running' && !ph.startedAt) ph.startedAt = stamp;
    if (['done', 'blocked', 'skipped'].includes(status)) ph.finishedAt = stamp;
    doc.phases[phaseName] = ph;
    if (status === 'running') doc.currentPhase = phaseName;
    writeDoc(file, doc);
  });
}

// Idempotent finding upsert. Objects gain a STABLE id and are deduped by it — re-reporting the same
// finding updates in place (preserving first-seen `at`) instead of appending a duplicate. Non-object
// items are appended verbatim (back-compat). Returns the stable ids assigned/updated.
export function item(file, itemsInput) {
  return withLock(file, () => {
    const doc = readForWrite(file);
    doc.openItems ??= [];
    const stamp = now();
    const incoming = Array.isArray(itemsInput) ? itemsInput : [itemsInput];
    const ids = [];
    for (const raw of incoming) {
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const id = stableId(raw);
        const idx = doc.openItems.findIndex(x => x && x.id === id);
        if (idx >= 0) {
          const prev = doc.openItems[idx];
          doc.openItems[idx] = { at: prev.at || stamp, ...raw, id }; // idempotent: keep first-seen `at`
        } else {
          doc.openItems.push({ at: stamp, ...raw, id }); // item keeping its own `at` still wins (raw overrides)
        }
        ids.push(id);
      } else {
        doc.openItems.push(raw);
      }
    }
    writeDoc(file, doc);
    return ids;
  });
}

// Resolve findings by stable id: MOVE each from openItems into the durable resolvedItems (stamped
// resolvedAt). Idempotent — an id not currently open (unknown or already resolved) is a no-op. Returns
// the ids actually moved. This is what clears the finalize-done "open findings" gate.
export function resolve(file, ids) {
  return withLock(file, () => {
    const doc = readForWrite(file);
    doc.openItems ??= [];
    doc.resolvedItems ??= [];
    const stamp = now();
    const moved = [];
    for (const id of ids) {
      const idx = doc.openItems.findIndex(x => x && x.id === id);
      if (idx >= 0) {
        const [it] = doc.openItems.splice(idx, 1);
        doc.resolvedItems.push({ ...it, resolvedAt: stamp });
        moved.push(id);
      }
    }
    writeDoc(file, doc);
    return moved;
  });
}

// Record the run's FINAL validation result. finalize done refuses (when requireValidation is set) unless
// this is present and green. Normalizes pass/ok→green, fail→red.
export function validation(file, status, { note } = {}) {
  const norm = { green: 'green', pass: 'green', ok: 'green', red: 'red', fail: 'red' }[status];
  if (!norm) fail('validation requires <green|red> (aliases: pass/ok/fail)');
  return withLock(file, () => {
    const doc = readForWrite(file);
    doc.finalValidation = { status: norm, at: now(), ...(note !== undefined ? { note } : {}) };
    writeDoc(file, doc);
  });
}

// READ-ONLY. The skip-done contract, computed. Never writes — a v1 run resumes byte-for-byte unchanged.
export function resume(file) {
  const doc = readDoc(file);
  const units = doc.units || {};
  const skip = [], eligible = [], depBlocked = {};
  for (const [id, u] of Object.entries(units)) {
    if (u.status === 'done') { skip.push(id); continue; }
    const missing = (u.dependsOn || []).filter(d => units[d]?.status !== 'done');
    if (missing.length) {
      let root = missing[0];   // walk to the CHAIN ROOT — triage must point at the real cause
      const seen = new Set();
      while (!seen.has(root)) {
        seen.add(root);
        const next = (units[root]?.dependsOn || []).find(d => units[d]?.status !== 'done');
        if (!next) break;
        root = next;
      }
      depBlocked[id] = root;
    } else eligible.push(id); // pending, in_progress (interrupted), and blocked are all re-eligible
  }
  return { skip, eligible, dep_blocked: depBlocked };
}

function scopeCoverageProblems(scopeCoverage) {
  const problems = [];
  const seen = new Map();
  if (!Number.isInteger(scopeCoverage.total) || scopeCoverage.total < 1) problems.push('selected-scope coverage total is invalid');
  for (const group of ['covered', 'dropped', 'uncovered']) {
    if (!Array.isArray(scopeCoverage[group])) { problems.push(`selected-scope coverage ${group} is not an array`); continue; }
    for (const id of scopeCoverage[group]) {
      if (typeof id !== 'string' || id.trim() === '') { problems.push(`${group} contains an invalid selected-scope id`); continue; }
      if (seen.has(id)) problems.push(`selected-scope item ${id} appears in both ${seen.get(id)} and ${group}`);
      else seen.set(id, group);
    }
  }
  if (Number.isInteger(scopeCoverage.total) && scopeCoverage.total !== seen.size) {
    problems.push(`selected-scope coverage accounts for ${seen.size} of ${scopeCoverage.total} item(s)`);
  }
  if (!Array.isArray(scopeCoverage.errors)) problems.push('selected-scope coverage errors is not an array');
  else if (scopeCoverage.errors.length) problems.push(`${scopeCoverage.errors.length} selected-scope coverage error(s)`);
  if (Array.isArray(scopeCoverage.uncovered) && scopeCoverage.uncovered.length) {
    problems.push(`${scopeCoverage.uncovered.length} selected-scope item(s) UNCOVERED: ${scopeCoverage.uncovered.join(', ')}`);
  }
  return problems;
}

export function finalize(file, status, { result } = {}) {
  if (!['done', 'needs_attention', 'aborted'].includes(status)) fail('finalize requires <done|needs_attention|aborted>');
  return withLock(file, () => {
    const doc = readForWrite(file);
    // Fail closed: refuse "done" while ANY end-state fact is still open.
    if (status === 'done') {
      const openUnits = Object.entries(doc.units || {}).filter(([, u]) => u.status !== 'done').map(([k]) => k);
      const blockedPhases = Object.entries(doc.phases || {}).filter(([, p]) => p && p.status === 'blocked').map(([k]) => k);
      const requiredIncomplete = (doc.requiredPhases || []).filter(p => doc.phases?.[p]?.status !== 'done');
      const openFindings = Array.isArray(doc.openItems) ? doc.openItems.length : 0;
      const scopeCoverage = doc.pipeline && typeof doc.pipeline === 'object' ? doc.pipeline.scopeCoverage : null;
      const reasons = [];
      if (openUnits.length) reasons.push(`${openUnits.length} unit(s) not done: ${openUnits.join(', ')}`);
      if (blockedPhases.length) reasons.push(`${blockedPhases.length} phase(s) blocked: ${blockedPhases.join(', ')}`);
      if (requiredIncomplete.length) reasons.push(`${requiredIncomplete.length} required phase(s) not done: ${requiredIncomplete.join(', ')}`);
      if (openFindings) reasons.push(`${openFindings} open finding(s) in openItems`);
      if (doc.pipeline && (!scopeCoverage || typeof scopeCoverage !== 'object' || Array.isArray(scopeCoverage))) {
        reasons.push('binding selected-scope coverage receipt is absent');
      } else if (scopeCoverage) {
        reasons.push(...scopeCoverageProblems(scopeCoverage));
      }
      if (doc.requireValidation && (!doc.finalValidation || doc.finalValidation.status !== 'green')) {
        reasons.push(doc.finalValidation ? `final validation is ${doc.finalValidation.status} (not green)` : 'final validation is absent');
      }
      if (reasons.length) fail(`refusing finalize done — ${reasons.join('; ')} (use needs_attention)`, 2);
    }
    doc.status = status;
    doc.finishedAt = now();   // when the run reached its terminal state
    if (result !== undefined) doc.result = result;
    writeDoc(file, doc);
  });
}

export function gc(dir, { keepDays = 7 } = {}) {
  if (!Number.isFinite(keepDays) || keepDays < 0) fail(`--keep-days must be a non-negative number`);
  if (!existsSync(dir)) return { archived: 0, dir, reason: 'no runs dir' };
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
  return { archived, dir };
}
