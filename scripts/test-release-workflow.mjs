#!/usr/bin/env node
// test-release-workflow.mjs — the fail-closed contract for the hardened, versioned Codex artifact
// release (TASK-041 + TASK-050). It proves TWO things about the deterministic release pipeline:
//
//   1. The REAL workflow (.github/workflows/release-codex-plugin.yml) is fully hardened — the static
//      verify-codex-release.mjs audit reports ZERO violations — and the runtime parity/provenance
//      verifier accepts a clean, correctly-built artifact + matched live evidence, recording commit,
//      version, SHA-256 and provenance BEFORE upload.
//
//   2. Every hardening class FAILS CLOSED. A mutation battery injects exactly one defect at a time —
//      a mutable action ref, an excessive permission, a missing secret, a credential leak, a skipped
//      gate, a stale digest, a gateNotRun/red smoke reaching upload, a tag/manifest/catalog/artifact
//      mismatch, a dirty post-package checkout, a non-tag trigger, a missing environment, a leaked
//      persisted git credential, a missing digest-match gate, missing provenance — and asserts the
//      verifier BITES with the right typed code, and that a real CLI invocation exits nonzero.
//
// The verifier is the SAME code the workflow itself calls (--workflow self-audit + --smoke-report
// evidence gate), so a green test is evidence the live release gate is armed — not a parallel mock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditWorkflow, verifyArtifact, parseSteps } from './verify-codex-release.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = join(HERE, '..', '.github', 'workflows', 'release-codex-plugin.yml');
const VERIFIER = join(HERE, 'verify-codex-release.mjs');
const REAL = readFileSync(WORKFLOW, 'utf8');

const codesOf = (viol) => viol.map((x) => x.code);
const has = (viol, code) => viol.some((x) => x.code === code);

// A defect must produce its own code AND must not silently vanish: assert the code is present.
function mutate(from, to) {
  assert.ok(REAL.includes(from), `test anchor not found in real workflow: ${JSON.stringify(from).slice(0, 80)}`);
  return REAL.replace(from, to);
}

// ============================ 1) the REAL workflow is clean ============================

test('the real release workflow passes the static hardening audit with ZERO violations', () => {
  const viol = auditWorkflow(REAL);
  assert.deepEqual(viol, [], `real release-codex-plugin.yml should be clean but got:\n  ${codesOf(viol).join(', ')}`);
});

test('the release pipeline is ordered package → verify → live-smoke → evidence → upload', () => {
  const steps = parseSteps(REAL);
  const pkg = steps.find((s) => /package-codex-plugin\.mjs/.test(s.raw));
  const verify = steps.find((s) => /verify-codex-release\.mjs/.test(s.raw) && /--artifact/.test(s.raw));
  const smoke = steps.find((s) => /smoke-codex-plugin\.mjs/.test(s.raw) && /--live/.test(s.raw));
  const evidence = steps.find((s) => /--smoke-report/.test(s.raw));
  const upload = steps.find((s) => s.id === 'upload');
  for (const [n, s] of Object.entries({ pkg, verify, smoke, evidence, upload })) assert.ok(s, `missing pipeline step: ${n}`);
  assert.ok(pkg.index < verify.index && verify.index < smoke.index && smoke.index < evidence.index && evidence.index < upload.index,
    'release steps are out of order');
  assert.match(upload.ifVal, /steps\.evidence\.outputs\.matched/, 'upload must be gated on matched live evidence');
});

test('only the live-smoke step carries Codex credentials (scoped, single step)', () => {
  const steps = parseSteps(REAL);
  const withSecrets = steps.filter((s) => /secrets\./.test(s.raw));
  assert.equal(withSecrets.length, 1, 'exactly one step may reference secrets');
  assert.match(withSecrets[0].raw, /smoke-codex-plugin\.mjs --live/, 'the credentialed step must be the live smoke');
});

// ============================ 2) synthetic artifact fixtures ============================

const PLUGIN = 'autonomous-engineering';
function makeArtifact(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-rel-'));
  const version = opts.version ?? '0.1.0';
  const catalogVersion = opts.catalogVersion ?? version; // marketplace descriptor version
  mkdirSync(join(dir, '.agents', 'plugins'), { recursive: true });
  mkdirSync(join(dir, 'plugins', PLUGIN, '.codex-plugin'), { recursive: true });
  mkdirSync(join(dir, 'plugins', PLUGIN, 'codex-skills'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({ name: PLUGIN, plugins: [{ name: PLUGIN, version: catalogVersion, source: `./plugins/${PLUGIN}` }] }, null, 2));
  writeFileSync(join(dir, 'plugins', PLUGIN, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: PLUGIN, version, skills: './codex-skills/' }, null, 2));
  writeFileSync(join(dir, 'plugins', PLUGIN, 'codex-skills', 'catalog.json'),
    JSON.stringify({ version: 1, count: 18, skills: new Array(18).fill(0).map((_, i) => ({ name: `s${i}` })) }, null, 2));
  return dir;
}
const DIGEST_A = 'sha256:' + '1'.repeat(64);
const DIGEST_B = 'sha256:' + '2'.repeat(64);
function smokeReport(over = {}) {
  return {
    status: over.status ?? 'ok',
    reason: over.reason ?? null,
    evidence: {
      commit: 'commit' in over ? over.commit : 'deadbeefcafe',
      artifactSha256: over.artifactSha256 ?? DIGEST_A,
      manifestVersion: over.manifestVersion ?? '0.1.0',
      catalogVersion: 1,
      codexVersion: over.codexVersion ?? 'codex-cli 0.9.0',
    },
  };
}

test('a clean artifact + matched live evidence verifies, recording commit/version/SHA-256 as provenance', () => {
  const dir = makeArtifact();
  const provOut = join(dir, 'provenance.json');
  const { violations, provenance } = verifyArtifact({
    artifactDir: dir, tag: 'v0.1.0', digest: DIGEST_A, smokeReport: smokeReport(), provenanceOut: provOut,
  });
  assert.deepEqual(violations, [], `clean artifact should verify, got: ${codesOf(violations).join(', ')}`);
  assert.equal(provenance.commit, 'deadbeefcafe');
  assert.equal(provenance.version, '0.1.0');
  assert.equal(provenance.sha256, DIGEST_A);
  assert.ok(existsSync(provOut), 'provenance must be written to disk BEFORE upload');
  const written = JSON.parse(readFileSync(provOut, 'utf8'));
  assert.equal(written.commit, 'deadbeefcafe');
  assert.equal(written.sha256, DIGEST_A);
  assert.equal(written.version, '0.1.0');
});

test('FAIL-CLOSED — a tag/manifest/catalog/artifact version mismatch is caught', () => {
  const dir = makeArtifact({ version: '0.2.0' }); // artifact manifest drifts from the tag
  const { violations } = verifyArtifact({ artifactDir: dir, tag: 'v0.1.0', digest: DIGEST_A, smokeReport: smokeReport() });
  assert.ok(has(violations, 'VERSION_PARITY'), `version drift must be caught: ${codesOf(violations).join(', ')}`);
});

test('FAIL-CLOSED — a marketplace-catalog version out of parity with the manifest is caught', () => {
  const dir = makeArtifact({ version: '0.1.0', catalogVersion: '0.1.1' });
  const { violations } = verifyArtifact({ artifactDir: dir, tag: 'v0.1.0', digest: DIGEST_A });
  assert.ok(has(violations, 'VERSION_PARITY'), `catalog drift must be caught: ${codesOf(violations).join(', ')}`);
});

test('FAIL-CLOSED — a stale digest (live smoke exercised a different artifact) is caught', () => {
  const dir = makeArtifact();
  const { violations } = verifyArtifact({
    artifactDir: dir, tag: 'v0.1.0', digest: DIGEST_B, smokeReport: smokeReport({ artifactSha256: DIGEST_A }),
  });
  assert.ok(has(violations, 'DIGEST_MISMATCH'), `stale digest must be caught: ${codesOf(violations).join(', ')}`);
});

test('FAIL-CLOSED — a gateNotRun live smoke cannot green a release', () => {
  const dir = makeArtifact();
  const { violations } = verifyArtifact({
    artifactDir: dir, tag: 'v0.1.0', digest: DIGEST_A, smokeReport: smokeReport({ status: 'gateNotRun', reason: 'codex CLI unavailable' }),
  });
  assert.ok(has(violations, 'LIVE_SMOKE_NOT_OK'), `gateNotRun must block release: ${codesOf(violations).join(', ')}`);
});

test('FAIL-CLOSED — a red (failed) live smoke cannot green a release', () => {
  const dir = makeArtifact();
  const { violations } = verifyArtifact({
    artifactDir: dir, tag: 'v0.1.0', digest: DIGEST_A, smokeReport: smokeReport({ status: 'failed', reason: 'session off-schema' }),
  });
  assert.ok(has(violations, 'LIVE_SMOKE_NOT_OK'), `failed smoke must block release: ${codesOf(violations).join(', ')}`);
});

test('FAIL-CLOSED — a missing provenance hash is caught', () => {
  const dir = makeArtifact();
  const { violations } = verifyArtifact({ artifactDir: dir, tag: 'v0.1.0' /* no digest */, smokeReport: smokeReport() });
  assert.ok(has(violations, 'MISSING_PROVENANCE'), `missing sha256 must be caught: ${codesOf(violations).join(', ')}`);
});

test('FAIL-CLOSED — live evidence without a commit is incomplete provenance', () => {
  const dir = makeArtifact();
  const { violations } = verifyArtifact({
    artifactDir: dir, tag: 'v0.1.0', digest: DIGEST_A, smokeReport: smokeReport({ commit: null }),
  });
  assert.ok(has(violations, 'MISSING_PROVENANCE'), `missing commit must be caught: ${codesOf(violations).join(', ')}`);
});

// ============================ 3) static hardening mutation battery ============================

test('FAIL-CLOSED — a mutable action ref (tag instead of 40-hex SHA) is caught', () => {
  const broken = mutate('actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2', 'actions/checkout@v4.2.2');
  assert.ok(has(auditWorkflow(broken), 'MUTABLE_ACTION_REF'));
});

test('FAIL-CLOSED — an excessive (write) permission is caught', () => {
  const broken = mutate('\npermissions:\n  contents: read\n', '\npermissions:\n  contents: write\n');
  assert.ok(has(auditWorkflow(broken), 'EXCESSIVE_PERMISSION'));
});

test('FAIL-CLOSED — dropping the top-level permissions block is caught', () => {
  const broken = mutate('\npermissions:\n  contents: read\n', '\n');
  assert.ok(has(auditWorkflow(broken), 'MISSING_PERMISSIONS'));
});

test('FAIL-CLOSED — a missing Codex secret on the live-smoke step is caught', () => {
  const broken = mutate(
    '        env:\n          CODEX_API_KEY: ${{ secrets.CODEX_API_KEY }}\n          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}\n',
    '');
  const viol = auditWorkflow(broken);
  assert.ok(has(viol, 'MISSING_LIVE_CREDENTIAL'), `missing credential must be caught: ${codesOf(viol).join(', ')}`);
});

test('FAIL-CLOSED — a Codex credential leaking outside the live-smoke step is caught', () => {
  const broken = mutate(
    '          node --test scripts/test-release-workflow.mjs\n',
    '          node --test scripts/test-release-workflow.mjs\n          echo ${{ secrets.CODEX_API_KEY }}\n');
  assert.ok(has(auditWorkflow(broken), 'CREDENTIAL_SCOPE_LEAK'));
});

test('FAIL-CLOSED — a skipped/masked gate (continue-on-error) is caught', () => {
  const broken = mutate('        id: smoke\n', '        id: smoke\n        continue-on-error: true\n');
  assert.ok(has(auditWorkflow(broken), 'SKIPPABLE_GATE'));
});

test('FAIL-CLOSED — a gate made conditionally skippable (if:) is caught', () => {
  const broken = mutate('        id: evidence\n', '        id: evidence\n        if: false\n');
  assert.ok(has(auditWorkflow(broken), 'SKIPPABLE_GATE'));
});

test('FAIL-CLOSED — an ungated upload (if: always) reachable by a red smoke is caught', () => {
  const broken = mutate("        if: steps.evidence.outputs.matched == 'true'", '        if: always()');
  assert.ok(has(auditWorkflow(broken), 'UPLOAD_UNGATED'));
});

test('FAIL-CLOSED — a dirty post-package checkout edit is caught', () => {
  const broken = mutate(
    '          cat "$RUNNER_TEMP/smoke.json"\n',
    '          cat "$RUNNER_TEMP/smoke.json"\n          git checkout -- .\n');
  assert.ok(has(auditWorkflow(broken), 'POST_PACKAGE_CHECKOUT_EDIT'));
});

test('FAIL-CLOSED — a non-tag trigger (branch push) is caught', () => {
  const broken = mutate('  push:\n    tags:\n      - "v*.*.*"', '  push:\n    branches: [main]');
  assert.ok(has(auditWorkflow(broken), 'TRIGGER_NOT_TAG'));
});

test('FAIL-CLOSED — removing the protected environment is caught', () => {
  const broken = mutate('    environment: release\n', '');
  assert.ok(has(auditWorkflow(broken), 'MISSING_ENVIRONMENT'));
});

test('FAIL-CLOSED — a leaked persisted git credential (persist-credentials:true) is caught', () => {
  const broken = mutate('persist-credentials: false', 'persist-credentials: true');
  assert.ok(has(auditWorkflow(broken), 'PERSIST_CREDENTIALS'));
});

test('FAIL-CLOSED — removing the digest-matched evidence gate is caught', () => {
  const broken = mutate('            --smoke-report "$RUNNER_TEMP/smoke.json" \\\n', '');
  assert.ok(has(auditWorkflow(broken), 'MISSING_DIGEST_MATCH'));
});

test('FAIL-CLOSED — removing the provenance record from the evidence gate is caught', () => {
  const broken = mutate('            --provenance-out "$RUNNER_TEMP/provenance.json"\n', '');
  assert.ok(has(auditWorkflow(broken), 'MISSING_PROVENANCE'));
});

test('FAIL-CLOSED — a write to the user-global ~/.agents marketplace is caught', () => {
  const broken = mutate(
    '          node --test scripts/test-release-workflow.mjs\n',
    '          node --test scripts/test-release-workflow.mjs\n          echo x > ~/.agents/plugins/marketplace.json\n');
  assert.ok(has(auditWorkflow(broken), 'MARKETPLACE_GLOBAL_MUTATION'));
});

// ============================ 4) the CLI itself fails closed (end-to-end exit codes) ============================

test('the verifier CLI exits 0 on the clean real workflow and nonzero (typed) on a defect', () => {
  const ok = spawnSync(process.execPath, [VERIFIER, '--workflow', WORKFLOW], { encoding: 'utf8' });
  assert.equal(ok.status, 0, `clean workflow must exit 0, got ${ok.status}: ${ok.stderr}`);

  const badDir = mkdtempSync(join(tmpdir(), 'codex-rel-cli-'));
  const badFile = join(badDir, 'bad.yml');
  writeFileSync(badFile, mutate('persist-credentials: false', 'persist-credentials: true'));
  const bad = spawnSync(process.execPath, [VERIFIER, '--workflow', badFile], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0, 'a defective workflow must exit nonzero');
  assert.match(bad.stderr, /VIOLATION PERSIST_CREDENTIALS/, 'typed evidence must be printed');
  assert.match(bad.stderr, /release BLOCKED/);
});

test('the verifier CLI exits nonzero on a stale-digest artifact and prints the typed code', () => {
  const dir = makeArtifact();
  const reportFile = join(dir, 'smoke.json');
  writeFileSync(reportFile, JSON.stringify(smokeReport({ artifactSha256: DIGEST_A })));
  const res = spawnSync(process.execPath,
    [VERIFIER, '--artifact', dir, '--tag', 'v0.1.0', '--digest', DIGEST_B, '--smoke-report', reportFile],
    { encoding: 'utf8' });
  assert.notEqual(res.status, 0, 'a stale digest must exit nonzero');
  assert.match(res.stderr, /VIOLATION DIGEST_MISMATCH/);
});
