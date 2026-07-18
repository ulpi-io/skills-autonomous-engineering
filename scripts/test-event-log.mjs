#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  EventLogError, appendTransition, eventLogPath, initializeEventLog, rebuildSnapshot, replayEventLog,
} from '../checkpoint-resume/scripts/lib/event-log.mjs';

const RUN_STATUS = fileURLToPath(new URL('../checkpoint-resume/scripts/run-status.mjs', import.meta.url));
const initial = () => ({
  schemaVersion: 2, id: 'event-run', task: 'event log', status: 'running',
  createdAt: '2026-07-18T00:00:00Z', updatedAt: '2026-07-18T00:00:00Z',
  phases: {}, units: { T1: { status: 'pending', dependsOn: [] } }, openItems: [], resolvedItems: [], result: null,
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ulpi-events-'));
  const runs = join(dir, '.ulpi', 'runs');
  const file = join(runs, 'event-run.json');
  return { dir, runs, file, log: eventLogPath(file), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const lines = (file) => readFileSync(file, 'utf8').trimEnd().split('\n');

test('single atomic JSON remains the default: disabled mode creates no event log or mutation', () => {
  const f = fixture();
  try {
    const res = initializeEventLog(f.file, initial());
    assert.equal(res.enabled, false);
    assert.equal(existsSync(f.file), false);
    assert.equal(existsSync(f.log), false);
  } finally { f.cleanup(); }
});

test('opt-in initialization + each transition append exactly one line and atomically refresh the snapshot', () => {
  const f = fixture();
  try {
    initializeEventLog(f.file, initial(), { enabled: true });
    assert.equal(lines(f.log).length, 1, 'one init record');
    appendTransition(f.file, { op: 'set', path: ['units', 'T1', 'status'], value: 'in_progress' }, { enabled: true });
    assert.equal(lines(f.log).length, 2, 'one line for first transition');
    appendTransition(f.file, { op: 'merge', path: ['units', 'T1'], value: { status: 'done', note: 'landed' } }, { enabled: true });
    assert.equal(lines(f.log).length, 3, 'one line for second transition');
    const doc = JSON.parse(readFileSync(f.file, 'utf8'));
    assert.equal(doc.units.T1.status, 'done');
    assert.equal(doc.units.T1.note, 'landed');
    assert.deepEqual(replayEventLog(f.file).doc, doc);
  } finally { f.cleanup(); }
});

test('crash after fsynced append but before snapshot replace is recovered on the next append', () => {
  const f = fixture();
  try {
    initializeEventLog(f.file, initial(), { enabled: true });
    assert.throws(() => appendTransition(
      f.file,
      { op: 'set', path: ['units', 'T1', 'status'], value: 'in_progress' },
      { enabled: true, hooks: { afterAppend: () => { throw new Error('simulated crash'); } } },
    ), /simulated crash/);
    assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).units.T1.status, 'pending', 'snapshot stayed stale at crash');
    appendTransition(f.file, { op: 'set', path: ['units', 'T1', 'status'], value: 'done' }, { enabled: true });
    const doc = JSON.parse(readFileSync(f.file, 'utf8'));
    assert.equal(doc.units.T1.status, 'done', 'next append recovered prior log event, then applied the new one');
    assert.equal(lines(f.log).length, 3);
    assert.deepEqual(replayEventLog(f.file).doc, doc);
  } finally { f.cleanup(); }
});

test('a torn final line is discarded on rebuild and later appends remain valid', () => {
  const f = fixture();
  try {
    initializeEventLog(f.file, initial(), { enabled: true });
    appendTransition(f.file, { op: 'set', path: ['status'], value: 'needs_attention' }, { enabled: true });
    appendFileSync(f.log, '{"v":1,"op":"set","path":["status"]'); // no newline: proven torn tail
    const rebuilt = rebuildSnapshot(f.file);
    assert.equal(rebuilt.discardedTail, true);
    assert.ok(rebuilt.discardedBytes > 0);
    assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).status, 'needs_attention');
    assert.ok(readFileSync(f.log, 'utf8').endsWith('\n'), 'physical torn fragment was trimmed');
    appendTransition(f.file, { op: 'set', path: ['status'], value: 'done' }, { enabled: true });
    assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).status, 'done');
  } finally { f.cleanup(); }
});

test('corruption in a newline-terminated record fails closed (only torn final fragments are discardable)', () => {
  const f = fixture();
  try {
    initializeEventLog(f.file, initial(), { enabled: true });
    appendFileSync(f.log, '{not-json}\n');
    assert.throws(() => replayEventLog(f.file), EventLogError);
    assert.throws(() => rebuildSnapshot(f.file), EventLogError);
  } finally { f.cleanup(); }
});

test('run-status reads a log-rebuilt snapshot identically to the single-file path', () => {
  const single = fixture(); const logged = fixture();
  try {
    const doc = initial();
    // mkdirs are created by event initialization; use it once for the single fixture, then remove its log
    // to leave the ordinary single-file contract.
    initializeEventLog(single.file, doc, { enabled: true });
    rmSync(single.log);
    initializeEventLog(logged.file, doc, { enabled: true });
    rebuildSnapshot(logged.file);
    const run = (cwd) => {
      const r = spawnSync(process.execPath, [RUN_STATUS, '--json', 'event-run'], { cwd, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    assert.deepEqual(run(logged.dir), run(single.dir));
  } finally { single.cleanup(); logged.cleanup(); }
});
