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
//   happy                 — a clean ordinary pass integrates both tasks but awaits required closeout
//   validateFalse         — an engineer's validatePassed:false BLOCKS the task and never merges broken code
//   simplifyNotOk         — an optional phase's ok:false is NOT swallowed into converged:true
//   buildBlockedDownstream— a blocked build still runs downstream phases but reports converged:false
//   trailerPromptContract — no-checkpointCli prompts still emit + reconcile reachable Task-Id trailers
//   reconciledUnitSkipped — preflight-reconciled doneUnits are skipped and unblock their dependents
//   wholeRegister         — severity/source cannot hide defects; pure info is reported separately; a
//                           selected-scope "info/deferred" remains actionable
//   durableWholeRegister  — checkpoint writes include gate items and every finding (batched, never capped)
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
  selectedScope: [
    { id: 'SCOPE-001', title: 'first selected feature', source: 'user-selected test scope' },
    { id: 'SCOPE-002', title: 'second selected feature', source: 'user-selected test scope' },
  ],
  scopeDrops: [],
  tasks: [
    { id: 'T1', title: 't1', writeScope: ['a.ts'], validate: 'npm test a', acceptance: [], dependsOn: [], scopeItems: ['SCOPE-001'] },
    { id: 'T2', title: 't2', writeScope: ['b.ts'], validate: 'npm test b', acceptance: [], dependsOn: [], scopeItems: ['SCOPE-002'] },
  ],
  layers: [['T1', 'T2']],
};

const DEP_PLAN = {
  selectedScope: PLAN.selectedScope,
  scopeDrops: [],
  tasks: [
    { id: 'T1', title: 't1', writeScope: ['a.ts'], validate: 'npm test a', acceptance: [], dependsOn: [], scopeItems: ['SCOPE-001'] },
    { id: 'T2', title: 't2', writeScope: ['b.ts'], validate: 'npm test b', acceptance: [], dependsOn: ['T1'], scopeItems: ['SCOPE-002'] },
  ],
  layers: [['T1'], ['T2']],
};

function mockRuntime(scn) {
  const S = { calls: [], integrated: [], fixes: [], prompts: [] };
  const phase = () => {};
  const log = () => {};
  const parallel = (thunks) => Promise.all(thunks.map((t) => t()));
  const pipeline = async () => { throw new Error('pipeline() not expected in this script'); };
  const budget = { total: null, remaining: () => Infinity, spent: () => 0 };
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || '';
    const ph = opts.phase || '';
    S.calls.push(label);
    S.prompts.push({ label, prompt });
    if (label === 'preflight')
      return { ok: true, plan: scn.plan || PLAN, doneUnits: scn.doneUnits || [], donePhases: [], openItems: [], problems: [] };
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
    return { pass: r.converged === false && r.workflowConverged === true
        && r.closeoutRequired.join(',') === 'auto_learn,auto_map' && S.integrated.length === 2 && r.register.length === 0,
      detail: `converged=${r.converged} workflowConverged=${r.workflowConverged} closeout=[${r.closeoutRequired}] integrated=[${S.integrated}] register=${r.register.length}` };
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
  async trailerPromptContract() {
    const { S, run } = mockRuntime({ eng: () => ({ built: true, validatePassed: true, files: [], notes: '' }) });
    const r = await run();
    const preflight = S.prompts.find((x) => x.label === 'preflight')?.prompt || '';
    const integrate = S.prompts.find((x) => x.label === 'integrate:T1')?.prompt || '';
    const preflightUnconditional = preflight.includes('ALWAYS do this even when checkpointCli is unset')
      && preflight.includes('git -C /repo log feat --format=%B')
      && preflight.includes('Task-Id: <id>')
      && preflight.includes('UNION those ids into doneUnits')
      && preflight.includes('not feat) is NOT done');
    const integrateTrailers = integrate.includes('git -C /repo merge --no-ff --no-commit task/T1')
      && integrate.includes('git -C /repo commit -m "Integrate task T1" -m "Task-Id: T1"')
      && integrate.includes('git -C /repo log feat --format=%B')
      && integrate.includes('exact trailer `Task-Id: T1`');
    return { pass: r.converged === false && r.workflowConverged === true && preflightUnconditional && integrateTrailers,
      detail: `converged=${r.converged} workflowConverged=${r.workflowConverged} preflightUnconditional=${preflightUnconditional} integrateTrailers=${integrateTrailers}` };
  },
  async reconciledUnitSkipped() {
    const { S, run } = mockRuntime({
      plan: DEP_PLAN,
      doneUnits: ['T1'],
      eng: (id) => ({ built: id === 'T2', validatePassed: id === 'T2', files: [], notes: '' }),
    });
    const r = await run();
    const t1Skipped = !S.calls.includes('eng:T1') && !S.integrated.includes('T1');
    const dependentUnblocked = S.calls.includes('eng:T2') && S.integrated.includes('T2');
    return { pass: r.converged === false && r.workflowConverged === true && t1Skipped && dependentUnblocked,
      detail: `converged=${r.converged} workflowConverged=${r.workflowConverged} integrated=[${S.integrated}] t1Skipped=${t1Skipped} dependentUnblocked=${dependentUnblocked}` };
  },
  async scopeUnderCovered() {
    const plan = {
      ...PLAN,
      tasks: PLAN.tasks.map((t) => ({ ...t, scopeItems: t.id === 'T1' ? ['SCOPE-001'] : [] })),
    };
    const { S, run } = mockRuntime({ plan, eng: () => ({ built: true, validatePassed: true, files: [], notes: '' }) });
    const r = await run();
    const scopeGate = r.register.some((x) => x.phase === 'preflight' && String(x.why).includes('SCOPE-002 is UNCOVERED'));
    return { pass: r.aborted === true && r.converged === false && r.workflowConverged === false
        && r.closeoutRequired.join(',') === 'auto_learn' && scopeGate && !S.calls.some((x) => x.startsWith('eng:')),
      detail: `aborted=${r.aborted} scopeGate=${scopeGate} buildCalls=${S.calls.filter((x) => x.startsWith('eng:')).length}` };
  },
  async wholeRegister() {
    const scopedPlan = {
      ...PLAN,
      selectedScope: [{ id: 'SCOPE-001', title: 'selected feature', source: 'user selected Full MVP' }],
      scopeDrops: [],
      tasks: PLAN.tasks.map((t, i) => ({ ...t, scopeItems: i === 0 ? ['SCOPE-001'] : [] })),
    };
    const { run } = mockRuntime({
      plan: scopedPlan,
      eng: () => ({ built: true, validatePassed: true, files: [], notes: '' }),
      phaseAgent: (label) => {
        if (label === 'simplify') return { ok: true, summary: '', findings: [{ kind: 'info', issue: 'non-selected observation' }] };
        if (label === 'test') return { ok: true, summary: '', findings: [{ severity: 'low', issue: 'low severity defect' }] };
        if (label === 'performance') return { ok: true, summary: '', findings: [{ kind: 'info', scopeId: 'SCOPE-001', issue: 'selected feature called info' }] };
        return { ok: true, summary: '', findings: [] };
      },
    });
    const r = await run();
    const lowActionable = r.register.some((x) => x.issue === 'low severity defect' && x.actionable === true);
    const selectedActionable = r.register.some((x) => x.scopeId === 'SCOPE-001' && x.actionable === true);
    const infoSeparate = r.informational.some((x) => x.issue === 'non-selected observation' && x.actionable === false);
    return { pass: r.converged === false && lowActionable && selectedActionable && infoSeparate && r.register.length === 2,
      detail: `converged=${r.converged} actionable=${r.register.length} info=${r.informational.length} low=${lowActionable} selected=${selectedActionable}` };
  },
  async durableWholeRegister() {
    const findings = Array.from({ length: 27 }, (_, i) => ({ severity: 'low', issue: `defect-${i + 1}` }));
    const { S, run } = mockRuntime({
      args: { ...baseArgs(), checkpointCli: '/checkpoint.mjs' },
      eng: () => ({ built: true, validatePassed: true, files: [], notes: '' }),
      phaseAgent: (label) => {
        if (label === 'simplify') return { ok: false, summary: 'simplify gate failed', findings: [] };
        if (label === 'test') return { ok: true, summary: '', findings };
        return { ok: true, summary: '', findings: [] };
      },
    });
    const r = await run();
    const simplifyWrite = S.prompts.find((x) => x.label === 'status:simplify:blocked')?.prompt || '';
    const testWrite = S.prompts.find((x) => x.label === 'status:test:done')?.prompt || '';
    const gatePersisted = simplifyWrite.includes('simplify gate failed') && simplifyWrite.includes('"kind":"gate"');
    const fullyBatched = testWrite.includes('ITEMS BATCH 1/2') && testWrite.includes('ITEMS BATCH 2/2')
      && testWrite.includes('defect-1') && testWrite.includes('defect-27');
    return { pass: r.converged === false && gatePersisted && fullyBatched && r.register.length === 28,
      detail: `actionable=${r.register.length} gatePersisted=${gatePersisted} fullyBatched=${fullyBatched}` };
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
