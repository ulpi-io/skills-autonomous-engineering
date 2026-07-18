// event-log.mjs — opt-in append-only transition log + atomic checkpoint snapshot.
//
// The existing single .ulpi/runs/<id>.json store remains the default. Callers explicitly pass
// `{ enabled: true }` to initialize/append. Normal transitions append ONE fsynced JSONL record (O(1) in
// historical event count), then atomically replace the reader-compatible .json snapshot. A hash chain
// detects the crash window "log fsynced, snapshot not replaced"; the next append or an explicit rebuild
// replays the log. Only a syntactically torn FINAL non-newline fragment may be discarded.

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync,
  renameSync, statSync, truncateSync, writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { withLock } from './checkpoint-store.mjs';

export class EventLogError extends Error {
  constructor(message) { super(message); this.name = 'EventLogError'; }
}
const fail = (message) => { throw new EventLogError(message); };
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const digest = (doc) => createHash('sha256').update(JSON.stringify(doc)).digest('hex');
const FORBIDDEN_PATH = new Set(['__proto__', 'prototype', 'constructor']);

export function eventLogPath(snapshotFile) {
  if (typeof snapshotFile !== 'string' || snapshotFile.trim() === '') fail('snapshotFile must be a nonempty string');
  return snapshotFile.endsWith('.json') ? `${snapshotFile.slice(0, -5)}.events.jsonl` : `${snapshotFile}.events.jsonl`;
}

function atomicSnapshot(file, doc) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.events-tmp.${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(doc, null, 2)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, file);
  // Persist the directory entry where supported; some filesystems reject directory fsync, so the already
  // fsynced file + atomic rename remains the portable floor.
  try { const dfd = openSync(dirname(file), 'r'); try { fsyncSync(dfd); } finally { closeSync(dfd); } } catch {}
}

function appendDurable(file, event) {
  const fd = openSync(file, 'a', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(event)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function validatePath(path) {
  if (!Array.isArray(path) || path.length === 0 || path.some((p) => typeof p !== 'string' || p === '' || FORBIDDEN_PATH.has(p))) {
    fail('transition.path must be a nonempty array of safe string keys');
  }
}

export function applyEvent(doc, event) {
  if (!plain(doc) || !plain(event)) fail('document and event must be JSON objects');
  if (!['set', 'merge', 'delete'].includes(event.op)) fail(`unsupported transition op '${String(event.op)}'`);
  validatePath(event.path);
  const next = clone(doc);
  let parent = next;
  for (const key of event.path.slice(0, -1)) {
    if (!plain(parent[key])) parent[key] = {};
    parent = parent[key];
  }
  const leaf = event.path[event.path.length - 1];
  if (event.op === 'delete') delete parent[leaf];
  else if (event.op === 'set') {
    if (!Object.hasOwn(event, 'value')) fail('set transition requires value');
    parent[leaf] = clone(event.value);
  } else {
    if (!plain(event.value)) fail('merge transition requires an object value');
    const prior = plain(parent[leaf]) ? parent[leaf] : {};
    parent[leaf] = { ...prior, ...clone(event.value) };
  }
  return next;
}

function readTailLine(file) {
  const size = statSync(file).size;
  if (size === 0) fail(`event log ${file} is empty`);
  const fd = openSync(file, 'r');
  try {
    let pos = size;
    let suffix = '';
    const chunkSize = 64 * 1024;
    while (pos > 0) {
      const take = Math.min(chunkSize, pos);
      pos -= take;
      const buf = Buffer.allocUnsafe(take);
      readSync(fd, buf, 0, take, pos);
      suffix = buf.toString('utf8') + suffix;
      const end = suffix.endsWith('\n') ? suffix.length - 1 : suffix.length;
      const cut = suffix.lastIndexOf('\n', end - 1);
      if (cut >= 0) return suffix.slice(cut + 1, end);
    }
    return suffix.endsWith('\n') ? suffix.slice(0, -1) : suffix;
  } finally { closeSync(fd); }
}

function trimTornTail(file) {
  const raw = readFileSync(file, 'utf8');
  if (!raw || raw.endsWith('\n')) return { discardedTail: false, discardedBytes: 0 };
  const keep = raw.lastIndexOf('\n') + 1;
  const discardedBytes = Buffer.byteLength(raw.slice(keep));
  truncateSync(file, Buffer.byteLength(raw.slice(0, keep)));
  return { discardedTail: true, discardedBytes };
}

function parseEventLine(line, index) {
  let event;
  try { event = JSON.parse(line); } catch (e) { fail(`event log line ${index + 1} is corrupt: ${e.message}`); }
  if (!plain(event) || event.v !== 1 || typeof event.op !== 'string') fail(`event log line ${index + 1} has an invalid envelope`);
  return event;
}

function replayUnlocked(snapshotFile) {
  const logFile = eventLogPath(snapshotFile);
  if (!existsSync(logFile)) fail(`event log does not exist: ${logFile}`);
  const raw = readFileSync(logFile, 'utf8');
  const torn = raw.length > 0 && !raw.endsWith('\n');
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (torn) lines.pop(); // only the final non-newline fragment is discardable
  if (lines.length === 0) fail(`event log ${logFile} has no complete init record`);

  const first = parseEventLine(lines[0], 0);
  if (first.op !== 'init' || !plain(first.doc)) fail('event log must start with one init document');
  let doc = clone(first.doc);
  if (first.afterHash !== digest(doc)) fail('event log init hash does not match its document');
  for (let i = 1; i < lines.length; i++) {
    const event = parseEventLine(lines[i], i);
    if (event.op === 'init') fail(`event log line ${i + 1} repeats init`);
    const before = digest(doc);
    if (event.beforeHash !== before) fail(`event log line ${i + 1} breaks the beforeHash chain`);
    doc = applyEvent(doc, event);
    if (event.afterHash !== digest(doc)) fail(`event log line ${i + 1} breaks the afterHash chain`);
  }
  return { doc, events: lines.length, discardedTail: torn };
}

export function replayEventLog(snapshotFile) {
  return replayUnlocked(snapshotFile);
}

export function initializeEventLog(snapshotFile, initialDoc, { enabled = false } = {}) {
  const logFile = eventLogPath(snapshotFile);
  if (!enabled) return { enabled: false, snapshotFile, eventLog: null };
  mkdirSync(dirname(snapshotFile), { recursive: true });
  return withLock(snapshotFile, () => {
    if (existsSync(logFile)) fail(`event log already exists: ${logFile}`);
    const doc = initialDoc === undefined ? JSON.parse(readFileSync(snapshotFile, 'utf8')) : clone(initialDoc);
    if (!plain(doc)) fail('initial event-log document must be a JSON object');
    appendDurable(logFile, { v: 1, op: 'init', doc, afterHash: digest(doc) });
    atomicSnapshot(snapshotFile, doc);
    return { enabled: true, snapshotFile, eventLog: logFile, events: 1, doc };
  });
}

export function appendTransition(snapshotFile, transition, { enabled = false, hooks = {} } = {}) {
  if (!enabled) return { enabled: false, snapshotFile, eventLog: null };
  const logFile = eventLogPath(snapshotFile);
  return withLock(snapshotFile, () => {
    if (!existsSync(logFile)) fail(`event log is not initialized: ${logFile}`);
    const repaired = trimTornTail(logFile);
    let last;
    try { last = parseEventLine(readTailLine(logFile), -1); } catch (e) { throw e; }
    let doc = existsSync(snapshotFile) ? JSON.parse(readFileSync(snapshotFile, 'utf8')) : null;
    if (!plain(doc) || last.afterHash !== digest(doc)) {
      doc = replayUnlocked(snapshotFile).doc; // rare crash recovery; normal appends never scan history
      atomicSnapshot(snapshotFile, doc);
    }
    const eventBase = { v: 1, op: transition?.op, path: transition?.path, ...(Object.hasOwn(transition || {}, 'value') ? { value: transition.value } : {}) };
    const next = applyEvent(doc, eventBase);
    const event = { ...eventBase, beforeHash: digest(doc), afterHash: digest(next) };
    appendDurable(logFile, event); // durable log first; snapshot can always be rebuilt from it
    if (typeof hooks.afterAppend === 'function') hooks.afterAppend({ event, logFile, snapshotFile });
    atomicSnapshot(snapshotFile, next);
    return { enabled: true, snapshotFile, eventLog: logFile, event, doc: next, repairedTornTail: repaired.discardedTail };
  });
}

export function rebuildSnapshot(snapshotFile) {
  return withLock(snapshotFile, () => {
    const logFile = eventLogPath(snapshotFile);
    if (!existsSync(logFile)) fail(`event log does not exist: ${logFile}`);
    const repaired = trimTornTail(logFile);
    const replay = replayUnlocked(snapshotFile);
    atomicSnapshot(snapshotFile, replay.doc);
    return { ...replay, discardedTail: repaired.discardedTail || replay.discardedTail, discardedBytes: repaired.discardedBytes };
  });
}
