// pipeline-workflow.js — the runnable Workflow behind `autonomous-pipeline`.
//
// The SKILL does everything human-facing BEFORE launching this: intake + config questions,
// auto-spec, auto-plan, and THE SINGLE PLAN APPROVAL (a Workflow cannot ask the user mid-run).
// This script executes the approved, unattended stretch — build → simplify → test → review →
// performance → ship-prep — with FAIL-CLOSED gates between phases, a durable checkpoint the
// skill created beforehand, and a verified findings register as the return value. ONE pass,
// no autonomous recursion: if the register is non-empty the USER decides on a fix round.
//
// Launch (from the skill):
//   Workflow({ scriptPath: "<this file>", args: {
//     root: "<abs repo path>",              // REQUIRED — git work tree with a committed branch
//     workingBranch: "<branch>",            // REQUIRED — never a protected branch unconfirmed
//     validate: "<workspace validate cmd>", // REQUIRED — the end-state truth gate
//     planPath: ".ulpi/plans/<x>.json",     // REQUIRED — the APPROVED DAG plan
//     approved: true,                       // REQUIRED — the skill recorded the human approval
//     statusFile: ".ulpi/runs/<id>.json",   // REQUIRED — created by the skill before launch
//     checkpointCli: "<abs path to checkpoint-resume/scripts/checkpoint.mjs>", // for status agents
//     config: { simplify: true, performance: false, shipPrep: true },  // optional-phase switches
//     maxFix: 3, maxBuildParallel: 4, maxParallel: 6                   // caps (defaults shown)
//   }})
//
// Every status write is NON-FATAL (`|| true`). Resume: the build phase reads the checkpoint and
// SKIPS done tasks (durable, session-independent) — relaunch with the same args after a stop.

export const meta = {
  name: 'autonomous-pipeline',
  description: 'Approved-plan build → simplify → test → review → performance → ship-prep with fail-closed gates, durable checkpoint, verified findings register',
  phases: [
    { title: 'Preflight', detail: 'validate plan DAG + clean baseline + checkpoint' },
    { title: 'Build', detail: 'DAG layers: worktree engineer → integrate → slice review → bounded fix' },
    { title: 'Simplify', detail: 'behavior-preserving cleanup over the build diff (optional)' },
    { title: 'Test', detail: 'coverage gaps → mutation-verified tests → until-green' },
    { title: 'Review', detail: 'multi-dimension review → dedup → adversarial verify' },
    { title: 'Performance', detail: 'baseline → hotspots → benchmark-gated optimize (optional)' },
    { title: 'Ship prep', detail: 'fail-closed gate audit + release artifacts (no irreversible step)' },
    { title: 'Finalize', detail: 'final workspace validate + register + checkpoint' },
  ],
}

// ── args (hard-fail on missing inputs; a silent FILL default here would fake a clean run) ──
let CFG = {}
if (args && typeof args === 'object') CFG = args
else if (typeof args === 'string' && args.trim()) { try { CFG = JSON.parse(args) } catch { CFG = {} } }
const need = (k) => { if (!CFG[k]) throw new Error(`autonomous-pipeline: missing required arg '${k}' — launch from the skill with full args`) ; return CFG[k] }
const ROOT = need('root'), BRANCH = need('workingBranch'), VALIDATE = need('validate')
const PLAN_PATH = need('planPath'), STATUS = need('statusFile')
if (CFG.approved !== true) throw new Error('autonomous-pipeline: plan not approved — the single human gate is mandatory')
const CK = CFG.checkpointCli || ''
const OPT = { simplify: true, performance: false, shipPrep: true, ...(CFG.config || {}) }
const MAX_FIX = CFG.maxFix ?? 3
const MAX_BUILD_PARALLEL = CFG.maxBuildParallel ?? 4   // worktree engineers are heavy (full checkout)
const MAX_PARALLEL = CFG.maxParallel ?? 6              // read-only reviewers/verifiers

const ck = (opArgs) => CK ? `node "${CK}" ${opArgs} || true` : `true`
const register = []   // verified open findings — the return value
const gateFail = (phase, why) => { register.push({ phase, kind: 'gate', why }); log(`GATE FAILED [${phase}]: ${why}`) }

// concurrency gate (bounds simultaneity, not total)
async function mapCapped(items, cap, fn) {
  const out = []; let i = 0
  async function worker() { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k) } }
  await Promise.all(Array.from({ length: Math.min(cap, Math.max(items.length, 1)) }, worker))
  return out
}

// ── Preflight ─────────────────────────────────────────────────────────────────────
phase('Preflight')
const pre = await agent(
  `Preflight for an autonomous build in ${ROOT} on branch ${BRANCH}.
   1. Read ${PLAN_PATH} (JSON). Validate: tasks[] each with id, title, writeScope[], validate, acceptance; layers[][] is a topological order of task ids that respects each task's dependsOn (no cycle, nothing ordered before a dependency). Intra-layer tasks must have disjoint writeScope.
   2. Run: git -C ${ROOT} rev-parse --is-inside-work-tree ; git -C ${ROOT} status --porcelain
   3. Read the checkpoint ${STATUS}${CK ? ` via: node "${CK}" resume ${STATUS}` : ''} — collect units already done (checkpoint resume: done tasks are SKIPPED, never rebuilt).
   Return JSON: { ok, plan: {tasks, layers}, doneUnits: [ids], problems: [strings] }. ok=false if the plan is malformed/cyclic/mis-ordered, the tree is not git, or the baseline has unexpected uncommitted changes (anything beyond .ulpi/**).`,
  { label: 'preflight', schema: { type: 'object', required: ['ok'], properties: {
      ok: { type: 'boolean' }, plan: { type: 'object' }, doneUnits: { type: 'array', items: { type: 'string' } },
      problems: { type: 'array', items: { type: 'string' } } } } })
if (!pre?.ok) {
  gateFail('preflight', (pre?.problems || ['preflight agent died']).join('; '))
  await agent(`Run: ${ck(`finalize ${STATUS} aborted --result "preflight failed"`)}`, { label: 'status:abort' })
  return { converged: false, aborted: true, register }
}
const PLAN = pre.plan, DONE = new Set(pre.doneUnits || [])
const taskById = Object.fromEntries((PLAN.tasks || []).map(t => [t.id, t]))

// ── Build: walk the DAG, barrier between layers ──────────────────────────────────
phase('Build')
await agent(`Run: ${ck(`phase ${STATUS} build running`)}`, { label: 'status:build', phase: 'Build' })
const buildOut = []
for (const [li, layer] of (PLAN.layers || []).entries()) {
  const todo = layer.filter(id => !DONE.has(id))
  log(`layer ${li + 1}/${PLAN.layers.length}: ${todo.length} task(s) to build, ${layer.length - todo.length} skipped (done)`)
  const results = await mapCapped(todo, MAX_BUILD_PARALLEL, async (id) => {
    const t = taskById[id]
    if (!t) return { id, status: 'blocked', why: 'task missing from plan' }
    if ((t.dependsOn || []).some(d => !DONE.has(d) && !buildOut.find(b => b.id === d && b.status === 'done')))
      return { id, status: 'dep_blocked', why: `dependency not integrated` }
    await agent(`Run: ${ck(`unit ${STATUS} ${id} in_progress`)}`, { label: `status:${id}`, phase: 'Build' })
    // engineer (isolated worktree, test-first, write-scope-bound)
    const eng = await agent(
      `You are the engineer for ONE task of an approved plan. Repo: ${ROOT}, base branch: ${BRANCH}.
       TASK ${id}: ${t.title}. Acceptance: ${JSON.stringify(t.acceptance || t.acceptanceCriteria || [])}.
       WRITE SCOPE (only these paths): ${JSON.stringify(t.writeScope || [])}. Slice validate: ${t.validate}.
       Method (non-negotiable): create worktree+branch task/${id}; write a FAILING test for the behavior first (RED), implement minimally (GREEN), refactor with tests green; stay inside the write scope; run the slice validate. NEVER git add -A (explicit paths only), never skip/weaken a test to pass.
       Return JSON: { built: bool, validatePassed: bool, files: [paths], notes: string, escalate: string|null } (escalate = a decision a user must make; set built=false then).`,
      { label: `eng:${id}`, phase: 'Build', isolation: 'worktree',
        schema: { type: 'object', required: ['built', 'validatePassed'], properties: {
          built: { type: 'boolean' }, validatePassed: { type: 'boolean' },
          files: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' },
          escalate: { type: ['string', 'null'] } } } })
    if (!eng?.built || eng?.escalate) {
      const why = eng?.escalate || eng?.notes || 'engineer failed'
      await agent(`Run: ${ck(`unit ${STATUS} ${id} blocked --note "${why.slice(0, 120).replace(/"/g, '')}"`)}`, { label: `status:${id}`, phase: 'Build' })
      return { id, status: 'blocked', why }
    }
    // integrate (serialized by the layer cap=1 nature of merges — merge-only, prune worktree)
    const integ = await agent(
      `Integrate task ${id}: in ${ROOT}, git merge --no-ff task/${id} onto ${BRANCH}; then remove the task worktree (git worktree list → remove the task/${id} one) and delete branch task/${id}. Merge-only: do NOT run the whole-workspace validate. Return JSON {merged: bool, conflict: string|null}.`,
      { label: `integrate:${id}`, phase: 'Build',
        schema: { type: 'object', required: ['merged'], properties: { merged: { type: 'boolean' }, conflict: { type: ['string', 'null'] } } } })
    if (!integ?.merged) {
      await agent(`Run: ${ck(`unit ${STATUS} ${id} blocked --note "merge conflict"`)}`, { label: `status:${id}`, phase: 'Build' })
      return { id, status: 'blocked', why: `integration failed: ${integ?.conflict || 'unknown'}` }
    }
    // slice-scoped review + bounded fix loop
    let verdict = { pass: true, findings: [] }
    for (let attempt = 0; attempt <= MAX_FIX; attempt++) {
      verdict = await agent(
        `Slice-scoped review of task ${id} on ${BRANCH} in ${ROOT}. Judge ONLY this task's own diff (write scope ${JSON.stringify(t.writeScope || [])}) against ITS acceptance criteria ${JSON.stringify(t.acceptance || [])}. A whole-codebase gap a LATER task owns is an OBSERVATION, never a block here. Run the slice validate: ${t.validate}. Return JSON { pass: bool, findings: [{file,line,issue,inScope:bool}] } — pass=false only for in-scope defects or a red slice validate.`,
        { label: `review:${id}`, phase: 'Build',
          schema: { type: 'object', required: ['pass'], properties: { pass: { type: 'boolean' },
            findings: { type: 'array', items: { type: 'object' } } } } })
      if (verdict?.pass || attempt === MAX_FIX) break
      const inScope = (verdict?.findings || []).filter(f => f.inScope !== false)
      if (!inScope.length) break
      await agent(
        `Fix loop for task ${id} (attempt ${attempt + 1}/${MAX_FIX}): apply the MINIMAL fixes for these in-scope findings on ${BRANCH} in ${ROOT}, staying inside ${JSON.stringify(t.writeScope || [])}, then re-run ${t.validate}. Findings: ${JSON.stringify(inScope).slice(0, 2000)}. Commit only this task's files.`,
        { label: `fix:${id}`, phase: 'Build' })
    }
    const done = verdict?.pass === true
    await agent(`Run: ${ck(`unit ${STATUS} ${id} ${done ? 'done' : 'blocked'}${done ? '' : ' --note "review blocked after fix loop"'}`)}`, { label: `status:${id}`, phase: 'Build' })
    if (done) DONE.add(id)
    return { id, status: done ? 'done' : 'blocked', why: done ? '' : 'review blocked after bounded fix loop' }
  })
  buildOut.push(...results.filter(Boolean))
}
const blocked = buildOut.filter(b => b.status !== 'done')
blocked.forEach(b => register.push({ phase: 'build', kind: b.status, task: b.id, why: b.why }))
if (blocked.length) log(`build: ${blocked.length} task(s) not done — continuing to gates, register carries them (fail closed)`)

// ── Optional + verify phases (each fail-closed: a phase that died is a gate failure) ──
async function phaseAgent(title, enabled, prompt, schema) {
  phase(title)
  if (!enabled) { log(`${title}: skipped by config (recorded, not counted clean)`); return { skipped: true } }
  await agent(`Run: ${ck(`phase ${STATUS} ${title.toLowerCase().replace(/\s+/g, '_')} running`)}`, { label: `status:${title}`, phase: title })
  const out = await agent(prompt, { label: title.toLowerCase(), phase: title, schema })
  if (!out) gateFail(title.toLowerCase(), `${title} agent died — a gate that did not run is NOT clean`)
  return out || { died: true }
}

const RES_SCHEMA = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' },
  summary: { type: 'string' }, findings: { type: 'array', items: { type: 'object' } } } }

const simp = await phaseAgent('Simplify', OPT.simplify && !blocked.length,
  `Run the auto-simplify contract over the diff of ${BRANCH} vs its base in ${ROOT}: find duplication/dead code/over-abstraction in the CHANGED code only; apply the smallest clarifying edits ONE at a time; after each, prove behavior preserved (relevant tests green + no observable semantic change) or REVERT it. Never remove code whose purpose you haven't established. Return { ok, summary, findings: [reverted-or-flagged items] }.`, RES_SCHEMA)
if (simp?.findings?.length) simp.findings.forEach(f => register.push({ phase: 'simplify', ...f }))

const test = await phaseAgent('Test', true,
  `Run the auto-test contract over the diff of ${BRANCH} in ${ROOT}: find untested behaviors in the changed code; write ONE meaningful test per behavior (state-based, spec-named); MUTATION-CHECK each (break the target — the test must fail; restore — must pass; reject tautologies); loop until the scoped suite is green, max 6 iterations, never skipping/weakening a test. Return { ok: suiteGreen && allMutationChecked, summary, findings: [gaps left, blocked units] }.`, RES_SCHEMA)
if (test && !test.skipped && !test.ok) gateFail('test', test?.summary || 'suite not green / tests not mutation-verified')
if (test?.findings?.length) test.findings.forEach(f => register.push({ phase: 'test', ...f }))

phase('Review')
const DIMENSIONS = ['correctness', 'security', 'test adequacy', 'API/contract compatibility']
const raw = (await mapCapped(DIMENSIONS, MAX_PARALLEL, (dim) => agent(
  `Review the diff of ${BRANCH} vs its base in ${ROOT} through the ${dim.toUpperCase()} lens only. Return JSON { findings: [{file, line, issue, severity: "blocker"|"concern"|"nit", scenario}] } — concrete failure scenarios only, no style opinions.`,
  { label: `review:${dim}`, phase: 'Review', schema: { type: 'object', required: ['findings'],
    properties: { findings: { type: 'array', items: { type: 'object' } } } } }))).filter(Boolean)
if (raw.length < DIMENSIONS.length) gateFail('review', `${DIMENSIONS.length - raw.length} review dimension(s) did not run`)
const dedup = Object.values(Object.fromEntries(raw.flatMap(r => r.findings || [])
  .map(f => [`${f.file}:${f.line}:${(f.issue || '').slice(0, 40)}`, f])))
const confirmed = (await mapCapped(dedup, MAX_PARALLEL, async (f) => {
  const votes = (await parallel([0, 1, 2].map(i => () => agent(
    `Adversarially verify (skeptic #${i + 1}): try to REFUTE this finding against the ACTUAL code in ${ROOT}: ${JSON.stringify(f).slice(0, 800)}. Build the concrete input/path. Default refuted=true if you cannot positively confirm it. Return { refuted: bool, evidence: string }.`,
    { label: `verify:${(f.file || '?').split('/').pop()}`, phase: 'Review',
      schema: { type: 'object', required: ['refuted'], properties: { refuted: { type: 'boolean' }, evidence: { type: 'string' } } } })))).filter(Boolean)
  const survives = votes.length >= 2 && votes.filter(v => !v.refuted).length > votes.filter(v => v.refuted).length
  return survives ? f : null
})).filter(Boolean)
confirmed.forEach(f => register.push({ phase: 'review', kind: 'finding', ...f }))
log(`review: ${dedup.length} raw → ${confirmed.length} confirmed (rejections filtered by adversarial panel)`)

const perf = await phaseAgent('Performance', OPT.performance,
  `Run the auto-performance contract on the changed hot paths of ${BRANCH} in ${ROOT}: establish a reproducible baseline benchmark FIRST, profile to real hotspots, optimize one at a time, keep a change ONLY if re-benchmark shows a real (beyond-variance) win AND the tests stay green — otherwise revert. Return { ok, summary, findings: [unproven/reverted claims] }.`, RES_SCHEMA)
if (perf?.findings?.length) perf.findings.forEach(f => register.push({ phase: 'performance', ...f }))

const ship = await phaseAgent('Ship prep', OPT.shipPrep && confirmed.filter(f => f.severity === 'blocker').length === 0,
  `Run the auto-ship PREP contract (NO irreversible step — no push --force, no deploy, no publish) for ${BRANCH} in ${ROOT}: audit the pre-launch gates (final validate readiness, docs for public changes, rollback path), draft the changelog FROM the actual commits, and prepare (do not open) the PR body with gate results. Return { ok, summary, findings: [gate blockers] }.`, RES_SCHEMA)
if (ship && !ship.skipped && !ship.ok) gateFail('ship-prep', ship?.summary || 'pre-launch gates not clean')
if (ship?.findings?.length) ship.findings.forEach(f => register.push({ phase: 'ship', ...f }))

// ── Finalize: the load-bearing end-state gate ─────────────────────────────────────
phase('Finalize')
const fin = await agent(
  `In ${ROOT} on ${BRANCH}, run the whole-workspace validate ONCE: ${VALIDATE}
   Report honestly. Return JSON { passed: bool, output: string (last 30 lines) }.`,
  { label: 'final-validate', phase: 'Finalize',
    schema: { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' }, output: { type: 'string' } } } })
if (!fin?.passed) gateFail('final-validate', `workspace validate is RED or did not run — the end-state truth gate blocks (${(fin?.output || '').slice(0, 300)})`)
const converged = register.length === 0
await agent(`Run: ${ck(`finalize ${STATUS} ${converged ? 'done' : 'needs_attention'} --result "${converged ? 'pipeline clean' : register.length + ' open item(s)'}"`)}`, { label: 'status:final', phase: 'Finalize' })

return {
  converged,                               // true ONLY if every gate ran clean and the register is empty
  build: buildOut, blockedTaskCount: blocked.length,
  reviewConfirmed: confirmed.length,
  phasesSkipped: Object.entries(OPT).filter(([, v]) => !v).map(([k]) => k),
  workspaceValidatePassed: fin?.passed === true,
  register,                                // the verified open findings — the USER decides the fix round
  statusFile: STATUS,
}
