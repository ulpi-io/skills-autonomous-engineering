export const site = {
  name: 'Autonomous Engineering Skills',
  shortName: 'autonomous-engineering',
  origin: 'https://ulpi-io.github.io',
  basePath: '/skills-autonomous-engineering/',
  repository: 'https://github.com/ulpi-io/skills-autonomous-engineering',
  description: 'Eighteen bounded, fail-closed, checkpoint-resumable skills for autonomous software delivery across Claude Code, Codex, and skills.sh.',
  analytics: {
    googleMeasurementId: 'G-2JN5Y3QCSS',
    // The current repository and deployed page do not expose a Clarity project
    // ID. Set it here once known; the shared runtime will load Clarity globally.
    clarityProjectId: '',
  },
};

export const pipeline = [
  { number: '01', label: 'Define', slug: 'auto-spec', result: 'testable spec' },
  { number: '02', label: 'Plan', slug: 'auto-plan', result: 'validated DAG' },
  { number: '03', label: 'Build', slug: 'auto-build', result: 'task commits' },
  { number: '04', label: 'Clean', slug: 'auto-simplify', result: 'simpler code' },
  { number: '05', label: 'Prove', slug: 'auto-test', result: 'meaningful tests' },
  { number: '06', label: 'Gate', slug: 'auto-review', result: 'verified findings' },
  { number: '07', label: 'Measure', slug: 'auto-performance', result: 'proven gains' },
  { number: '08', label: 'Ship', slug: 'auto-ship', result: 'release-ready' },
];

export const contracts = [
  {
    title: 'Bounded, never infinite',
    text: 'Every unattended run declares a machine-checkable done condition, a hard cap, a cost or time budget, a no-progress rule, and escalation triggers before it starts.',
  },
  {
    title: 'Fails closed',
    text: 'A gate that did not run is not clean. Exhausted is not converged. Red evidence remains red all the way to the final report.',
  },
  {
    title: 'Verifies before acting',
    text: 'Findings that drive edits are attacked by independent skeptics. Rejected and unverified claims remain visible instead of quietly becoming work.',
  },
  {
    title: 'Durable and resumable',
    text: 'Long work records a checkpoint and resumes by skipping units already verified done. The checkpoint, not a session transcript, is the durable truth.',
  },
  {
    title: 'Escalates, never guesses',
    text: 'Ambiguity, irreversible actions, repeated stalls, and authority changes stop at a human boundary. One approval never becomes blanket permission.',
  },
  {
    title: 'Measures, never assumes',
    text: 'Tests, validators, benchmarks, diffs, and reachability decide whether work landed. Agent assertions are useful context, never proof.',
  },
];

export const failureModes = [
  {
    title: 'Fakes the green',
    text: 'Common skip, only, suppression, bulk-stage, and irreversible-push spellings are blocked by tested guards. Deeper cheats are caught by mutation and evidence checks.',
  },
  {
    title: 'Grinds forever',
    text: 'Iteration, agent, time, and no-progress limits make non-convergence an honest partial result instead of an invisible runaway.',
  },
  {
    title: 'Poisons the history',
    text: 'Disjoint task scopes, isolated writers, explicit staging, and per-task commits preserve reviewable rollback points.',
  },
  {
    title: 'Lies about done',
    text: 'Required evidence is observed by the coordinator. Missing validation, dead verifiers, and skipped gates cannot be worded into success.',
  },
];

export const enforcement = [
  {
    name: 'guard-test-integrity',
    blocks: 'Common static suite-gaming forms added to test files: .only, .skip, xit, and suppressions.',
    evidence: 'scripts/test-guards.sh',
  },
  {
    name: 'guard-git-hygiene',
    blocks: 'Bulk staging, destructive reset or clean, commit -a, and unsafe force-push forms during a live build.',
    evidence: 'scripts/test-guards.sh',
  },
  {
    name: 'guard-ship-irreversibles',
    blocks: 'Unapproved forced updates and remote ref deletion while ship preparation is active.',
    evidence: 'scripts/test-guards.sh',
  },
  {
    name: 'checkpoint.mjs',
    blocks: 'Reinitializing a live run, demoting done work, and finalizing an incomplete checkpoint as done.',
    evidence: 'scripts/test-checkpoint.sh',
  },
];

export const pluginComparison = [
  ['Distribution', 'Claude marketplace plugin', 'Reproducible Codex marketplace artifact'],
  ['Skill surface', '18 canonical root skills', '18 plugin-qualified Codex adapters'],
  ['Invocation', '/skill-name and model routing', '$autonomous-engineering:<skill>'],
  ['Context', 'CLAUDE.md, scoped rules, Claude memory', 'AGENTS.md and Codex-native project context'],
  ['Orchestration', 'Workflow templates plus native goal/loop surfaces', 'Deterministic coordinator plus pinned codex exec'],
  ['Hooks', 'Claude lifecycle events and skill guards', 'Repository hooks are not bundled in the source artifact'],
  ['Status', 'Available now', 'Available now from source · v0.1.0'],
];

export const claudeHooks = [
  ['SessionStart', 'Find resumable runs and surface the exact resume path.'],
  ['PreToolUse', 'Run the active skill’s test, Git, and ship guards.'],
  ['Stop', 'Surface a still-running checkpoint so termination stays honest.'],
  ['SessionEnd', 'Clean up terminal run state without touching active work.'],
];

export const codexCapabilities = [
  'A manifest-directed adapter tree isolated from Claude discovery and sealed at 18 skills.',
  'A deterministic, checkpointed coordinator for Git, validation, budgets, and convergence.',
  'Pinned codex exec schemas with typed blocked outcomes instead of prose-owned control flow.',
  'Durable checkpoint state, bounded fan-out, and worktree isolation around the coordinator.',
  'Provider-native project context, resume, learning, and watching with explicit unsupported outcomes.',
  'A reproducible marketplace artifact with isolated add/list, new-session discovery, and invocation verification.',
];

export const universalInstall = 'npx skills add https://github.com/ulpi-io/skills-autonomous-engineering';
export const singleSkillInstall = (slug) => `${universalInstall} --skill ${slug}`;
export const claudePipelineRun = '/autonomous-pipeline "<feature>"';
export const codexPipelineRun = '$autonomous-engineering:autonomous-pipeline "<feature>"';
export const codexInstallCommands = [
  'node scripts/package-codex-plugin.mjs --out /tmp/ulpi-codex-market',
  'codex plugin marketplace add /tmp/ulpi-codex-market',
  'codex plugin marketplace list',
  'codex plugin add autonomous-engineering@autonomous-engineering',
  'codex plugin list',
];
