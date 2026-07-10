#!/usr/bin/env node
// test-pipeline-workflow.mjs — behavior contract tests for autonomous-pipeline/references/pipeline-workflow.js.
//
// The pipeline-workflow.js runs under Claude Code's Workflow tool, which wraps the script (export const
// meta → local, injects the agent/parallel/pipeline/phase/log/args/budget globals, and turns the top-level
// await + returns into the resolved value). This harness replicates that wrapping with a MOCK runtime so
// the ACTUAL script is driven through its fail-closed transitions in CI — no live agents, deterministic.
//
// Each scenario asserts a load-bearing guarantee that prose alone can't enforce (and that a refactor could
// silently regress):
//   happy                 — a clean run converges (both tasks integrate, empty register)
//   validateFalse         — an engineer's validatePassed:false BLOCKS the task and never merges broken code
//   simplifyNotOk         — an optional phase's ok:false is NOT swallowed into converged:true
//   buildBlockedDownstream— a blocked build still runs downstream phases but reports converged:false
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'autonomous-pipeline', 'references', 'pipeline-workflow.js');
const src = readFileSync(SCRIPT, 'utf8').replace('export const meta', 'const meta');
const makeRun = () => new Function(
  'agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget',
  `return (async () => {\n${src}\n})()`,
);

const baseArgs = () => ({
  root: '/repo', workingBranch: 'feat', validate: 'npm test',
  planPath: '.ulpi/plans/p.json', statusFile: '.ulpi/runs/r.json',
  approved: true, // checkpointCli omitted on purpose → no status/persist agents fire (fewer mock branches)
  config: { simplify: true, performance: true, shipPrep: true },
});

// two tasks in ONE layer → exercises intra-layer concurrency + the serialized integrate/fix (rootLock) path
const PLAN = {
  tasks: [
    { id: 'T1', title: 't1', writeScope: ['a.ts'], validate: 'npm test a', acceptance: [], dependsOn: [] },
    { id: 'T2', title: 't2', writeScope: ['b.ts'], validate: 'npm test b', acceptance: [], dependsOn: [] },
  ],
  layers: [['T1', 'T2']],
};

function mockRuntime(scn) {
  const S = { calls: [], integrated: [], fixes: [] };
  const phase = () => {};
  const log = () => {};
  const parallel = (thunks) => Promise.all(thunks.map((t) => t()));
  const pipeline = async () => { throw new Error('pipeline() not expected in this script'); };
  const budget = { total: null, remaining: () => Infinity, spent: () => 0 };
  const agent = async (_prompt, opts = {}) => {
    const label = opts.label || '';
    const ph = opts.phase || '';
    S.calls.push(label);
    if (label === 'preflight')
      return { ok: true, plan: PLAN, doneUnits: [], donePhases: [], openItems: [], problems: [] };
    if (label.startsWith('eng:')) return scn.eng(label.slice(4));
    if (label.startsWith('integrate:')) { S.integrated.push(label.slice(10)); return { merged: true }; }
    if (label.startsWith('fix:')) { S.fixes.push(label.slice(4)); return { ok: true }; }
    if (label.startsWith('review:') && ph === 'Build') return { pass: true, findings: [] };   // slice review
    if (label.startsWith('review:') && ph === 'Review') return { findings: [] };              // dimension review
    if (label.startsWith('verify:')) return { refuted: true };
    if (label === 'final-validate') return { passed: scn.finalPass !== false, output: '' };
    if (['simplify', 'test', 'performance', 'ship prep'].includes(label))
      return scn.phaseAgent ? scn.phaseAgent(label) : { ok: true, summary: '', findings: [] };
    return {}; // any residual (status) writes
  };
  return { S, run: () => makeRun()(agent, parallel, pipeline, phase, log, scn.args || baseArgs(), budget) };
}

const scenarios = {
  async happy() {
    const { S, run } = mockRuntime({ eng: () => ({ built: true, validatePassed: true, files: [], notes: '' }) });
    const r = await run();
    return { pass: r.converged === true && S.integrated.length === 2 && r.register.length === 0,
      detail: `converged=${r.converged} integrated=[${S.integrated}] register=${r.register.length}` };
  },
  async validateFalse() {
    const { S, run } = mockRuntime({ eng: (id) => id === 'T1'
      ? ({ built: true, validatePassed: false, files: [], notes: 'slice red' })
      : ({ built: true, validatePassed: true, files: [], notes: '' }) });
    const r = await run();
    const t1Blocked = r.register.some((x) => x.task === 'T1' && x.phase === 'build');
    return { pass: r.converged === false && !S.integrated.includes('T1') && S.integrated.includes('T2') && t1Blocked,
      detail: `converged=${r.converged} integrated=[${S.integrated}] T1blocked=${t1Blocked}` };
  },
  async simplifyNotOk() {
    const { run } = mockRuntime({
      eng: () => ({ built: true, validatePassed: true, files: [], notes: '' }),
      phaseAgent: (label) => label === 'simplify'
        ? ({ ok: false, summary: 'could not complete', findings: [] })
        : ({ ok: true, summary: '', findings: [] }) });
    const r = await run();
    const simpGate = r.register.some((x) => x.phase === 'simplify' && x.kind === 'gate');
    return { pass: r.converged === false && simpGate,
      detail: `converged=${r.converged} simplifyGateItem=${simpGate}` };
  },
  async buildBlockedDownstream() {
    const { S, run } = mockRuntime({ eng: (id) => id === 'T1'
      ? ({ built: false, validatePassed: false, files: [], notes: 'engineer gave up' })
      : ({ built: true, validatePassed: true, files: [], notes: '' }) });
    const r = await run();
    const ranTest = S.calls.includes('test');
    const ranReview = S.calls.some((c) => c.startsWith('review:'));
    const ranFinal = S.calls.includes('final-validate');
    return { pass: r.converged === false && ranTest && ranReview && ranFinal,
      detail: `converged=${r.converged} ranTest=${ranTest} ranReview=${ranReview} ranFinal=${ranFinal}` };
  },
};

let fails = 0;
for (const [name, fn] of Object.entries(scenarios)) {
  try {
    const { pass, detail } = await fn();
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
    if (!pass) fails++;
  } catch (e) {
    console.log(`FAIL ${name} — threw: ${e.message}`);
    fails++;
  }
}
console.log(fails === 0 ? '\n✓ all pipeline-workflow transition tests pass' : `\n✗ ${fails} pipeline-workflow test(s) failed`);
process.exit(fails ? 1 : 0);
