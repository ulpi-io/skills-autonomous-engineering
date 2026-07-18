// intake-scope.mjs — the independent, pre-plan authority for a pipeline run's selected scope.
//
// A plan cannot prove that it preserved intake by comparing selectedScope[] to itself. Phase 0 therefore
// captures a canonical snapshot BEFORE auto-spec/auto-plan. The file is write-once (atomic hard-link
// publish, never overwrite), content-addressed, and compared byte-for-byte again at start/resume. This is
// designed to catch honest-but-fallible scope shrink and drift; like the rest of the coordinator, it does
// not claim to resist a same-UID adversary who can rewrite every user-owned file and checkpoint.
//
// Zero external deps. Node 22+.

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export const INTAKE_SCHEMA_VERSION = 1;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SNAPSHOT_KEYS = Object.freeze(['run', 'schemaVersion', 'scopeSha256', 'selectedScope', 'selection']);
const DRAFT_KEYS = Object.freeze(['run', 'selectedScope', 'selection']);

export class IntakeScopeError extends Error {
  constructor(reason, message, code = 3) {
    super(message || reason);
    this.name = 'IntakeScopeError';
    this.reason = reason;
    this.code = code;
  }
}
const fail = (reason, message, code = 3) => { throw new IntakeScopeError(reason, message, code); };
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (plain(v)) {
    const out = {};
    for (const key of Object.keys(v).sort()) out[key] = sortKeys(v[key]);
    return out;
  }
  return v;
}
const canonical = (v) => JSON.stringify(sortKeys(v));
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function parseJson(raw, label) {
  if (typeof raw !== 'string') fail('intake-invalid', `${label} must be JSON text`, 2);
  try { return JSON.parse(raw); }
  catch (e) { fail('intake-invalid', `${label} is not valid JSON: ${e.message}`, 2); }
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) fail('intake-invalid', `${label} has unknown field(s): ${unknown.join(', ')}`, 2);
}

function assertRun(run, label = 'intake run') {
  if (typeof run !== 'string' || !SAFE_ID.test(run) || run.includes('..')) {
    fail('intake-invalid', `${label} is not a safe id: ${JSON.stringify(run)}`, 2);
  }
  return run;
}

export function normalizeSelectedScope(items, label = 'selectedScope') {
  if (!Array.isArray(items) || items.length === 0) {
    fail('intake-invalid', `${label} must be a nonempty array`, 2);
  }
  const seen = new Set();
  return items.map((item, index) => {
    if (!plain(item)) fail('intake-invalid', `${label}[${index}] must be an object`, 2);
    exactKeys(item, ['id', 'source', 'title'], `${label}[${index}]`);
    const { id, title, source } = item;
    if (typeof id !== 'string' || !SAFE_ID.test(id)) {
      fail('intake-invalid', `${label}[${index}].id is not safe: ${JSON.stringify(id)}`, 2);
    }
    if (seen.has(id)) fail('intake-invalid', `${label} contains duplicate id '${id}'`, 2);
    seen.add(id);
    if (typeof title !== 'string' || title.trim() === '') {
      fail('intake-invalid', `${label} item '${id}' is missing a nonempty title`, 2);
    }
    if (typeof source !== 'string' || source.trim() === '') {
      fail('intake-invalid', `${label} item '${id}' is missing a nonempty source`, 2);
    }
    return { id, title, source };
  });
}

function payloadOf({ run, selection, selectedScope }) {
  return { schemaVersion: INTAKE_SCHEMA_VERSION, run, selection, selectedScope };
}

export function buildIntakeSnapshot(rawDraft, { expectedRun } = {}) {
  const draft = typeof rawDraft === 'string' ? parseJson(rawDraft, 'intake draft') : rawDraft;
  if (!plain(draft)) fail('intake-invalid', 'intake draft must be a JSON object', 2);
  exactKeys(draft, DRAFT_KEYS, 'intake draft');
  const run = assertRun(draft.run);
  if (expectedRun !== undefined && run !== expectedRun) {
    fail('intake-run-mismatch', `intake draft run '${run}' does not match config run '${expectedRun}'`, 3);
  }
  if (typeof draft.selection !== 'string' || draft.selection.trim() === '') {
    fail('intake-invalid', 'intake draft.selection must preserve the nonempty user scope selection', 2);
  }
  const selectedScope = normalizeSelectedScope(draft.selectedScope);
  const payload = payloadOf({ run, selection: draft.selection, selectedScope });
  return { ...payload, scopeSha256: sha256(canonical(payload)) };
}

export function parseIntakeSnapshot(raw, { expectedRun } = {}) {
  const snapshot = typeof raw === 'string' ? parseJson(raw, 'intake snapshot') : raw;
  if (!plain(snapshot)) fail('intake-invalid', 'intake snapshot must be a JSON object', 2);
  exactKeys(snapshot, SNAPSHOT_KEYS, 'intake snapshot');
  if (snapshot.schemaVersion !== INTAKE_SCHEMA_VERSION) {
    fail('intake-invalid', `unsupported intake schemaVersion ${JSON.stringify(snapshot.schemaVersion)}`, 2);
  }
  const rebuilt = buildIntakeSnapshot({
    run: snapshot.run,
    selection: snapshot.selection,
    selectedScope: snapshot.selectedScope,
  }, { expectedRun });
  if (typeof snapshot.scopeSha256 !== 'string' || snapshot.scopeSha256 !== rebuilt.scopeSha256) {
    fail('intake-digest-mismatch', 'intake snapshot semantic digest does not match its contents', 3);
  }
  return rebuilt;
}

export function intakePathFor({ stateDir, run }) {
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir) || stateDir.split('/').includes('..')) {
    fail('intake-invalid', `stateDir must be an absolute, traversal-free path: ${JSON.stringify(stateDir)}`, 2);
  }
  assertRun(run, 'config.run');
  return join(stateDir, 'intake', `${run}.json`);
}

function readRegularFile(file) {
  let stat;
  try { stat = lstatSync(file); }
  catch (e) {
    if (e?.code === 'ENOENT') fail('intake-missing', `durable intake snapshot is missing: ${file}`, 3);
    fail('intake-io', `cannot stat intake snapshot ${file}: ${e.message}`, 6);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('intake-invalid', `intake snapshot must be a regular file, not a symlink: ${file}`, 3);
  }
  if ((stat.mode & 0o777) !== 0o400) {
    fail('intake-writable', `intake snapshot must remain owner-read-only mode 0400: ${file}`, 3);
  }
  try { return readFileSync(file, 'utf8'); }
  catch (e) { fail('intake-io', `cannot read intake snapshot ${file}: ${e.message}`, 6); }
}

export function readIntakeSnapshot(file, { expectedRun } = {}) {
  if (typeof file !== 'string' || !isAbsolute(file)) {
    fail('intake-invalid', `intake snapshot path must be absolute: ${JSON.stringify(file)}`, 2);
  }
  const raw = readRegularFile(file);
  const snapshot = parseIntakeSnapshot(raw, { expectedRun });
  return { file, raw, fileSha256: sha256(raw), snapshot };
}

// Publish the canonical bytes without an overwrite window. A hard link creates `file` iff absent; if a
// concurrent/equivalent capture already won, only byte-identical content is accepted as idempotent.
export function captureIntakeSnapshot(file, rawDraft, { expectedRun } = {}) {
  if (typeof file !== 'string' || !isAbsolute(file)) {
    fail('intake-invalid', `intake snapshot path must be absolute: ${JSON.stringify(file)}`, 2);
  }
  const snapshot = buildIntakeSnapshot(rawDraft, { expectedRun });
  const bytes = `${JSON.stringify(snapshot, null, 2)}\n`;

  const dir = dirname(file);
  const temp = join(dir, `.${snapshot.run}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  let created = true;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    chmodSync(temp, 0o400); // ordinary tools cannot silently edit the authority after capture
    try { linkSync(temp, file); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      created = false;
      const existing = readRegularFile(file);
      if (existing !== bytes) {
        fail('intake-already-captured', `intake snapshot already exists with different bytes: ${file}`, 3);
      }
    }
    try {
      const dirFd = openSync(dir, 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch { /* directory fsync is unavailable on some platforms; the published file is still complete */ }
  } catch (e) {
    if (e instanceof IntakeScopeError) throw e;
    fail('intake-io', `cannot capture durable intake snapshot ${file}: ${e.message}`, 6);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { unlinkSync(temp); } catch {}
  }
  const persisted = readRegularFile(file);
  return { created, file, fileSha256: sha256(persisted), snapshot: parseIntakeSnapshot(persisted, { expectedRun }) };
}

// Compare the PLAN's declaration to the independent snapshot. Coverage/drop semantics are checked
// separately; this function owns only fidelity: exact id set and exact id/title/source values.
export function comparePlanToIntake(planSelectedScope, snapshot) {
  const authority = parseIntakeSnapshot(snapshot, { expectedRun: snapshot?.run });
  const errors = [];
  const planItems = Array.isArray(planSelectedScope) ? planSelectedScope : [];
  const planById = new Map();
  for (const item of planItems) {
    const id = item?.id;
    if (typeof id !== 'string' || !SAFE_ID.test(id)) continue; // plan shape gate reports this precisely
    if (planById.has(id)) {
      errors.push({ code: 'scope-invalid', scopeId: id, detail: `plan selectedScope contains duplicate id '${id}'` });
    } else {
      planById.set(id, item);
    }
  }
  const authorityById = new Map(authority.selectedScope.map((item) => [item.id, item]));
  const missing = [], extra = [], changed = [];
  for (const expected of authority.selectedScope) {
    const actual = planById.get(expected.id);
    if (!actual) {
      missing.push(expected.id);
      errors.push({ code: 'intake-scope-shrunk', scopeId: expected.id, detail: `intake item '${expected.id}' is missing from plan.selectedScope[]` });
    } else if (actual.title !== expected.title || actual.source !== expected.source) {
      changed.push(expected.id);
      errors.push({ code: 'intake-scope-drift', scopeId: expected.id, detail: `plan changed intake title/source for '${expected.id}'` });
    }
  }
  for (const item of planItems) {
    if (typeof item?.id === 'string' && SAFE_ID.test(item.id) && !authorityById.has(item.id)) {
      extra.push(item.id);
      errors.push({ code: 'intake-scope-expanded', scopeId: item.id, detail: `plan selectedScope adds '${item.id}' absent from the captured intake` });
    }
  }
  return { exact: errors.length === 0, missing, extra, changed, errors, authority };
}
