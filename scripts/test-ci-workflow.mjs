#!/usr/bin/env node
// test-ci-workflow.mjs — contract tests for .github/workflows/validate.yml (TASK-038).
//
// CI is the single deterministic gate that must run EVERY suite on every push/PR with no escape hatch.
// Prose can't enforce that a suite stays wired or that a gate can't be silently masked, so this fixture
// parses the workflow and ASSERTS the load-bearing invariants a drift/regression could quietly break:
//
//   • COMPLETENESS  — every required suite (node:test unit/E2E, shell contracts, validate-skills
//                     --surface all --hooks, and the legacy pipeline-workflow) is a VISIBLE NAMED step.
//   • UNMASKABLE    — no `continue-on-error`, no shell masking (`|| true`, `; passing-cmd`, pipe-to-true),
//                     so a red gate fails the job and GitHub's fail-fast stops later steps from masking it.
//   • HERMETIC      — no network / credential / secret use and no suite ever runs `--live` (the
//                     codex-executor tests use a fake runtime): CI needs NO login, NO network, NO user
//                     config, NO out-of-tree writes.
//
// The mutation battery at the bottom proves the checker actually BITES: a workflow missing a suite, or
// carrying continue-on-error / a masked gate / a network+credential call, MUST fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = join(HERE, '..', '.github', 'workflows', 'validate.yml');
const REAL = readFileSync(WORKFLOW, 'utf8');

// ---- required suites: token = a substring that MUST appear in some step's `run` ----
// mustInclude / mustNotInclude add per-suite flag assertions.
const NODE_SUITES = [
  'test-pipeline-state.mjs', 'test-cli-contract.mjs', 'test-git-workspaces.mjs',
  'test-git-integration.mjs', 'test-codex-executor.mjs', 'test-budget-ledger.mjs',
  'test-authorization.mjs', 'test-review-panel.mjs', 'test-build-engine.mjs',
  'test-phase-engine.mjs', 'test-pipeline-cli.mjs', 'test-pipeline-e2e.mjs',
  'test-pipeline-security.mjs', 'test-ci-workflow.mjs',
];
const SHELL_SUITES = [
  'test-guards.sh', 'test-checkpoint.sh', 'test-run-status.sh', 'test-map-verify.sh',
  'test-plan-validate.sh', 'test-harvest.sh', 'test-validate-skills.sh', 'test-watch-state.sh',
  'test-scheduled-job.sh',
];
const REQUIRED = [
  ...NODE_SUITES.map((t) => ({ token: t })),
  ...SHELL_SUITES.map((t) => ({ token: t })),
  // checkpoint-store contract ships as the shell suite above (test-checkpoint.sh) — already covered.
  { token: 'validate-skills.mjs', mustInclude: ['--surface all', '--hooks'] },
  { token: 'test-pipeline-workflow.mjs' },                              // legacy compatibility suite
  { token: 'test-site.mjs' },                                          // site slice — must stay wired
];

// ---- masking patterns: any of these inside a `run` means a failing gate could be swallowed ----
const MASK_PATTERNS = [
  { re: /\|\|/, why: 'logical-OR fallback (|| ...) swallows a failing gate' },
  { re: /(^|\s);|;(\s|$)/, why: 'semicolon command chaining lets an earlier failure be masked by a later exit code' },
  { re: /\|\s*(true|cat|tee|:)\b/, why: 'pipe-to-passing-command masks the producer exit code' },
  { re: /\bset\s+\+e\b/, why: 'set +e disables fail-on-error' },
  { re: /\btrue\s*$/m, why: 'trailing `true` forces a zero exit' },
];
// ---- network / credential / secret patterns (scanned in run commands + whole-file for secrets) ----
const NETWORK_PATTERNS = [
  { re: /\bcurl\b/, why: 'curl (network)' },
  { re: /\bwget\b/, why: 'wget (network)' },
  { re: /\bnc\b/, why: 'netcat (network)' },
  { re: /\bssh\b/, why: 'ssh (network)' },
  { re: /https?:\/\//, why: 'http(s) URL (network)' },
  { re: /npm\s+publish/, why: 'npm publish (network/credential)' },
  { re: /npm\s+login/, why: 'npm login (credential)' },
  { re: /codex\s+login/, why: 'codex login (credential)' },
  { re: /--live\b/, why: '--live opts into real Codex/network' },
  { re: /NODE_AUTH_TOKEN/, why: 'registry credential' },
];

// ---- minimal, dependency-free YAML step parser (single-line + block-scalar `run:`) ----
function parseSteps(text) {
  const lines = text.split('\n');
  const steps = [];
  let cur = null;
  let inRun = false;
  let runIndent = 0;
  const push = () => { if (cur) steps.push(cur); };
  for (const line of lines) {
    if (inRun) {
      const indent = (line.match(/^(\s*)/) || ['', ''])[1].length;
      if (line.trim() === '' || indent > runIndent) { cur.run += line.trim() + '\n'; continue; }
      inRun = false; // dedent → block ended; fall through to parse this line
    }
    const stepStart = /^(\s*)-\s+([\w-]+):\s*(.*)$/.exec(line);
    if (stepStart) {
      push();
      cur = { name: '', uses: '', run: '' };
      applyKey(cur, stepStart[2], stepStart[3], stepStart[1].length, (ri) => { inRun = true; runIndent = ri; });
      continue;
    }
    if (!cur) continue;
    const kv = /^(\s*)([\w-]+):\s*(.*)$/.exec(line);
    if (kv) applyKey(cur, kv[2], kv[3], kv[1].length, (ri) => { inRun = true; runIndent = ri; });
  }
  push();
  return steps;
}
function applyKey(step, key, val, indent, openRun) {
  const v = val.trim();
  if (key === 'name') step.name = v.replace(/^["']|["']$/g, '');
  else if (key === 'uses') step.uses = v;
  else if (key === 'continue-on-error') step.continueOnError = v;
  else if (key === 'run') {
    if (v === '|' || v === '|-' || v === '>' || v === '>-') openRun(indent);
    else step.run += v + '\n';
  }
}

// Strip YAML comments so whole-file scans (continue-on-error / secrets) inspect real config, not prose.
function stripComments(text) {
  return text.split('\n').map((l) => (/^\s*#/.test(l) ? '' : l.replace(/\s#.*$/, ''))).join('\n');
}

// ---- the audit: returns a list of violation strings ([] == clean) ----
function auditWorkflow(text) {
  const v = [];
  const steps = parseSteps(text);
  const code = stripComments(text);

  for (const req of REQUIRED) {
    const hit = steps.find((s) => s.run.includes(req.token));
    if (!hit) { v.push(`MISSING SUITE: no named step runs '${req.token}'`); continue; }
    if (!hit.name || !hit.name.trim()) v.push(`UNNAMED SUITE: step running '${req.token}' has no name`);
    for (const m of req.mustInclude || []) if (!hit.run.includes(m)) v.push(`SUITE '${req.token}' missing required flag: ${m}`);
    for (const m of req.mustNotInclude || []) if (hit.run.includes(m)) v.push(`SUITE '${req.token}' must NOT include: ${m}`);
  }

  // whole-file (comments stripped): no continue-on-error, no secrets plumbing.
  if (/continue-on-error/.test(code)) v.push('MASKABLE: continue-on-error present — a red gate would not fail the job');
  if (/secrets\./.test(code) || /\$\{\{\s*secrets/.test(code)) v.push('CREDENTIAL: a `secrets.*` reference is present');

  // per-run-command: masking + network/credential.
  for (const s of steps) {
    if (!s.run.trim()) continue;
    for (const p of MASK_PATTERNS) if (p.re.test(s.run)) v.push(`MASKED GATE in step '${s.name}': ${p.why}`);
    for (const p of NETWORK_PATTERNS) if (p.re.test(s.run)) v.push(`NON-HERMETIC in step '${s.name}': ${p.why}`);
  }
  return v;
}

// ================================ the real workflow is clean ================================

test('every required suite is a visible, named step in validate.yml', () => {
  const steps = parseSteps(REAL);
  for (const req of REQUIRED) {
    const hit = steps.find((s) => s.run.includes(req.token));
    assert.ok(hit, `required suite '${req.token}' is not wired into CI as a run step`);
    assert.ok(hit.name && hit.name.trim(), `suite '${req.token}' must be a NAMED step`);
  }
});

test('validate-skills runs both surfaces with hooks (--surface all --hooks)', () => {
  const steps = parseSteps(REAL);
  const hit = steps.find((s) => s.run.includes('validate-skills.mjs'));
  assert.ok(hit, 'validate-skills.mjs is not wired into CI');
  assert.match(hit.run, /--surface all/, 'validate-skills must run --surface all');
  assert.match(hit.run, /--hooks/, 'validate-skills must run --hooks');
});

test('CI never opts into --live (real Codex / network) — every codex-touching suite runs in fake mode', () => {
  assert.doesNotMatch(stripComments(REAL), /--live\b/, 'CI must never opt into --live (real Codex / network)');
});

test('the site slice step is preserved (test-site.mjs still wired)', () => {
  const steps = parseSteps(REAL);
  assert.ok(steps.some((s) => s.run.includes('test-site.mjs')), 'site slice step (test-site.mjs) must not be removed');
});

test('no gate is maskable: no continue-on-error and no shell masking in any run', () => {
  assert.doesNotMatch(stripComments(REAL), /continue-on-error/, 'continue-on-error would let a red gate pass');
  const steps = parseSteps(REAL);
  for (const s of steps) {
    if (!s.run.trim()) continue;
    for (const p of MASK_PATTERNS) assert.doesNotMatch(s.run, p.re, `step '${s.name}': ${p.why}`);
  }
});

test('CI is hermetic: no network / credential / secret use', () => {
  assert.doesNotMatch(stripComments(REAL), /secrets\./, 'no secrets.* plumbing allowed');
  const steps = parseSteps(REAL);
  for (const s of steps) {
    if (!s.run.trim()) continue;
    for (const p of NETWORK_PATTERNS) assert.doesNotMatch(s.run, p.re, `step '${s.name}': ${p.why}`);
  }
});

test('auditWorkflow reports ZERO violations on the real workflow', () => {
  const v = auditWorkflow(REAL);
  assert.deepEqual(v, [], `real validate.yml should be clean but got:\n  ${v.join('\n  ')}`);
});

// ================================ mutation battery: the checker BITES ================================

test('MUTATION — a removed suite is caught', () => {
  const broken = REAL.replace('scripts/test-pipeline-security.mjs', 'scripts/test-pipeline-security-DELETED.mjs');
  const v = auditWorkflow(broken);
  assert.ok(v.some((x) => x.includes('MISSING SUITE') && x.includes('test-pipeline-security.mjs')),
    `dropping a required suite must be caught, got: ${JSON.stringify(v)}`);
});

test('MUTATION — continue-on-error is caught', () => {
  const broken = REAL.replace(
    '        run: bash scripts/test-guards.sh',
    '        continue-on-error: true\n        run: bash scripts/test-guards.sh');
  const v = auditWorkflow(broken);
  assert.ok(v.some((x) => x.includes('continue-on-error')), `continue-on-error must be caught, got: ${JSON.stringify(v)}`);
});

test('MUTATION — a `|| true` masked gate is caught', () => {
  const broken = REAL.replace(
    '        run: bash scripts/test-guards.sh',
    '        run: bash scripts/test-guards.sh || true');
  const v = auditWorkflow(broken);
  assert.ok(v.some((x) => x.includes('MASKED GATE')), `|| true masking must be caught, got: ${JSON.stringify(v)}`);
});

test('MUTATION — a semicolon-chained passing command masking a failed gate is caught', () => {
  const broken = REAL.replace(
    '        run: node --test scripts/test-cli-contract.mjs',
    '        run: node --test scripts/test-cli-contract.mjs; echo ok');
  const v = auditWorkflow(broken);
  assert.ok(v.some((x) => x.includes('MASKED GATE')), `; chaining must be caught, got: ${JSON.stringify(v)}`);
});

test('MUTATION — a network + credential call is caught', () => {
  const broken = REAL.replace(
    '        run: bash scripts/test-harvest.sh',
    '        run: curl https://registry.example.com/publish\n      - name: creds\n        env:\n          T: ${{ secrets.NPM_TOKEN }}\n        run: bash scripts/test-harvest.sh');
  const v = auditWorkflow(broken);
  assert.ok(v.some((x) => x.includes('NON-HERMETIC')), `network use must be caught, got: ${JSON.stringify(v)}`);
  assert.ok(v.some((x) => x.includes('CREDENTIAL')), `secrets use must be caught, got: ${JSON.stringify(v)}`);
});

test('MUTATION — flipping a codex-touching step to --live is caught', () => {
  const broken = REAL.replace('scripts/test-codex-executor.mjs', 'scripts/test-codex-executor.mjs --live');
  const v = auditWorkflow(broken);
  assert.ok(v.some((x) => x.includes('--live')), `--live opt-in must be caught, got: ${JSON.stringify(v)}`);
});
