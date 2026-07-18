#!/usr/bin/env node
// Isolated behavior contract for autonomous-pipeline/scripts/lib/intake-scope.mjs.
// Every externally meaningful validation, fidelity, filesystem, and atomic-publication refusal is pinned
// here so the Phase-0 scope authority cannot silently weaken behind green coordinator tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  INTAKE_SCHEMA_VERSION,
  IntakeScopeError,
  buildIntakeSnapshot,
  captureIntakeSnapshot,
  comparePlanToIntake,
  intakePathFor,
  normalizeSelectedScope,
  parseIntakeSnapshot,
  readIntakeSnapshot,
  sha256,
} from '../autonomous-pipeline/scripts/lib/intake-scope.mjs';

const ITEM = Object.freeze({ id: 'SCOPE-001', title: 'Selected feature', source: 'user selected Full MVP' });
const SECOND = Object.freeze({ id: 'SCOPE-002', title: 'Second feature', source: 'PRD section 13.1' });

function draft(over = {}) {
  return {
    run: 'run-001',
    selection: 'Full MVP = PRD section 13.1',
    selectedScope: [{ ...ITEM }],
    ...over,
  };
}

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'ulpi-intake-unit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function expectIntakeError(fn, { reason, code, match }) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof IntakeScopeError, `expected IntakeScopeError, got ${error?.constructor?.name}`);
    assert.equal(error.reason, reason);
    assert.equal(error.code, code);
    if (match) assert.match(error.message, match);
    return true;
  });
}

function snapshotBytes(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function writeAuthority(file, snapshot, mode = 0o400) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, snapshotBytes(snapshot), { mode: 0o600 });
  chmodSync(file, mode);
}

test('sha256 and canonical snapshot digest are deterministic across object-key order', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const a = buildIntakeSnapshot(draft());
  const b = buildIntakeSnapshot({
    selectedScope: [{ source: ITEM.source, title: ITEM.title, id: ITEM.id }],
    selection: 'Full MVP = PRD section 13.1',
    run: 'run-001',
  });
  assert.deepEqual(a, b);
  assert.equal(a.schemaVersion, INTAKE_SCHEMA_VERSION);
  assert.match(a.scopeSha256, /^[a-f0-9]{64}$/);
});

test('normalizeSelectedScope accepts the exact id/title/source shape and preserves values', () => {
  assert.deepEqual(normalizeSelectedScope([{ source: ITEM.source, id: ITEM.id, title: ITEM.title }]), [{ ...ITEM }]);
});

test('normalizeSelectedScope rejects every invalid shape and metadata class', async (t) => {
  const cases = [
    ['non-array', null, /nonempty array/],
    ['empty array', [], /nonempty array/],
    ['non-object item', [null], /must be an object/],
    ['unknown item field', [{ ...ITEM, extra: true }], /unknown field.*extra/],
    ['empty id', [{ ...ITEM, id: '' }], /id is not safe/],
    ['unsafe leading character', [{ ...ITEM, id: '-SCOPE' }], /id is not safe/],
    ['unsafe whitespace', [{ ...ITEM, id: 'SCOPE 1' }], /id is not safe/],
    ['overlong id', [{ ...ITEM, id: `S${'x'.repeat(128)}` }], /id is not safe/],
    ['duplicate id', [{ ...ITEM }, { ...ITEM, title: 'duplicate' }], /duplicate id/],
    ['empty title', [{ ...ITEM, title: '  ' }], /nonempty title/],
    ['non-string title', [{ ...ITEM, title: 7 }], /nonempty title/],
    ['empty source', [{ ...ITEM, source: '' }], /nonempty source/],
    ['non-string source', [{ ...ITEM, source: false }], /nonempty source/],
  ];
  for (const [name, input, match] of cases) {
    await t.test(name, () => expectIntakeError(
      () => normalizeSelectedScope(input),
      { reason: 'intake-invalid', code: 2, match },
    ));
  }
});

test('buildIntakeSnapshot rejects malformed drafts, unsafe runs, run drift, and empty selection', async (t) => {
  const cases = [
    ['malformed JSON', '{', {}, 'intake-invalid', 2, /not valid JSON/],
    ['JSON array', '[]', {}, 'intake-invalid', 2, /must be a JSON object/],
    ['non-object value', 42, {}, 'intake-invalid', 2, /must be a JSON object/],
    ['unknown draft field', { ...draft(), extra: true }, {}, 'intake-invalid', 2, /unknown field.*extra/],
    ['missing run', { selection: 'Full MVP', selectedScope: [{ ...ITEM }] }, {}, 'intake-invalid', 2, /not a safe id/],
    ['path-like run', draft({ run: '../escape' }), {}, 'intake-invalid', 2, /not a safe id/],
    ['double-dot run', draft({ run: 'run..escape' }), {}, 'intake-invalid', 2, /not a safe id/],
    ['expected run mismatch', draft(), { expectedRun: 'other-run' }, 'intake-run-mismatch', 3, /does not match/],
    ['empty selection', draft({ selection: '  ' }), {}, 'intake-invalid', 2, /nonempty user scope selection/],
    ['non-string selection', draft({ selection: 1 }), {}, 'intake-invalid', 2, /nonempty user scope selection/],
    ['missing selected scope', { run: 'run-001', selection: 'Full MVP' }, {}, 'intake-invalid', 2, /nonempty array/],
  ];
  for (const [name, input, opts, reason, code, match] of cases) {
    await t.test(name, () => expectIntakeError(
      () => buildIntakeSnapshot(input, opts),
      { reason, code, match },
    ));
  }
});

test('parseIntakeSnapshot validates schema, exact fields, digest, nested scope, and expected run', async (t) => {
  const valid = buildIntakeSnapshot(draft());
  assert.deepEqual(parseIntakeSnapshot(JSON.stringify(valid), { expectedRun: 'run-001' }), valid);
  const cases = [
    ['malformed JSON', '{', {}, 'intake-invalid', 2, /not valid JSON/],
    ['non-object snapshot', '[]', {}, 'intake-invalid', 2, /must be a JSON object/],
    ['unknown snapshot field', { ...valid, extra: true }, {}, 'intake-invalid', 2, /unknown field.*extra/],
    ['wrong schema', { ...valid, schemaVersion: 2 }, {}, 'intake-invalid', 2, /unsupported.*schemaVersion/],
    ['missing digest', { ...valid, scopeSha256: undefined }, {}, 'intake-digest-mismatch', 3, /digest/],
    ['changed digest', { ...valid, scopeSha256: '0'.repeat(64) }, {}, 'intake-digest-mismatch', 3, /digest/],
    ['changed contents under old digest', { ...valid, selection: 'quietly changed' }, {}, 'intake-digest-mismatch', 3, /digest/],
    ['invalid nested scope', { ...valid, selectedScope: [{ ...ITEM, title: '' }] }, {}, 'intake-invalid', 2, /title/],
    ['expected run mismatch', valid, { expectedRun: 'other-run' }, 'intake-run-mismatch', 3, /does not match/],
  ];
  for (const [name, input, opts, reason, code, match] of cases) {
    await t.test(name, () => expectIntakeError(
      () => parseIntakeSnapshot(input, opts),
      { reason, code, match },
    ));
  }
});

test('intakePathFor derives the canonical path and rejects unsafe state/run inputs', async (t) => {
  const stateDir = join(tmpdir(), 'ulpi-runs');
  assert.equal(intakePathFor({ stateDir, run: 'run-001' }), join(stateDir, 'intake', 'run-001.json'));
  const cases = [
    ['missing stateDir', { run: 'run-001' }, /stateDir must be an absolute/],
    ['relative stateDir', { stateDir: 'relative/runs', run: 'run-001' }, /stateDir must be an absolute/],
    ['traversing stateDir', { stateDir: `${tmpdir()}/../escape`, run: 'run-001' }, /traversal-free/],
    ['unsafe run', { stateDir, run: '-run' }, /config.run.*not a safe id/],
    ['double-dot run', { stateDir, run: 'run..escape' }, /config.run.*not a safe id/],
  ];
  for (const [name, input, match] of cases) {
    await t.test(name, () => expectIntakeError(
      () => intakePathFor(input),
      { reason: 'intake-invalid', code: 2, match },
    ));
  }
});

test('capture/read lifecycle publishes canonical mode-0400 bytes and takes the EEXIST path idempotently', (t) => {
  const root = tempRoot(t);
  const stateDir = join(root, 'runs');
  const file = intakePathFor({ stateDir, run: 'run-001' });
  const first = captureIntakeSnapshot(file, JSON.stringify(draft()), { expectedRun: 'run-001' });
  assert.equal(first.created, true);
  assert.equal(lstatSync(file).mode & 0o777, 0o400);
  assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(dirname(file)), ['run-001.json'], 'temporary publication file is removed');
  const raw = readFileSync(file, 'utf8');
  assert.equal(raw, snapshotBytes(first.snapshot));
  assert.equal(first.fileSha256, sha256(raw));

  const read = readIntakeSnapshot(file, { expectedRun: 'run-001' });
  assert.equal(read.file, file);
  assert.equal(read.raw, raw);
  assert.equal(read.fileSha256, first.fileSha256);
  assert.deepEqual(read.snapshot, first.snapshot);

  const second = captureIntakeSnapshot(file, draft(), { expectedRun: 'run-001' });
  assert.equal(second.created, false, 'existing byte-identical authority resolves through EEXIST');
  assert.equal(second.fileSha256, first.fileSha256);

  expectIntakeError(
    () => captureIntakeSnapshot(file, draft({ selection: 'changed selection' }), { expectedRun: 'run-001' }),
    { reason: 'intake-already-captured', code: 3, match: /different bytes/ },
  );
  assert.equal(readFileSync(file, 'utf8'), raw, 'a conflicting recapture never overwrites authority bytes');
  assert.deepEqual(readdirSync(dirname(file)), ['run-001.json'], 'failed recapture also removes its temp file');
});

test('readIntakeSnapshot rejects path, target-type, mode, content, digest, and run violations', async (t) => {
  const root = tempRoot(t);
  const valid = buildIntakeSnapshot(draft());

  expectIntakeError(
    () => readIntakeSnapshot('relative.json'),
    { reason: 'intake-invalid', code: 2, match: /path must be absolute/ },
  );
  expectIntakeError(
    () => readIntakeSnapshot(join(root, 'missing.json')),
    { reason: 'intake-missing', code: 3, match: /missing/ },
  );

  const directory = join(root, 'directory-target');
  mkdirSync(directory);
  expectIntakeError(
    () => readIntakeSnapshot(directory),
    { reason: 'intake-invalid', code: 3, match: /regular file/ },
  );

  const target = join(root, 'target.json');
  writeAuthority(target, valid);
  const link = join(root, 'link.json');
  symlinkSync(target, link);
  expectIntakeError(
    () => readIntakeSnapshot(link),
    { reason: 'intake-invalid', code: 3, match: /symlink/ },
  );

  const writable = join(root, 'writable.json');
  writeAuthority(writable, valid, 0o600);
  expectIntakeError(
    () => readIntakeSnapshot(writable),
    { reason: 'intake-writable', code: 3, match: /0400/ },
  );

  const malformed = join(root, 'malformed.json');
  mkdirSync(dirname(malformed), { recursive: true });
  writeFileSync(malformed, '{', { mode: 0o600 }); chmodSync(malformed, 0o400);
  expectIntakeError(
    () => readIntakeSnapshot(malformed),
    { reason: 'intake-invalid', code: 2, match: /not valid JSON/ },
  );

  const badDigest = join(root, 'bad-digest.json');
  writeAuthority(badDigest, { ...valid, scopeSha256: '0'.repeat(64) });
  expectIntakeError(
    () => readIntakeSnapshot(badDigest),
    { reason: 'intake-digest-mismatch', code: 3, match: /digest/ },
  );

  expectIntakeError(
    () => readIntakeSnapshot(target, { expectedRun: 'other-run' }),
    { reason: 'intake-run-mismatch', code: 3, match: /does not match/ },
  );
});

test('readIntakeSnapshot maps non-ENOENT stat failures to intake-io', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('permission refusal is not observable when tests run as root');
    return;
  }
  const root = tempRoot(t);
  const locked = join(root, 'locked');
  const file = join(locked, 'scope.json');
  writeAuthority(file, buildIntakeSnapshot(draft()));
  chmodSync(locked, 0o000);
  try {
    expectIntakeError(
      () => readIntakeSnapshot(file),
      { reason: 'intake-io', code: 6, match: /cannot stat/ },
    );
  } finally {
    chmodSync(locked, 0o700);
  }
});

test('captureIntakeSnapshot refuses nonabsolute paths, I/O failures, and unsafe existing targets', (t) => {
  const root = tempRoot(t);
  expectIntakeError(
    () => captureIntakeSnapshot('relative.json', draft()),
    { reason: 'intake-invalid', code: 2, match: /path must be absolute/ },
  );

  const blocker = join(root, 'not-a-directory');
  writeFileSync(blocker, 'x');
  expectIntakeError(
    () => captureIntakeSnapshot(join(blocker, 'intake', 'run-001.json'), draft()),
    { reason: 'intake-io', code: 6, match: /cannot capture/ },
  );

  const dirTarget = join(root, 'dir-target.json');
  mkdirSync(dirTarget);
  expectIntakeError(
    () => captureIntakeSnapshot(dirTarget, draft()),
    { reason: 'intake-invalid', code: 3, match: /regular file/ },
  );

  const valid = buildIntakeSnapshot(draft());
  const real = join(root, 'real.json');
  writeAuthority(real, valid);
  const linked = join(root, 'linked.json');
  symlinkSync(real, linked);
  expectIntakeError(
    () => captureIntakeSnapshot(linked, draft()),
    { reason: 'intake-invalid', code: 3, match: /symlink/ },
  );

  const writable = join(root, 'existing-writable.json');
  writeAuthority(writable, valid, 0o600);
  expectIntakeError(
    () => captureIntakeSnapshot(writable, draft()),
    { reason: 'intake-writable', code: 3, match: /0400/ },
  );
});

test('comparePlanToIntake reports exact, shrink, drift, expansion, duplicate, and absent-plan cases', () => {
  const authority = buildIntakeSnapshot(draft({ selectedScope: [{ ...ITEM }, { ...SECOND }] }));
  const exact = comparePlanToIntake([{ ...ITEM }, { ...SECOND }], authority);
  assert.equal(exact.exact, true);
  assert.deepEqual(exact.missing, []);
  assert.deepEqual(exact.changed, []);
  assert.deepEqual(exact.extra, []);

  const shrunk = comparePlanToIntake([{ ...ITEM }], authority);
  assert.deepEqual(shrunk.missing, ['SCOPE-002']);
  assert.ok(shrunk.errors.some((e) => e.code === 'intake-scope-shrunk' && e.scopeId === 'SCOPE-002'));

  const changed = comparePlanToIntake([{ ...ITEM, title: 'rewritten' }, { ...SECOND }], authority);
  assert.deepEqual(changed.changed, ['SCOPE-001']);
  assert.ok(changed.errors.some((e) => e.code === 'intake-scope-drift'));

  const expanded = comparePlanToIntake([{ ...ITEM }, { ...SECOND }, { id: 'SCOPE-003', title: 'extra', source: 'plan' }], authority);
  assert.deepEqual(expanded.extra, ['SCOPE-003']);
  assert.ok(expanded.errors.some((e) => e.code === 'intake-scope-expanded'));

  const duplicate = comparePlanToIntake([{ ...ITEM }, { ...ITEM }, { ...SECOND }], authority);
  assert.ok(duplicate.errors.some((e) => e.code === 'scope-invalid' && /duplicate/.test(e.detail)));

  const absent = comparePlanToIntake(null, authority);
  assert.deepEqual(absent.missing, ['SCOPE-001', 'SCOPE-002']);

  expectIntakeError(
    () => comparePlanToIntake([{ ...ITEM }, { ...SECOND }], { ...authority, scopeSha256: '0'.repeat(64) }),
    { reason: 'intake-digest-mismatch', code: 3, match: /digest/ },
  );
});
