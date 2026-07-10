#!/usr/bin/env node
// test-codex-smoke.mjs — acceptance tests for scripts/smoke-codex-plugin.mjs (TASK-049).
//
// Exercises the DEFAULT fake path end-to-end and the redaction / gate primitives it exposes. NO real
// Codex, NO network: the driver materializes its own FAKE `codex` CLI into a temp CODEX_HOME. Every
// assertion below proves one of the gate's contracts:
//
//   • ISOLATION            — CODEX_HOME + HOME are pinned to a fresh temp dir; the real repo and the
//                            user's config are never touched; temp state is cleaned up.
//   • marketplace add/list — the packaged marketplace is added and listed.
//   • plugin add/list      — the plugin installs with the EXACT version + install-root + 18 catalog
//                            entries and is then listed.
//   • new-session argv/env — a NEW ephemeral READ-ONLY session invokes $plugin:skill with the pinned
//                            argv (read-only sandbox, --ephemeral, NO --ignore-user-config) and the
//                            isolated env; untrusted hooks are skipped/warned.
//   • cleanup              — the temp work dir is removed by default.
//   • failure propagation  — a failing codex sub-invocation surfaces as status 'failed' at that step.
//   • secret redaction     — secrets never appear in evidence (by shape AND by value).
//   • gateNotRun           — an unavailable / drifted CLI in --live mode returns nonzero gateNotRun,
//                            never a fabricated clean.
//
// Run: node --test scripts/test-codex-smoke.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runSmoke, redactSecrets, redactDeep, readGitHead,
  PINNED_CODEX_VERSION, REDACTION_MARK,
} from './smoke-codex-plugin.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const EXPECTED_ADAPTERS = 18;

function isTmp(p) {
  const t = resolve(tmpdir());
  return typeof p === 'string' && resolve(p).startsWith(t);
}
const stepOf = (res, name) => res.steps.find((s) => s.step === name);

// ===========================================================================
// End-to-end fake path — the whole lifecycle is green with honest evidence
// ===========================================================================

test('fake path: full lifecycle is OK with complete, honest evidence', () => {
  const res = runSmoke({ mode: 'fake' });
  assert.equal(res.status, 'ok', `expected ok, got ${res.status} (${res.reason})`);
  assert.equal(res.exitCode, 0);

  const ev = res.evidence;
  assert.ok(ev, 'evidence present');
  assert.equal(ev.mode, 'fake');
  assert.equal(ev.codexVersion, PINNED_CODEX_VERSION, 'preflight recorded the pinned version');
  assert.match(ev.artifactSha256, /^sha256:[0-9a-f]{64}$/, 'artifact digest recorded');
  assert.equal(ev.catalogCount, EXPECTED_ADAPTERS, 'catalog reports 18 skills');
  assert.equal(typeof ev.manifestVersion, 'string');
  assert.match(ev.resultSchemaHash, /^[0-9a-f]{64}$/, 'schema hash recorded');
  assert.equal(ev.invokedSkill, `$autonomous-engineering:${ev.sessionArgv[ev.sessionArgv.indexOf('--skill') + 1].split(':')[1]}`);
  assert.ok(ev.invokedSkill.startsWith('$autonomous-engineering:'), 'invoked the namespaced identifier');
  assert.equal(ev.hookMode, 'skipped-untrusted', 'untrusted hooks were skipped/warned, never bypassed');
  assert.equal(ev.commit, readGitHead(REPO_ROOT), 'source commit recorded via pure fs');
});

test('fake path: every lifecycle step is recorded and passed', () => {
  const res = runSmoke({ mode: 'fake' });
  assert.equal(res.status, 'ok', res.reason || '');
  for (const name of [
    'preflight-version', 'package', 'marketplace-add', 'marketplace-list',
    'plugin-add', 'plugin-list', 'session',
  ]) {
    const s = stepOf(res, name);
    assert.ok(s, `step '${name}' present`);
    assert.equal(s.ok, true, `step '${name}' passed: ${s && s.detail}`);
  }
});

// ===========================================================================
// Isolation — temp CODEX_HOME + git fixture; real repo / user config untouched
// ===========================================================================

test('isolation: CODEX_HOME + HOME are pinned under a temp work dir, not the user config', () => {
  const parent = mkdtempSync(join(tmpdir(), 'ulpi-smoke-iso-'));
  try {
    const res = runSmoke({ mode: 'fake', workDir: parent, keep: true });
    assert.equal(res.status, 'ok', res.reason || '');
    const env = res.evidence.sessionEnv;
    assert.ok(isTmp(env.CODEX_HOME), `CODEX_HOME is under tmp: ${env.CODEX_HOME}`);
    assert.ok(resolve(env.CODEX_HOME).startsWith(resolve(parent)), 'CODEX_HOME is under the provided work dir');
    assert.ok(resolve(env.HOME).startsWith(resolve(parent)), 'HOME is pinned into the temp work dir');
    assert.notEqual(resolve(env.HOME), resolve(process.env.HOME || '/nonexistent'), 'HOME is NOT the real user home');
    // install root + fixture live under the temp work dir too
    assert.ok(resolve(res.evidence.installRoot).startsWith(resolve(parent)), 'install root under temp');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('isolation: the session --cd is a throwaway git fixture, never the real repo', () => {
  const parent = mkdtempSync(join(tmpdir(), 'ulpi-smoke-cd-'));
  try {
    const res = runSmoke({ mode: 'fake', workDir: parent, keep: true });
    assert.equal(res.status, 'ok', res.reason || '');
    const cdIdx = res.evidence.sessionArgv.indexOf('--cd');
    const cd = res.evidence.sessionArgv[cdIdx + 1];
    assert.ok(resolve(cd).startsWith(resolve(parent)), `--cd is the temp fixture, not the repo: ${cd}`);
    assert.notEqual(resolve(cd), resolve(REPO_ROOT), '--cd is never the real repo root');
    assert.ok(res.evidence.fixtureIsGit, 'the fixture is a real git repo');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('isolation: packaging never mutates the source repo (no artifact left behind)', () => {
  const before = readdirSync(REPO_ROOT).sort();
  const res = runSmoke({ mode: 'fake' });
  assert.equal(res.status, 'ok', res.reason || '');
  const after = readdirSync(REPO_ROOT).sort();
  assert.deepEqual(after, before, 'repo root listing unchanged by the smoke run');
});

// ===========================================================================
// new-session argv / env contract
// ===========================================================================

test('new-session argv: read-only sandbox, ephemeral, NO --ignore-user-config, explicit $plugin:skill', () => {
  const res = runSmoke({ mode: 'fake' });
  assert.equal(res.status, 'ok', res.reason || '');
  const a = res.evidence.sessionArgv;
  assert.equal(a[a.indexOf('--sandbox') + 1], 'read-only', 'sandbox is read-only');
  assert.equal(a[a.indexOf('--ask-for-approval') + 1], 'never', 'approvals never');
  assert.ok(a.includes('--ephemeral'), 'a NEW ephemeral session');
  assert.ok(!a.includes('--ignore-user-config'), 'plugin loads from CODEX_HOME (no --ignore-user-config)');
  assert.ok(!a.includes('--dangerously-bypass-approvals-and-sandbox'), 'never bypasses approvals/sandbox');
  assert.ok(!a.includes('--dangerously-bypass-hook-trust'), 'default path does not bypass hook trust');
  assert.equal(a[a.length - 1], '-', 'prompt is read from stdin');
  const skill = a[a.indexOf('--skill') + 1];
  assert.match(skill, /^\$autonomous-engineering:[a-z-]+$/, 'namespaced skill selector');
});

// ===========================================================================
// plugin add/list — exact version / install-root / 18 catalog entries
// ===========================================================================

test('plugin add/list: exact plugin, version, install-root, and 18 catalog entries', () => {
  const res = runSmoke({ mode: 'fake' });
  assert.equal(res.status, 'ok', res.reason || '');
  const add = stepOf(res, 'plugin-add');
  assert.match(add.detail, /autonomous-engineering@autonomous-engineering/);
  assert.match(add.detail, /18 skills/);
  assert.equal(res.evidence.catalogCount, EXPECTED_ADAPTERS);
  assert.ok(res.evidence.installRoot, 'install root captured');
  const list = stepOf(res, 'plugin-list');
  assert.match(list.detail, /18 skills/);
});

// ===========================================================================
// cleanup
// ===========================================================================

test('cleanup: the temp work dir is removed by default', () => {
  const res = runSmoke({ mode: 'fake' });
  assert.equal(res.status, 'ok', res.reason || '');
  assert.equal(res.cleaned, true, 'cleanup ran');
  assert.ok(!existsSync(res.workDir), 'temp work dir removed');
});

test('cleanup: keep:true preserves the work dir for inspection', () => {
  const res = runSmoke({ mode: 'fake', keep: true });
  try {
    assert.equal(res.status, 'ok', res.reason || '');
    assert.equal(res.cleaned, false);
    assert.ok(existsSync(res.workDir), 'kept work dir exists');
    assert.ok(existsSync(join(res.workDir, 'home', 'state.json')), 'fake codex state persisted under CODEX_HOME');
  } finally {
    rmSync(res.workDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// failure propagation — a failing codex sub-invocation is surfaced, not swallowed
// ===========================================================================

test('failure propagation: a failing marketplace add yields status=failed at that step', () => {
  const res = runSmoke({ mode: 'fake', extraCodexEnv: { FAKE_FAIL_MARKETPLACE_ADD: '1' } });
  assert.equal(res.status, 'failed', `expected failed, got ${res.status}`);
  assert.equal(res.exitCode, 1);
  const s = stepOf(res, 'marketplace-add');
  assert.ok(s && s.ok === false, 'marketplace-add step marked failed');
  assert.match(res.reason, /marketplace add failed/i);
  // steps AFTER the failure must NOT have run (no fabricated later success)
  assert.equal(stepOf(res, 'plugin-add'), undefined, 'no steps executed past the failure');
});

test('failure propagation: a failing plugin add yields status=failed at that step', () => {
  const res = runSmoke({ mode: 'fake', extraCodexEnv: { FAKE_FAIL_PLUGIN_ADD: '1' } });
  assert.equal(res.status, 'failed', `expected failed, got ${res.status}`);
  const s = stepOf(res, 'plugin-add');
  assert.ok(s && s.ok === false, 'plugin-add step marked failed');
  assert.equal(stepOf(res, 'session'), undefined, 'session never runs after a failed install');
});

// ===========================================================================
// secret redaction
// ===========================================================================

test('redaction: secrets never appear in evidence (by value AND by shape)', () => {
  const secret = 'sk-DEADBEEFcafef00d1234567890';
  const res = runSmoke({
    mode: 'fake',
    secretEnv: { OPENAI_API_KEY: secret },
    emitSecret: secret,
  });
  assert.equal(res.status, 'ok', res.reason || '');
  const blob = JSON.stringify(res.evidence);
  assert.ok(!blob.includes(secret), 'the raw secret is absent from evidence');
  assert.ok(blob.includes(REDACTION_MARK), 'a redaction marker is present');
  // the recorded session env carried the secret-named key — its VALUE must be redacted
  assert.equal(res.evidence.sessionEnv.OPENAI_API_KEY, REDACTION_MARK, 'env secret value redacted');
  assert.ok(res.evidence.redactedOutcome.includes(REDACTION_MARK), 'leaked outcome line redacted');
  assert.ok(!res.evidence.redactedOutcome.includes(secret), 'no secret survives in the outcome');
});

test('redactSecrets: masks known token shapes and explicit values', () => {
  assert.equal(redactSecrets('key sk-abcdef123456 end'), `key ${REDACTION_MARK} end`);
  assert.equal(redactSecrets('Authorization: Bearer abc123def456'), `Authorization: ${REDACTION_MARK}`);
  assert.equal(redactSecrets('ghp_0123456789abcdefghij'), REDACTION_MARK);
  assert.equal(redactSecrets('AKIAABCDEFGHIJKLMNOP'), REDACTION_MARK);
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
  assert.equal(redactSecrets(pem), REDACTION_MARK);
  // value-based redaction (an opaque secret with no known shape)
  assert.equal(redactSecrets('token=hunter2secret here', ['hunter2secret']), `token=${REDACTION_MARK} here`);
  // non-secret text is untouched; short values (<6) are not redacted
  assert.equal(redactSecrets('just normal text', ['abc']), 'just normal text');
});

test('redactDeep: masks strings nested in a JSON structure', () => {
  const out = redactDeep({ a: 'sk-abcdef123456', b: { c: ['ok', 'Bearer tok123abc'] } });
  assert.equal(out.a, REDACTION_MARK);
  assert.equal(out.b.c[0], 'ok');
  assert.equal(out.b.c[1], REDACTION_MARK);
});

// ===========================================================================
// gateNotRun — --live prerequisites absent → honest, nonzero, never fabricated
// ===========================================================================

test('gateNotRun: --live with an absent codex binary returns nonzero gateNotRun', () => {
  const res = runSmoke({ mode: 'live', codexBin: '/nonexistent/codex-does-not-exist-xyz' });
  assert.equal(res.status, 'gateNotRun', `expected gateNotRun, got ${res.status}`);
  assert.notEqual(res.exitCode, 0, 'gateNotRun is nonzero (never a fabricated clean)');
  assert.equal(res.evidence, null, 'no evidence is fabricated when the gate did not run');
  assert.match(res.reason, /unavailable|version/i);
  const s = stepOf(res, 'preflight-version');
  assert.ok(s && s.ok === false, 'preflight recorded the failure');
});

test('gateNotRun: --live with a version-drifted CLI returns gateNotRun (not a clean)', () => {
  // A binary that answers `--version` but with a NON-pinned version: `node --version` prints the node
  // version (e.g. v25.x), which never equals the pinned Codex version → the live gate must refuse it.
  const res = runSmoke({ mode: 'live', codexBin: process.execPath });
  assert.equal(res.status, 'gateNotRun', `expected gateNotRun, got ${res.status} (${res.reason})`);
  assert.notEqual(res.exitCode, 0, 'gateNotRun is nonzero');
  assert.equal(res.evidence, null, 'no fabricated evidence on drift');
  assert.match(res.reason, /drift|version/i);
});

// The default test never requires a real Codex: assert the fake path is fully self-contained.
test('the default test path requires NO real codex CLI', () => {
  const res = runSmoke({ mode: 'fake' });
  assert.equal(res.status, 'ok', res.reason || '');
});
