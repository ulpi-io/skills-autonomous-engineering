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
//     planValidator: "<abs path to auto-plan/scripts/validate-plan.mjs>",       // deterministic DAG gate in preflight
//     config: { simplify: true, performance: false, shipPrep: true },  // optional-phase switches
//     delegate: { build: 'native', review: 'native', verify: 'native' }, // D14: 'codex' per role, offered only if detected
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
// D14: optional per-role Codex delegation — 'native' (default) | 'codex'. OFFERED by the skill only
// when a Codex integration was detected at intake; if a codex role is requested but the integration
// is absent at run time, the role DEGRADES to native and the degradation lands in the register.
const DELEGATE = { build: 'native', review: 'native', verify: 'native', ...(CFG.delegate || {}) }
const codexBrief = (role) => DELEGATE[role] === 'codex'
  ? `\nDELEGATION: the user chose to delegate this ${role} role to Codex. First verify a Codex integration is available (a codex subagent type, or \`command -v codex\`). If available, route the work through it and report its output as yours (you remain accountable for the schema). If NOT available, do the work natively yourself and include "delegationDegraded": true in your notes/summary.`
  : ''
const MAX_FIX = CFG.maxFix ?? 3
const MAX_BUILD_PARALLEL = CFG.maxBuildParallel ?? 4   // worktree engineers are heavy (full checkout)
const MAX_PARALLEL = CFG.maxParallel ?? 6              // read-only reviewers/verifiers

const ck = (opArgs) => CK ? `node "${CK}" ${opArgs} || true` : `true`
const register = []   // verified open findings — the return value
const gateFail = (phase, why) => { register.push({ phase, kind: 'gate', why }); log(`GATE FAILED [${phase}]: ${why}`) }

// ── transient-failure retry (chiefly API rate-limit storms) ─────────────────────
// Under a rate-limit storm, whole waves of agents die at the door (agent() returns null) or mid-flight
// (throws). Those are NOT real build failures — retrying with fixed backoff (no Date/Math.random: keeps
// resume deterministic) stops a storm being mis-recorded as blocked tasks.
const RETRY_DELAYS = [3000, 10000, 30000]    // ms; 3 retries ⇒ up to 4 attempts
const isRateLimit = (e) => /rate.?limit|429|overloaded|529|too many requests|quota/i.test(String((e && (e.message || e)) || ''))
const sleep = (ms) => (typeof setTimeout === 'function' ? new Promise(r => setTimeout(r, ms)) : Promise.resolve())
async function withRetry(fn, label) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fn()
      if (r != null) return r
    } catch (e) { if (!isRateLimit(e)) throw e }
    if (attempt >= RETRY_DELAYS.length) return null
    log(`${label || 'agent'} came back empty (attempt ${attempt + 1}/${RETRY_DELAYS.length + 1}) — likely rate-limited; backing off ${RETRY_DELAYS[attempt] / 1000}s`)
    await sleep(RETRY_DELAYS[attempt])
  }
}
const rAgent = (prompt, opts) => withRetry(() => agent(prompt, opts), opts && opts.label)

// ── concurrency gate with slot-handoff (bounds simultaneity; retries inside the slot,
//    so backoff naturally relieves pressure while a storm clears) ──────────────────
function makeGate(limit) {
  let inFlight = 0
  const queue = []
  return async function gate(fn, label) {
    if (inFlight >= limit) await new Promise(resolve => queue.push(resolve))
    else inFlight++
    try { return await withRetry(fn, label) }
    finally {
      const next = queue.shift()
      if (next) next()          // hand the slot straight to the next waiter
      else inFlight--
    }
  }
}
const buildGate = makeGate(MAX_BUILD_PARALLEL)   // heavy worktree engineers
const agentGate = makeGate(MAX_PARALLEL)         // read-only reviewers/verifiers

// ── merge lock — a promise-chain mutex. Builds run in parallel, but every task's integrate
//    merges the SAME working branch; concurrent merges race the git index. Serialize merges
//    one-at-a-time while builds/reviews stay parallel. ─────────────────────────────
function makeLock() {
  let tail = Promise.resolve()
  return (fn) => {
    const run = tail.then(fn, fn)
    tail = run.then(() => {}, () => {})
    return run
  }
}
const mergeLock = makeLock()

async function mapAll(items, fn) {           // full-parallel map (per-item caps come from the gates)
  return Promise.all(items.map((it, i) => fn(it, i)))
}

// ── Preflight ─────────────────────────────────────────────────────────────────────
phase('Preflight')
const pre = await rAgent(
  `Preflight for an autonomous build in ${ROOT} on branch ${BRANCH}.
   1. Structural gate: ${CFG.planValidator ? `run \`node "${CFG.planValidator}" ${PLAN_PATH} --json\` — its violations are disqualifying (deterministic DAG judge)` : `read ${PLAN_PATH} (JSON) and validate: tasks[] each with id, title, writeScope[], validate, acceptance; layers[][] is a topological order respecting dependsOn (no cycle, nothing before its dependency); intra-layer writeScope disjoint`}.
   2. Run: git -C ${ROOT} rev-parse --is-inside-work-tree ; git -C ${ROOT} status --porcelain
   3. Read the checkpoint ${STATUS}${CK ? ` via: node "${CK}" get ${STATUS} and node "${CK}" resume ${STATUS}` : ''} — collect: units already done (doneUnits), phases already done (donePhases: keys in the checkpoint's phases map whose status is "done"), and the persisted openItems array (register entries from completed phases).
   ${Object.values(DELEGATE).includes('codex') ? '4. The user delegated role(s) to Codex — probe availability: `command -v codex` (or a codex subagent type). Report codexAvailable: true/false.' : ''}
   Return JSON: { ok, plan: {tasks, layers}, doneUnits: [ids], donePhases: [keys], openItems: [objects], codexAvailable: bool, problems: [strings] }. ok=false if the plan is malformed/cyclic/mis-ordered, the tree is not git, or the baseline has unexpected uncommitted changes (anything beyond .ulpi/**).`,
  { label: 'preflight', schema: { type: 'object', required: ['ok'], properties: {
      ok: { type: 'boolean' }, plan: { type: 'object' }, doneUnits: { type: 'array', items: { type: 'string' } },
      donePhases: { type: 'array', items: { type: 'string' } }, openItems: { type: 'array', items: { type: 'object' } },
      codexAvailable: { type: 'boolean' },
      problems: { type: 'array', items: { type: 'string' } } } } })
if (!pre?.ok) {
  gateFail('preflight', (pre?.problems || ['preflight agent died']).join('; '))
  await agent(`Run: ${ck(`finalize ${STATUS} aborted --result "preflight failed"`)}`, { label: 'status:abort' }).catch(() => null)
  return { converged: false, aborted: true, register }
}
const PLAN = pre.plan, DONE = new Set(pre.doneUnits || [])
const taskById = Object.fromEntries((PLAN.tasks || []).map(t => [t.id, t]))

// ── ANY-POINT RESUME (D15): phases recorded done are SKIPPED; their register entries are
//    rebuilt from the durably-persisted openItems, so the returned register is identical
//    whether the run was interrupted or not. ──
const DONE_PHASES = new Set(pre.donePhases || [])
register.push(...(pre.openItems || []).filter(it => it && DONE_PHASES.has(it.phase)))
if (DONE_PHASES.size) log(`resume: skipping done phase(s) [${[...DONE_PHASES].join(', ')}], ${register.length} register item(s) rebuilt from checkpoint`)

// D14: degrade codex roles to native when the integration is absent — recorded, never silent.
if (Object.values(DELEGATE).includes('codex') && pre.codexAvailable === false) {
  for (const role of Object.keys(DELEGATE)) if (DELEGATE[role] === 'codex') {
    DELEGATE[role] = 'native'
    register.push({ phase: 'preflight', kind: 'delegation_degraded', why: `role '${role}' was delegated to codex but no Codex integration is available — ran natively` })
  }
}

// persist a phase's completion + its register contributions the moment it ends (crash-safe resume).
// The status agent composes the shell quoting itself — non-fatal, no gate, no retry.
async function persistPhase(key, items, phaseTitle) {
  const cmds = `node "${CK}" phase ${STATUS} ${key} done || true` + (items.length ? ` ; then persist these register items with: node "${CK}" item ${STATUS} --json '<compose the JSON array from the ITEMS below, single-quoted safely>' || true` : '')
  if (!CK) return
  await agent(`Run (non-fatal status writes): ${cmds}${items.length ? `\nITEMS: ${JSON.stringify(items).slice(0, 3000)}` : ''}`,
    { label: `status:${key}:done`, phase: phaseTitle }).catch(() => null)
}

// ── Build: walk the DAG, barrier between layers ──────────────────────────────────
phase('Build')
await agent(`Run: ${ck(`phase ${STATUS} build running`)}`, { label: 'status:build', phase: 'Build' }).catch(() => null)
const buildOut = []
for (const [li, layer] of (PLAN.layers || []).entries()) {
  const todo = layer.filter(id => !DONE.has(id))
  log(`layer ${li + 1}/${PLAN.layers.length}: ${todo.length} task(s) to build, ${layer.length - todo.length} skipped (done)`)
  const results = await mapAll(todo, async (id) => {
    const t = taskById[id]
    if (!t) return { id, status: 'blocked', why: 'task missing from plan' }
    if ((t.dependsOn || []).some(d => !DONE.has(d)))
      return { id, status: 'dep_blocked', why: `dependency not integrated` }
    // engineer (isolated worktree, test-first, write-scope-bound) — heavy: buildGate + retry.
    // The status write rides on the engineer itself (S1): no dedicated status agents per task.
    const eng = await buildGate(() => agent(
      `FIRST (non-fatal): run ${ck(`unit ${STATUS} ${id} in_progress`)}
       You are the engineer for ONE task of an approved plan. Repo: ${ROOT}, base branch: ${BRANCH}.
       TASK ${id}: ${t.title}. Acceptance: ${JSON.stringify(t.acceptance || t.acceptanceCriteria || [])}.
       WRITE SCOPE (only these paths): ${JSON.stringify(t.writeScope || [])}. Slice validate: ${t.validate}.
       Method (non-negotiable): create worktree+branch task/${id}; write a FAILING test for the behavior first (RED), implement minimally (GREEN), refactor with tests green; stay inside the write scope; run the slice validate. NEVER git add -A (explicit paths only), never skip/weaken a test to pass.${codexBrief('build')}
       Return JSON: { built: bool, validatePassed: bool, files: [paths], notes: string, escalate: string|null } (escalate = a decision a user must make; set built=false then).`,
      { label: `eng:${id}`, phase: 'Build', isolation: 'worktree',
        schema: { type: 'object', required: ['built', 'validatePassed'], properties: {
          built: { type: 'boolean' }, validatePassed: { type: 'boolean' },
          files: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' },
          escalate: { type: ['string', 'null'] } } } }), `eng:${id}`)
    if (!eng?.built || eng?.escalate) {
      const why = eng?.escalate || eng?.notes || 'engineer failed (or died after retries)'
      await agent(`Run: ${ck(`unit ${STATUS} ${id} blocked --note "${why.slice(0, 120).replace(/"/g, '')}"`)}`, { label: `status:${id}`, phase: 'Build' }).catch(() => null)
      return { id, status: 'blocked', why }
    }
    // integrate — SERIALIZED by the merge lock: many tasks build in parallel but all merge the same
    // branch; concurrent merges race the git index. Merge-only, prune the worktree as it lands.
    const integ = await mergeLock(() => rAgent(
      `Integrate task ${id}: in ${ROOT}, git merge --no-ff task/${id} onto ${BRANCH}; then remove the task worktree (git worktree list → remove the task/${id} one) and delete branch task/${id}. Merge-only: do NOT run the whole-workspace validate. Return JSON {merged: bool, conflict: string|null}.`,
      { label: `integrate:${id}`, phase: 'Build',
        schema: { type: 'object', required: ['merged'], properties: { merged: { type: 'boolean' }, conflict: { type: ['string', 'null'] } } } }))
    if (!integ?.merged) {
      await agent(`Run: ${ck(`unit ${STATUS} ${id} blocked --note "merge conflict"`)}`, { label: `status:${id}`, phase: 'Build' }).catch(() => null)
      return { id, status: 'blocked', why: `integration failed: ${integ?.conflict || 'unknown'}` }
    }
    // slice-scoped review + bounded fix loop (read-only reviewers go through agentGate)
    let verdict = { pass: true, findings: [] }
    for (let attempt = 0; attempt <= MAX_FIX; attempt++) {
      verdict = await agentGate(() => agent(
        `Slice-scoped review of task ${id} on ${BRANCH} in ${ROOT}. Judge ONLY this task's own diff (write scope ${JSON.stringify(t.writeScope || [])}) against ITS acceptance criteria ${JSON.stringify(t.acceptance || [])}. A whole-codebase gap a LATER task owns is an OBSERVATION, never a block here. Run the slice validate: ${t.validate}.${codexBrief('review')} Return JSON { pass: bool, findings: [{file,line,issue,inScope:bool}] } — pass=false only for in-scope defects or a red slice validate.`,
        { label: `review:${id}`, phase: 'Build',
          schema: { type: 'object', required: ['pass'], properties: { pass: { type: 'boolean' },
            findings: { type: 'array', items: { type: 'object' } } } } }), `review:${id}`)
      if (verdict?.pass || attempt === MAX_FIX) break
      const inScope = (verdict?.findings || []).filter(f => f.inScope !== false)
      if (!inScope.length) break
      await buildGate(() => agent(
        `Fix loop for task ${id} (attempt ${attempt + 1}/${MAX_FIX}): apply the MINIMAL fixes for these in-scope findings on ${BRANCH} in ${ROOT}, staying inside ${JSON.stringify(t.writeScope || [])}, then re-run ${t.validate}. Findings: ${JSON.stringify(inScope).slice(0, 2000)}. Commit only this task's files.`,
        { label: `fix:${id}`, phase: 'Build' }), `fix:${id}`)
    }
    const done = verdict?.pass === true
    await agent(`Run: ${ck(`unit ${STATUS} ${id} ${done ? 'done' : 'blocked'}${done ? '' : ' --note "review blocked after fix loop"'}`)}`, { label: `status:${id}`, phase: 'Build' }).catch(() => null)
    if (done) DONE.add(id)
    return { id, status: done ? 'done' : 'blocked', why: done ? '' : 'review blocked after bounded fix loop' }
  })
  buildOut.push(...results.filter(Boolean))
}
const blocked = buildOut.filter(b => b.status !== 'done')
const blockedItems = blocked.map(b => ({ phase: 'build', kind: b.status, task: b.id, why: b.why }))
register.push(...blockedItems)
if (blocked.length) log(`build: ${blocked.length} task(s) not done — continuing to gates, register carries them (fail closed)`)
await persistPhase('build', blockedItems, 'Build')

// ── Optional + verify phases (each fail-closed: a phase that died is a gate failure) ──
async function phaseAgent(title, enabled, prompt, schema) {
  phase(title)
  const key = title.toLowerCase().replace(/\s+/g, '_')
  if (DONE_PHASES.has(key)) { log(`${title}: already done (checkpoint) — skipped, register rebuilt from openItems`); return { skippedDone: true, ok: true } }
  if (!enabled) { log(`${title}: skipped by config (recorded, not counted clean)`); return { skipped: true } }
  const out = await rAgent(`FIRST (non-fatal): run ${ck(`phase ${STATUS} ${key} running`)}\n` + prompt, { label: title.toLowerCase(), phase: title, schema })
  if (!out) gateFail(title.toLowerCase(), `${title} agent died — a gate that did not run is NOT clean`)
  return out || { died: true }
}

const RES_SCHEMA = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' },
  summary: { type: 'string' }, findings: { type: 'array', items: { type: 'object' } } } }

const simp = await phaseAgent('Simplify', OPT.simplify && !blocked.length,
  `Run the auto-simplify contract over the diff of ${BRANCH} vs its base in ${ROOT}: find duplication/dead code/over-abstraction in the CHANGED code only; apply the smallest clarifying edits ONE at a time; after each, prove behavior preserved (relevant tests green + no observable semantic change) or REVERT it. Never remove code whose purpose you haven't established. Return { ok, summary, findings: [reverted-or-flagged items] }.`, RES_SCHEMA)
const simpItems = (simp?.findings || []).map(f => ({ phase: 'simplify', ...f }))
register.push(...simpItems)
if (!simp?.skippedDone) await persistPhase('simplify', simpItems, 'Simplify')

const test = await phaseAgent('Test', true,
  `Run the auto-test contract over the diff of ${BRANCH} in ${ROOT}: find untested behaviors in the changed code; write ONE meaningful test per behavior (state-based, spec-named); MUTATION-CHECK each (break the target — the test must fail; restore — must pass; reject tautologies); loop until the scoped suite is green, max 6 iterations, never skipping/weakening a test. Return { ok: suiteGreen && allMutationChecked, summary, findings: [gaps left, blocked units] }.`, RES_SCHEMA)
if (test && !test.skipped && !test.skippedDone && !test.ok) gateFail('test', test?.summary || 'suite not green / tests not mutation-verified')
const testItems = (test?.findings || []).map(f => ({ phase: 'test', ...f }))
register.push(...testItems)
if (!test?.skippedDone) await persistPhase('test', testItems, 'Test')

phase('Review')
const DIMENSIONS = ['correctness', 'security', 'test adequacy', 'API/contract compatibility']
const reviewDone = DONE_PHASES.has('review')
if (reviewDone) log('Review: already done (checkpoint) — skipped, confirmed findings rebuilt from openItems')
const raw = reviewDone ? [] : (await mapAll(DIMENSIONS, (dim) => agentGate(() => agent(
  `Review the diff of ${BRANCH} vs its base in ${ROOT} through the ${dim.toUpperCase()} lens only. Return JSON { findings: [{file, line, issue, severity: "blocker"|"concern"|"nit", scenario}] } — concrete failure scenarios only, no style opinions.`,
  { label: `review:${dim}`, phase: 'Review', schema: { type: 'object', required: ['findings'],
    properties: { findings: { type: 'array', items: { type: 'object' } } } } }), `review:${dim}`))).filter(Boolean)
if (!reviewDone && raw.length < DIMENSIONS.length) gateFail('review', `${DIMENSIONS.length - raw.length} review dimension(s) did not run`)
const sevRank = { blocker: 0, concern: 1, nit: 2 }
const byKey = {}
for (const f of raw.flatMap(r => r.findings || [])) {
  const k = `${f.file}:${f.line}:${(f.issue || '').slice(0, 40)}`
  if (!byKey[k] || (sevRank[f.severity] ?? 9) < (sevRank[byKey[k].severity] ?? 9)) byKey[k] = f   // highest severity wins
}
const dedup = Object.values(byKey)
const confirmed = (await mapAll(dedup, async (f) => {
  const votes = (await parallel([0, 1, 2].map(i => () => agentGate(() => agent(
    `Adversarially verify (skeptic #${i + 1}): try to REFUTE this finding against the ACTUAL code in ${ROOT}: ${JSON.stringify(f).slice(0, 800)}. Build the concrete input/path. Default refuted=true if you cannot positively confirm it.${codexBrief('verify')} Return { refuted: bool, evidence: string }.`,
    { label: `verify:${(f.file || '?').split('/').pop()}`, phase: 'Review',
      schema: { type: 'object', required: ['refuted'], properties: { refuted: { type: 'boolean' }, evidence: { type: 'string' } } } }))))).filter(Boolean)
  const survives = votes.length >= 2 && votes.filter(v => !v.refuted).length > votes.filter(v => v.refuted).length
  return survives ? f : null
})).filter(Boolean)
const reviewItems = confirmed.map(f => ({ phase: 'review', kind: 'finding', ...f }))
register.push(...reviewItems)
if (!reviewDone) { log(`review: ${dedup.length} raw → ${confirmed.length} confirmed (rejections filtered by adversarial panel)`); await persistPhase('review', reviewItems, 'Review') }

const perf = await phaseAgent('Performance', OPT.performance,
  `Run the auto-performance contract on the changed hot paths of ${BRANCH} in ${ROOT}: establish a reproducible baseline benchmark FIRST, profile to real hotspots, optimize one at a time, keep a change ONLY if re-benchmark shows a real (beyond-variance) win AND the tests stay green — otherwise revert. Return { ok, summary, findings: [unproven/reverted claims] }.`, RES_SCHEMA)
const perfItems = (perf?.findings || []).map(f => ({ phase: 'performance', ...f }))
register.push(...perfItems)
if (!perf?.skippedDone) await persistPhase('performance', perfItems, 'Performance')

const reviewBlockers = register.filter(r => r.phase === 'review' && r.severity === 'blocker').length
const ship = await phaseAgent('Ship prep', OPT.shipPrep && reviewBlockers === 0,
  `Run the auto-ship PREP contract (NO irreversible step — no push --force, no deploy, no publish) for ${BRANCH} in ${ROOT}: audit the pre-launch gates (final validate readiness, docs for public changes, rollback path), draft the changelog FROM the actual commits, and prepare (do not open) the PR body with gate results. Return { ok, summary, findings: [gate blockers] }.`, RES_SCHEMA)
if (ship && !ship.skipped && !ship.skippedDone && !ship.ok) gateFail('ship_prep', ship?.summary || 'pre-launch gates not clean')
const shipItems = (ship?.findings || []).map(f => ({ phase: 'ship_prep', ...f }))
register.push(...shipItems)
if (!ship?.skippedDone) await persistPhase('ship_prep', shipItems, 'Ship prep')

// ── Finalize: the load-bearing end-state gate ─────────────────────────────────────
phase('Finalize')
const fin = await rAgent(
  `In ${ROOT} on ${BRANCH}, run the whole-workspace validate ONCE: ${VALIDATE}
   Report honestly. Return JSON { passed: bool, output: string (last 30 lines) }.`,
  { label: 'final-validate', phase: 'Finalize',
    schema: { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' }, output: { type: 'string' } } } })
if (!fin?.passed) gateFail('final-validate', `workspace validate is RED or did not run — the end-state truth gate blocks (${(fin?.output || '').slice(0, 300)})`)
const converged = register.length === 0
await agent(`Run: ${ck(`finalize ${STATUS} ${converged ? 'done' : 'needs_attention'} --result "${converged ? 'pipeline clean' : register.length + ' open item(s)'}"`)}`, { label: 'status:final', phase: 'Finalize' }).catch(() => null)

return {
  converged,                               // true ONLY if every gate ran clean and the register is empty
  build: buildOut, blockedTaskCount: blocked.length,
  reviewConfirmed: confirmed.length,
  phasesSkipped: Object.entries(OPT).filter(([, v]) => !v).map(([k]) => k),
  workspaceValidatePassed: fin?.passed === true,
  register,                                // the verified open findings — the USER decides the fix round
  statusFile: STATUS,
}
