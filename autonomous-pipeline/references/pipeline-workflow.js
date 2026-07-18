// pipeline-workflow.js — the LEGACY, CLAUDE-ONLY compatibility backend for `autonomous-pipeline`.
//
// NOT the canonical runtime. This template runs ONLY under the Claude Code `Workflow` tool; the
// Codex adapter CANNOT select it (a Workflow needs the Claude Code runtime, which Codex does not
// provide). The CANONICAL, cross-host runtime is the deterministic zero-dep coordinator CLI —
// `autonomous-pipeline/scripts/pipeline.mjs` (approve|start|resume|status|authorize) backed by
// `scripts/lib/` — where Git, the checkpoint, the phase gates, and convergence are owned by the
// library, not by any model prompt. Prefer that CLI; this Workflow exists only for Claude-only
// installs where launching the CLI is not an option. (Note: the D14 per-role `delegate` option
// below routes an individual AGENT BRIEF to a codex subagent — that is unrelated to the canonical
// Codex RUNTIME and does not make this Workflow selectable by the Codex adapter.)
//
// The SKILL does everything human-facing BEFORE launching this: intake + config questions,
// auto-spec, auto-plan, and THE SINGLE PLAN APPROVAL (a Workflow cannot ask the user mid-run).
// This script executes the approved, unattended stretch — build → simplify → test → review →
// performance → ship-prep — with FAIL-CLOSED gates between phases, a durable checkpoint the
// skill created beforehand, and a verified findings register as the return value. ONE forward pass
// through the phases; the returned register then feeds the skill's BOUNDED auto-fix converge-loop
// (Phase 2) — it is NEVER presented to the user as a fix-or-not choice. Unlike the canonical coordinator
// (which HARD-STOPS downstream on a blocked required gate), this legacy backend collects findings across
// the forward pass rather than hard-stopping — see references/pipeline-state.md.
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
// Every status write is NON-FATAL (`|| true`). Git is the durable integration log: merge commits carry
// `Task-Id` trailers, and resume reconciles trailers reachable from workingBranch into checkpoint
// doneUnits before the build starts. The journal/session cache is never required.

export const meta = {
  name: 'autonomous-pipeline',
  description: 'LEGACY Claude-only Workflow backend (NOT the canonical runtime; the Codex adapter cannot select it) — approved-plan build → simplify → test → review → performance → ship-prep as one forward pass with fail-closed gates, durable checkpoint, verified findings register',
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
// D21: opportunistic specialist routing (mirrors ship-playbook's proven pattern). The PLAN (auto-plan,
// an LLM) matched each task to the best-fit INSTALLED agent/skill by READING their descriptions (names
// are arbitrary), assigning an `agent` + `reviewer` (a specialist, or 'general-purpose' when none fits)
// and an optional domain `skill`. We do NOT hardcode a registry (it goes stale and wrongly downgrades
// agents that exist elsewhere): honor availableAgents when the skill supplies it, else attempt the
// assignment and let spawnSpecialist catch a runtime "not found", record it, and (when
// allowGeneralFallback, the default) retry on general-purpose. missingAgents surfaces in the return.
const AVAILABLE_AGENTS = Array.isArray(CFG.availableAgents) ? CFG.availableAgents : null
const ALLOW_GENERAL_FALLBACK = CFG.allowGeneralFallback !== false
const usedSpecialists = new Set(), missingAgents = new Set()
function resolveAgent(type) {
  if (typeof type !== 'string' || !type || type === 'general-purpose') return 'general-purpose'
  if (AVAILABLE_AGENTS && !AVAILABLE_AGENTS.includes(type)) { missingAgents.add(type); return ALLOW_GENERAL_FALLBACK ? 'general-purpose' : type }
  usedSpecialists.add(type); return type
}
async function spawnSpecialist(brief, opts) {
  try { return await agent(brief, opts) }
  catch (e) {
    const notFound = opts.agentType && opts.agentType !== 'general-purpose' && /agent type .*not found|not a valid agent|unknown agent|no such agent|available agents:/i.test(String((e && e.message) || e))
    if (notFound) {
      missingAgents.add(opts.agentType); usedSpecialists.delete(opts.agentType)
      if (ALLOW_GENERAL_FALLBACK) { log(`agentType "${opts.agentType}" not available here — using general-purpose`); return await agent(brief, { ...opts, agentType: 'general-purpose' }) }
    }
    throw e
  }
}
const skillBrief = (t, engType) => {
  const parts = []
  if (t.skill) parts.push(`Invoke the /${t.skill} skill FIRST for domain-correct patterns and conventions, then implement to its guidance (theme or extend it; do not redesign what it prescribes).`)
  if (engType === 'general-purpose' && t.agent && t.agent !== 'general-purpose') parts.push(`(The assigned specialist '${t.agent}' is not available here — you are general-purpose standing in; flag anything that needs domain expertise.)`)
  return parts.length ? `\n       ${parts.join(' ')}` : ''
}
const MAX_FIX = CFG.maxFix ?? 3
const MAX_BUILD_PARALLEL = CFG.maxBuildParallel ?? 4   // worktree engineers are heavy (full checkout)
const MAX_PARALLEL = CFG.maxParallel ?? 6              // read-only reviewers/verifiers
// ── PARALLELISM ↔ ultracode: these caps are >1 and the fan-out below (mapAll / buildGate / agentGate)
//    awaits all its promises, so concurrency is REAL only when the Claude Code session runs at the
//    `ultracode` effort level (its multi-agent orchestration mode). With ultracode off the SAME code path
//    executes serially through the SAME gates, checkpoints and register — identical outcome, only slower
//    wall-clock. This backend cannot prompt the user; the "enable ultracode" nudge lives in the SKILL's
//    Phase 0 intake, never here.

// ── whole-run budget (SKILL rule #5: "BUDGET THE WHOLE RUN") — the Workflow `budget` global is the
//    turn's token target and a HARD ceiling. Stop-and-report at the next phase boundary once the run
//    dips below the floor, rather than paying for an overshoot. Null total = no target set → never fires.
const BUDGET_FLOOR = CFG.budgetFloor ?? 60_000
const overBudget = () => !!(typeof budget !== 'undefined' && budget?.total && budget.remaining() < BUDGET_FLOOR)
const phaseGateItems = new Map()
const gateFail = (phase, why, kind = 'gate') => {
  const item = { phase, kind, why, actionable: true }
  register.push(item)
  phaseGateItems.set(phase, [...(phaseGateItems.get(phase) || []), item])
  log(`GATE FAILED [${phase}]: ${why}`)
  return item
}
const budgetStop = (where) => {
  gateFail(where, `pipeline token budget floor (${BUDGET_FLOOR}) reached — stopped before ${where}; remaining work is OPEN, not done (fail closed)`, 'budget')
  log(`BUDGET STOP before ${where}: ~${(typeof budget !== 'undefined' && budget?.remaining?.()) || '?'} tokens left`)
}

const ck = (opArgs) => CK ? `node "${CK}" ${opArgs} || true` : `true`
const register = []       // actionable open findings only — the fix loop + convergence input
const informational = []  // pure observations / explicit approved scope drops — reported, never hidden

// ── transient-failure retry (rate-limit storms AND network blips) ────────────────
// Two failure shapes are NOT real build failures: (a) an agent dies at the door / after the runtime's
// own retries (agent() returns null) — always retried here regardless of cause; (b) an agent THROWS a
// transient infra error mid-flight — retried only when isTransient matches (a rate-limit storm OR a
// dropped connection: ECONNRESET/ETIMEDOUT/"fetch failed"/"socket hang up"/5xx gateway). A genuine
// programming error still throws through. Fixed backoff (no Date/Math.random: keeps resume deterministic)
// stops a storm or a Wi-Fi blip being mis-recorded as blocked tasks; if retries exhaust, the unit is
// recorded (not silently dropped) and the checkpoint makes the whole run resumable when the link returns.
const RETRY_DELAYS = [3000, 10000, 30000, 60000, 120000, 300000, 300000, 300000, 300000, 300000]  // ms; 10 retries ⇒ up to 11 attempts; escalates then caps at 5 min (~28 min total) to ride out a real outage
const isTransient = (e) => /rate.?limit|429|overloaded|529|too many requests|quota|502|503|504|bad gateway|gateway time|service unavailable|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed|network error|network|connection (?:reset|closed|error|refused|aborted)|timed? ?out|premature close|terminated/i.test(String((e && (e.message || e)) || ''))
const HAS_TIMER = typeof setTimeout === 'function'   // sandbox may not expose timers: retries still happen, just without backoff
const sleep = (ms) => (HAS_TIMER ? new Promise(r => setTimeout(r, ms)) : Promise.resolve())
async function withRetry(fn, label) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fn()
      if (r != null) return r
    } catch (e) { if (!isTransient(e)) throw e }
    if (attempt >= RETRY_DELAYS.length) return null
    log(`${label || 'agent'} came back empty (attempt ${attempt + 1}/${RETRY_DELAYS.length + 1}) — likely a rate-limit or network blip; ${HAS_TIMER ? `backing off ${RETRY_DELAYS[attempt] / 1000}s` : 'no timer in sandbox: retrying immediately'}`)
    await sleep(RETRY_DELAYS[attempt])
  }
}
const rAgent = (prompt, opts) => withRetry(() => agent(prompt, opts), opts && opts.label)

// ── concurrency gate with slot-handoff (bounds simultaneity; retries inside the slot,
//    so backoff naturally relieves pressure while a storm clears) ──────────────────
function makeGate(limit) {
  limit = Math.max(1, Number(limit) || 1)   // a 0/negative/NaN cap must never deadlock the run
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

// ── ROOT write lock — a promise-chain mutex serializing EVERY operation that mutates the shared
//    working tree: each task's integrate (merges the SAME branch — concurrent merges race the git
//    index) AND each task's post-merge fix-loop commit. Without this second use, two same-layer
//    tasks past their (serialized) merges could run their fix loops — editing + committing in the
//    shared ROOT — at once, violating auto-build rule 7 ("never two agents writing the working tree
//    at once") and racing .git/index.lock. Builds (isolated worktrees) + read-only reviews stay
//    parallel; only ROOT mutations funnel through here. ─────────────────────────────
function makeLock() {
  let tail = Promise.resolve()
  return (fn) => {
    const run = tail.then(fn, fn)
    tail = run.then(() => {}, () => {})
    return run
  }
}
const rootLock = makeLock()

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
   4. DURABLE RESUME — ALWAYS do this even when checkpointCli is unset: run \`git -C ${ROOT} log ${BRANCH} --format=%B\`. Parse exact \`Task-Id: <id>\` trailer lines from commits REACHABLE from ${BRANCH}; intersect them with task ids in the approved plan; UNION those ids into doneUnits. This recovers an integration whose checkpoint write was lost. A commit reachable only from task/<id> (not ${BRANCH}) is NOT done and must be re-run.
   ${Object.values(DELEGATE).includes('codex') ? '5. The user delegated role(s) to Codex — probe availability: `command -v codex` (or a codex subagent type). Report codexAvailable: true/false.' : ''}
   Return JSON: { ok, plan: {selectedScope, scopeDrops, tasks, layers}, doneUnits: [ids], donePhases: [keys], openItems: [objects], codexAvailable: bool, problems: [strings] }. Preserve every task's scopeItems. ok=false if selectedScope is absent/under-covered, a scope drop lacks its own explicit user acknowledgement, the plan is malformed/cyclic/mis-ordered, the tree is not git, or the baseline has unexpected uncommitted changes (anything beyond .ulpi/**).`,
  { label: 'preflight', schema: { type: 'object', required: ['ok'], properties: {
      ok: { type: 'boolean' }, plan: { type: 'object' }, doneUnits: { type: 'array', items: { type: 'string' } },
      donePhases: { type: 'array', items: { type: 'string' } }, openItems: { type: 'array', items: { type: 'object' } },
      codexAvailable: { type: 'boolean' },
      problems: { type: 'array', items: { type: 'string' } } } } })
if (!pre?.ok) {
  gateFail('preflight', (pre?.problems || ['preflight agent died']).join('; '))
  if (CK) await persistPhase('preflight', [], 'Preflight', 'blocked')
  if (CK) await agent(`Run: ${ck(`finalize ${STATUS} aborted --result "preflight failed"`)}`, { label: 'status:abort' }).catch(() => null)
  return { converged: false, workflowConverged: false, aborted: true, closeoutRequired: ['auto_learn'], register }
}
const PLAN = pre.plan
if (!Array.isArray(PLAN?.tasks) || !PLAN.tasks.length || !Array.isArray(PLAN?.layers) || !PLAN.layers.length) {
  gateFail('preflight', 'preflight returned ok but no usable plan {tasks[], layers[][]} — refusing to build on nothing')
  if (CK) await persistPhase('preflight', [], 'Preflight', 'blocked')
  if (CK) await agent(`Run: ${ck(`finalize ${STATUS} aborted --result "no usable plan"`)}`, { label: 'status:abort' }).catch(() => null)
  return { converged: false, workflowConverged: false, aborted: true, closeoutRequired: ['auto_learn'], register }
}
for (const t of PLAN.tasks) t.acceptance = t.acceptance ?? t.acceptanceCriteria ?? []   // normalize once
const DONE = new Set(pre.doneUnits || [])
const taskById = Object.fromEntries((PLAN.tasks || []).map(t => [t.id, t]))
const selectedScope = Array.isArray(PLAN.selectedScope) ? PLAN.selectedScope : []
const scopeDrops = Array.isArray(PLAN.scopeDrops) ? PLAN.scopeDrops : []
const selectedScopeIds = new Set(selectedScope.map(s => s && s.id).filter(Boolean))
const approvedDropIds = new Set(scopeDrops
  .filter(d => d && typeof d.reason === 'string' && d.reason.trim() && d.acknowledgedByUser === true
    && typeof d.acknowledgement === 'string' && d.acknowledgement.trim())
  .map(d => d.scopeId))

// Defense in depth for the model-mediated preflight. The deterministic plan validator is preferred, but
// the Workflow must also reject a truncated return object (for example, {tasks,layers} with the binding
// intake checklist silently omitted). Plan approval never implies a scope drop.
const scopeErrors = []
if (!Array.isArray(PLAN.selectedScope) || PLAN.selectedScope.length === 0) scopeErrors.push('selectedScope[] is missing or empty')
if (PLAN.scopeDrops !== undefined && !Array.isArray(PLAN.scopeDrops)) scopeErrors.push('scopeDrops must be an array')
if (selectedScopeIds.size !== selectedScope.length) scopeErrors.push('selectedScope ids are missing or duplicated')
for (const s of selectedScope) {
  if (!s || typeof s.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s.id)
      || typeof s.title !== 'string' || !s.title.trim() || typeof s.source !== 'string' || !s.source.trim()) {
    scopeErrors.push(`selectedScope item ${s?.id || '<missing>'} needs a safe id plus nonempty title/source`)
  }
}
const mappedScopeIds = new Set()
for (const t of PLAN.tasks) {
  if (!Array.isArray(t.scopeItems)) { scopeErrors.push(`task ${t.id} is missing scopeItems[]`); continue }
  const local = new Set()
  for (const id of t.scopeItems) {
    if (!selectedScopeIds.has(id)) scopeErrors.push(`task ${t.id} maps unknown selected-scope id ${id}`)
    else if (local.has(id)) scopeErrors.push(`task ${t.id} repeats selected-scope id ${id}`)
    else mappedScopeIds.add(id)
    local.add(id)
  }
}
const seenDrops = new Set()
for (const d of scopeDrops) {
  if (!d || !selectedScopeIds.has(d.scopeId)) scopeErrors.push(`scope drop references unknown id ${d?.scopeId || '<missing>'}`)
  else if (seenDrops.has(d.scopeId)) scopeErrors.push(`scope drop ${d.scopeId} is duplicated`)
  else if (typeof d.reason !== 'string' || !d.reason.trim() || d.acknowledgedByUser !== true
      || typeof d.acknowledgement !== 'string' || !d.acknowledgement.trim()) {
    scopeErrors.push(`scope drop ${d.scopeId} needs a reason and its own explicit user acknowledgement`)
  }
  if (d?.scopeId) seenDrops.add(d.scopeId)
}
for (const id of selectedScopeIds) {
  if (mappedScopeIds.has(id) && approvedDropIds.has(id)) scopeErrors.push(`selected-scope item ${id} is both mapped and dropped`)
  else if (!mappedScopeIds.has(id) && !approvedDropIds.has(id)) scopeErrors.push(`selected-scope item ${id} is UNCOVERED`)
}
if (scopeErrors.length) {
  gateFail('preflight', `binding selected-scope gate failed: ${scopeErrors.join('; ')}`)
  if (CK) await persistPhase('preflight', [], 'Preflight', 'blocked')
  if (CK) await agent(`Run: ${ck(`finalize ${STATUS} aborted --result "binding selected-scope gate failed"`)}`, { label: 'status:abort' }).catch(() => null)
  return { converged: false, workflowConverged: false, aborted: true, closeoutRequired: ['auto_learn'], register }
}

// Classify every phase finding into ONE whole-run register. Severity never changes actionability. Only a
// pure informational observation unrelated to selected scope, or an explicitly user-approved scope drop,
// may leave the actionable register. An agent cannot hide selected work by calling it info/deferred.
function recordFindings(items) {
  const open = []
  for (const raw of items || []) {
    if (!raw || typeof raw !== 'object') continue
    const scopeId = raw.scopeId || raw.selectedScopeId
    const approvedDrop = scopeId && approvedDropIds.has(scopeId)
    const pureInfo = raw.kind === 'info' || raw.kind === 'informational' || raw.disposition === 'informational'
    if (approvedDrop || (pureInfo && !selectedScopeIds.has(scopeId))) {
      informational.push({ ...raw, actionable: false, disposition: approvedDrop ? 'approved_scope_drop' : 'informational' })
      continue
    }
    open.push({ ...raw, actionable: true })
  }
  register.push(...open)
  return open
}

// ── ANY-POINT RESUME (D15): phases recorded done are SKIPPED; their register entries are
//    rebuilt from the durably-persisted openItems, so the returned register is identical
//    whether the run was interrupted or not. ──
const DONE_PHASES = new Set(pre.donePhases || [])
recordFindings((pre.openItems || []).filter(it => it && DONE_PHASES.has(it.phase)))
if (DONE_PHASES.size) log(`resume: skipping done phase(s) [${[...DONE_PHASES].join(', ')}], ${register.length} register item(s) rebuilt from checkpoint`)

// D14: degrade codex roles to native when the integration is absent — recorded, never silent.
if (Object.values(DELEGATE).includes('codex') && pre.codexAvailable === false) {
  for (const role of Object.keys(DELEGATE)) if (DELEGATE[role] === 'codex') {
    DELEGATE[role] = 'native'
    gateFail('preflight', `role '${role}' was delegated to codex but no Codex integration is available — ran natively`, 'delegation_degraded')
  }
  if (CK) await persistPhase('preflight', [], 'Preflight', 'blocked')
}

// persist a phase's completion + its register contributions the moment it ends (crash-safe resume).
// The status agent composes the shell quoting itself — non-fatal, no gate, no retry.
async function persistPhase(key, items, phaseTitle, status = 'done') {
  // NEVER record 'done' for a phase that died — a died phase persisted done is skipped forever on
  // resume. Died/failed phases record 'blocked' (re-entered on resume; their gate items recompute).
  if (!CK) return
  const allItems = [...(phaseGateItems.get(key) || []), ...items]
  const batches = []
  for (let i = 0; i < allItems.length; i += 25) batches.push(allItems.slice(i, i + 25))
  const itemCmds = batches.map((_, i) => `then persist ITEMS BATCH ${i + 1}/${batches.length} with: node "${CK}" item ${STATUS} --json '<compose that exact JSON array, single-quoted safely>' || true`).join(' ; ')
  const cmds = `node "${CK}" phase ${STATUS} ${key} ${status} || true${itemCmds ? ` ; ${itemCmds}` : ''}`
  const payload = batches.map((batch, i) => `ITEMS BATCH ${i + 1}/${batches.length} (${batch.length}): ${JSON.stringify(batch)}`).join('\n')
  await agent(`Run (non-fatal status writes; persist EVERY batch, no truncation): ${cmds}${payload ? `\n${payload}` : ''}`,
    { label: `status:${key}:${status}`, phase: phaseTitle }).catch(() => null)
}

// ── Build: walk the DAG, barrier between layers ──────────────────────────────────
phase('Build')
const buildDone = DONE_PHASES.has('build')
if (buildDone) log('Build: already done (checkpoint) — skipped entirely')
else if (CK) await agent(`Run: ${ck(`phase ${STATUS} build running`)}`, { label: 'status:build', phase: 'Build' }).catch(() => null)
const buildOut = []
for (const [li, layer] of (buildDone ? [] : PLAN.layers || []).entries()) {
  if (overBudget()) { budgetStop('build'); break }   // remaining layers' tasks stay OPEN (not in DONE → converged:false)
  const todo = layer.filter(id => !DONE.has(id))
  log(`layer ${li + 1}/${PLAN.layers.length}: ${todo.length} task(s) to build, ${layer.length - todo.length} skipped (done)`)
  const results = await mapAll(todo, async (id) => {
    const t = taskById[id]
    if (!t) return { id, status: 'blocked', why: 'task missing from plan' }
    if ((t.dependsOn || []).some(d => !DONE.has(d)))
      return { id, status: 'dep_blocked', why: `dependency not integrated` }
    // engineer (isolated worktree, test-first, write-scope-bound) — heavy: buildGate + retry.
    // The status write rides on the engineer itself (S1): no dedicated status agents per task.
    const engType = resolveAgent(t.agent)
    const eng = await buildGate(() => spawnSpecialist(
      `FIRST (non-fatal): run ${ck(`unit ${STATUS} ${id} in_progress`)}
       You are the engineer for ONE task of an approved plan. Repo: ${ROOT}, base branch: ${BRANCH}.
       TASK ${id}: ${t.title}. Acceptance: ${JSON.stringify(t.acceptance || t.acceptanceCriteria || [])}.
       WRITE SCOPE (only these paths): ${JSON.stringify(t.writeScope || [])}. Slice validate: ${t.validate}.
       Method (non-negotiable): create worktree+branch task/${id}; write a FAILING test for the behavior first (RED), implement minimally (GREEN), refactor with tests green; stay inside the write scope; run the slice validate; THEN COMMIT your work on task/${id} by explicit paths (git add <files> ; git commit) — integrate merges this branch, so uncommitted work merges NOTHING. NEVER git add -A (explicit paths only), never skip/weaken a test to pass.${skillBrief(t, engType)}${codexBrief('build')}
       Return JSON: { built: bool, validatePassed: bool, files: [paths], notes: string, escalate?: string } — set built=true ONLY after you committed; report validatePassed HONESTLY (the SLICE validate's real result — a red slice validate means built may be true but validatePassed=false, and integration will hold the task rather than merge broken code). Include escalate ONLY when a user decision is needed (set built=false then; omit it otherwise).`,
      { label: `eng:${id}`, phase: 'Build', isolation: 'worktree', agentType: engType,
        schema: { type: 'object', required: ['built', 'validatePassed'], properties: {
          built: { type: 'boolean' }, validatePassed: { type: 'boolean' },
          files: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' },
          escalate: { type: 'string' } } } }), `eng:${id}`)
    if (!eng?.built || eng?.validatePassed === false || eng?.escalate) {
      const why = eng?.escalate
        || (eng?.built && eng?.validatePassed === false ? `slice validate RED — not integrating broken code: ${(eng?.notes || 'no detail').slice(0, 90)}` : eng?.notes)
        || 'engineer failed (or died after retries)'
      if (CK) await agent(`Run: ${ck(`unit ${STATUS} ${id} blocked --note "${why.slice(0, 120).replace(/"/g, '')}"`)}`, { label: `status:${id}`, phase: 'Build' }).catch(() => null)
      return { id, status: 'blocked', why }
    }
    // integrate — SERIALIZED by the root lock: many tasks build in parallel but all merge the same
    // branch; concurrent merges race the git index. The merge commit's Task-Id trailer is the durable
    // integration record: resume scans only commits reachable from BRANCH, so a built-but-unmerged task
    // cannot be mistaken for done. Merge-only, prune the worktree only after the trailer is verified.
    const integ = await rootLock(() => rAgent(
      `Integrate task ${id} in ${ROOT} onto ${BRANCH}. Create a trailered merge commit with these explicit steps: ensure ${BRANCH} is checked out; run \`git -C ${ROOT} merge --no-ff --no-commit task/${id}\`; when that creates MERGE_HEAD and is conflict-free, run \`git -C ${ROOT} commit -m "Integrate task ${id}" -m "Task-Id: ${id}"\`. If merge instead reports already integrated, do not create an unrelated commit: accept it only if the reachable history verification below already finds the exact trailer. Verify \`git -C ${ROOT} log ${BRANCH} --format=%B\` contains the exact trailer \`Task-Id: ${id}\` in a commit reachable from ${BRANCH}. ONLY after that verification, remove the task worktree (git worktree list → remove the task/${id} one) and delete branch task/${id}. Set merged=true only when the trailered commit is reachable. Merge-only: do NOT run the whole-workspace validate. Return JSON {merged: bool, conflict?: string} (include conflict only on failure).`,
      { label: `integrate:${id}`, phase: 'Build',
        schema: { type: 'object', required: ['merged'], properties: { merged: { type: 'boolean' }, conflict: { type: 'string' } } } }))
    if (!integ?.merged) {
      if (CK) await agent(`Run: ${ck(`unit ${STATUS} ${id} blocked --note "merge conflict"`)}`, { label: `status:${id}`, phase: 'Build' }).catch(() => null)
      return { id, status: 'blocked', why: `integration failed: ${integ?.conflict || 'unknown'}` }
    }
    // slice-scoped review + bounded fix loop (read-only reviewers go through agentGate)
    let verdict = { pass: true, findings: [] }
    for (let attempt = 0; attempt <= MAX_FIX; attempt++) {
      verdict = await agentGate(() => spawnSpecialist(
        `Slice-scoped review of task ${id} on ${BRANCH} in ${ROOT}. Judge ONLY this task's own diff (write scope ${JSON.stringify(t.writeScope || [])}) against ITS acceptance criteria ${JSON.stringify(t.acceptance || [])}. A whole-codebase gap a LATER task owns is an OBSERVATION, never a block here. Run the slice validate: ${t.validate}.${codexBrief('review')} Return JSON { pass: bool, findings: [{file,line,issue,inScope:bool}] } — pass=false only for in-scope defects or a red slice validate.`,
        { label: `review:${id}`, phase: 'Build', agentType: resolveAgent(t.reviewer),
          schema: { type: 'object', required: ['pass'], properties: { pass: { type: 'boolean' },
            findings: { type: 'array', items: { type: 'object' } } } } }), `review:${id}`)
      if (verdict?.pass || attempt === MAX_FIX) break
      const inScope = (verdict?.findings || []).filter(f => f.inScope !== false)
      if (!inScope.length) break
      // ROOT-mutating: serialize through rootLock so two same-layer fix loops never write/commit the
      // shared tree at once (auto-build rule 7). withRetry keeps the transient-failure resilience the
      // gates gave; spawnSpecialist keeps the specialist→general fallback.
      await rootLock(() => withRetry(() => spawnSpecialist(
        `Fix loop for task ${id} (attempt ${attempt + 1}/${MAX_FIX}): apply the MINIMAL fixes for these in-scope findings on ${BRANCH} in ${ROOT}, staying inside ${JSON.stringify(t.writeScope || [])}, then re-run ${t.validate}. Findings: ${JSON.stringify(inScope).slice(0, 2000)}. Commit only this task's files (explicit paths, never git add -A).${skillBrief(t, engType)}`,
        { label: `fix:${id}`, phase: 'Build', agentType: engType }), `fix:${id}`))
    }
    const done = verdict?.pass === true
    if (CK) await agent(`Run: ${ck(`unit ${STATUS} ${id} ${done ? 'done' : 'blocked'}${done ? '' : ' --note "review blocked after fix loop"'}`)}`, { label: `status:${id}`, phase: 'Build' }).catch(() => null)
    if (done) DONE.add(id)
    return { id, status: done ? 'done' : 'blocked', why: done ? '' : 'review blocked after bounded fix loop' }
  })
  buildOut.push(...results.filter(Boolean))
}
const blocked = buildOut.filter(b => b.status !== 'done')
const blockedItems = blocked.map(b => ({ phase: 'build', kind: b.status, task: b.id, why: b.why }))
// A budget/early break leaves whole layers UNATTEMPTED — those tasks never enter buildOut, so `blocked`
// alone under-counts. The build phase is DONE only when EVERY planned task actually integrated; anything
// short of that (blocked tasks OR unbuilt tasks) makes it 'blocked' so a RESUME re-enters build and
// finishes the remainder. (Persisting 'done' with tasks unbuilt is the fail-open bug: resume skips build
// and the run can return converged:true with planned work silently missing.)
const allTaskIds = (PLAN.layers || []).flat()
const attemptedIds = new Set(buildOut.map(b => b.id))
const unbuiltIds = allTaskIds.filter(id => !DONE.has(id) && !attemptedIds.has(id))
const unbuiltItems = unbuiltIds.map(id => ({ phase: 'build', kind: 'unbuilt', task: id, why: 'not reached this run (budget/early stop) — resume to build it' }))
recordFindings([...blockedItems, ...unbuiltItems])
const buildComplete = allTaskIds.every(id => DONE.has(id))
if (blocked.length || unbuiltIds.length) log(`build: ${blocked.length} blocked + ${unbuiltIds.length} unbuilt of ${allTaskIds.length} — build phase stays incomplete (resume finishes it), register carries them (fail closed)`)
if (!buildDone) await persistPhase('build', [...blockedItems, ...unbuiltItems], 'Build', buildComplete ? 'done' : 'blocked')

// ── Optional + verify phases (each fail-closed: a phase that died is a gate failure) ──
async function phaseAgent(title, enabled, prompt, schema) {
  phase(title)
  const key = title.toLowerCase().replace(/\s+/g, '_')
  if (DONE_PHASES.has(key)) { log(`${title}: already done (checkpoint) — skipped, register rebuilt from openItems`); return { skippedDone: true, ok: true } }
  if (!enabled) { log(`${title}: skipped by config (recorded, not counted clean)`); return { skipped: true } }
  if (overBudget()) { budgetStop(key); return { skipped: true, budget: true } }
  const out = await rAgent(`FIRST (non-fatal): run ${ck(`phase ${STATUS} ${key} running`)}\n` + prompt, { label: title.toLowerCase(), phase: title, schema })
  if (!out) gateFail(key, `${title} agent died — a gate that did not run is NOT clean`)
  return out || { died: true }
}

const RES_SCHEMA = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' },
  summary: { type: 'string' }, findings: { type: 'array', items: { type: 'object' } } } }

const simp = await phaseAgent('Simplify', OPT.simplify && !blocked.length,
  `Run the auto-simplify contract over the diff of ${BRANCH} vs its base in ${ROOT}: find duplication/dead code/over-abstraction in the CHANGED code only; apply the smallest clarifying edits ONE at a time; after each, prove behavior preserved (relevant tests green + no observable semantic change) or REVERT it. Never remove code whose purpose you haven't established. Return { ok, summary, findings: [reverted-or-flagged items] }.`, RES_SCHEMA)
if (simp && !simp.skipped && !simp.skippedDone && !simp.died && !simp.ok) gateFail('simplify', simp?.summary || 'simplify pass did not complete cleanly (ok:false)')  // !died: phaseAgent already recorded a died gate — don't double-count
const simpItems = recordFindings((simp?.findings || []).map(f => ({ phase: 'simplify', ...f })))
if (!simp?.skippedDone && (!simp?.skipped || simp?.budget)) await persistPhase('simplify', simpItems, 'Simplify', simp?.died || simp?.budget || (simp && !simp.skipped && !simp.ok) ? 'blocked' : 'done')

const test = await phaseAgent('Test', true,
  `Run the auto-test contract over the diff of ${BRANCH} in ${ROOT}: find untested behaviors in the changed code; write ONE meaningful test per behavior (state-based, spec-named); MUTATION-CHECK each (break the target — the test must fail; restore — must pass; reject tautologies); loop until the scoped suite is green, max 6 iterations, never skipping/weakening a test. Return { ok: suiteGreen && allMutationChecked, summary, findings: [gaps left, blocked units] }.`, RES_SCHEMA)
if (test && !test.skipped && !test.skippedDone && !test.died && !test.ok) gateFail('test', test?.summary || 'suite not green / tests not mutation-verified')  // !died: phaseAgent already recorded a died gate — don't double-count
const testItems = recordFindings((test?.findings || []).map(f => ({ phase: 'test', ...f })))
// Do NOT persist when the phase was budget-skipped (test?.skipped) — like its three sibling phases.
// A budget-skipped Test never ran; persisting it 'done' converts the fail-closed gate to fail-open on
// resume (the gate is skipped and never runs). Budget-skip leaves it 'pending' so resume re-runs it.
if (!test?.skippedDone && (!test?.skipped || test?.budget)) await persistPhase('test', testItems, 'Test', test?.died || test?.budget || !test?.ok ? 'blocked' : 'done')

phase('Review')
const DIMENSIONS = ['correctness', 'security', 'test adequacy', 'API/contract compatibility']
const reviewDone = DONE_PHASES.has('review')
const reviewBudgetSkip = !reviewDone && overBudget()
if (reviewDone) log('Review: already done (checkpoint) — skipped, confirmed findings rebuilt from openItems')
else if (reviewBudgetSkip) budgetStop('review')
// Review is an INLINE phase (not via phaseAgent) — write its 'running' status itself, or currentPhase
// stays stuck on 'test' and a status query mid-review misreports the phase.
else if (CK) await agent(`Run: ${ck(`phase ${STATUS} review running`)}`, { label: 'status:review', phase: 'Review' }).catch(() => null)
const raw = (reviewDone || reviewBudgetSkip) ? [] : (await mapAll(DIMENSIONS, (dim) => agentGate(() => agent(
  `Review the diff of ${BRANCH} vs its base in ${ROOT} through the ${dim.toUpperCase()} lens only.${codexBrief('review')} Return JSON { findings: [{file, line, issue, severity: "blocker"|"concern"|"nit", scenario}] } — concrete failure scenarios only, no style opinions.`,
  { label: `review:${dim}`, phase: 'Review', schema: { type: 'object', required: ['findings'],
    properties: { findings: { type: 'array', items: { type: 'object' } } } } }), `review:${dim}`))).filter(Boolean)
if (!reviewDone && !reviewBudgetSkip && raw.length < DIMENSIONS.length) gateFail('review', `${DIMENSIONS.length - raw.length} review dimension(s) did not run`)
const sevRank = { blocker: 0, concern: 1, nit: 2 }
const byKey = {}
for (const f of raw.flatMap(r => r.findings || [])) {
  const k = `${f.file ?? '?'}:${f.line ?? 0}:${(f.issue || '').slice(0, 40)}`
  if (!byKey[k] || (sevRank[f.severity] ?? 9) < (sevRank[byKey[k].severity] ?? 9)) byKey[k] = f   // highest severity wins
}
const dedup = Object.values(byKey)
const judged = (await mapAll(dedup, async (f) => {
  const votes = (await parallel([0, 1, 2].map(i => () => agentGate(() => agent(
    `Adversarially verify (skeptic #${i + 1}): try to REFUTE this finding against the ACTUAL code in ${ROOT}: ${JSON.stringify(f).slice(0, 800)}. Build the concrete input/path. Default refuted=true if you cannot positively confirm it.${codexBrief('verify')} Return { refuted: bool, evidence: string }.`,
    { label: `verify:${(f.file || '?').split('/').pop()}`, phase: 'Review',
      schema: { type: 'object', required: ['refuted'], properties: { refuted: { type: 'boolean' }, evidence: { type: 'string' } } } }))))).filter(Boolean)
  // FAIL CLOSED on a dead panel: quorum failure means UNVERIFIED (kept + flagged), never dropped —
  // a finding must not vanish because its verifiers rate-limited out.
  if (votes.length < 2) return { ...f, verdict: 'unverified' }
  const survives = votes.filter(v => !v.refuted).length > votes.filter(v => v.refuted).length
  return survives ? { ...f, verdict: 'confirmed' } : null
})).filter(Boolean)
const confirmed = judged.filter(f => f.verdict === 'confirmed')
const unverified = judged.filter(f => f.verdict === 'unverified')
const reviewItems = recordFindings([...confirmed, ...unverified].map(f => ({ phase: 'review', kind: 'finding', ...f })))
if (!reviewDone) { log(`review: ${dedup.length} raw → ${confirmed.length} confirmed, ${unverified.length} unverified-kept (dead panels fail closed)`); await persistPhase('review', reviewItems, 'Review', raw.length < DIMENSIONS.length ? 'blocked' : 'done') }

const perf = await phaseAgent('Performance', OPT.performance,
  `Run the auto-performance contract on the changed hot paths of ${BRANCH} in ${ROOT}: establish a reproducible baseline benchmark FIRST, profile to real hotspots, optimize one at a time, keep a change ONLY if re-benchmark shows a real (beyond-variance) win AND the tests stay green — otherwise revert. Return { ok, summary, findings: [unproven/reverted claims] }.`, RES_SCHEMA)
if (perf && !perf.skipped && !perf.skippedDone && !perf.died && !perf.ok) gateFail('performance', perf?.summary || 'performance pass did not complete cleanly (ok:false)')  // !died: phaseAgent already recorded a died gate — don't double-count
const perfItems = recordFindings((perf?.findings || []).map(f => ({ phase: 'performance', ...f })))
if (!perf?.skippedDone && (!perf?.skipped || perf?.budget)) await persistPhase('performance', perfItems, 'Performance', perf?.died || perf?.budget || (perf && !perf.skipped && !perf.ok) ? 'blocked' : 'done')

const reviewOpen = register.filter(r => r.phase === 'review').length
const shipBlockedByReview = OPT.shipPrep && reviewOpen > 0
if (shipBlockedByReview) gateFail('ship_prep', `ship prep did not run because ${reviewOpen} actionable review item(s) remain`)
const ship = await phaseAgent('Ship prep', OPT.shipPrep && !shipBlockedByReview,
  `Run the auto-ship PREP contract (NO irreversible step — no push --force, no deploy, no publish) for ${BRANCH} in ${ROOT}: audit the pre-launch gates (final validate readiness, docs for public changes, rollback path), draft the changelog FROM the actual commits, and prepare (do not open) the PR body with gate results. Return { ok, summary, findings: [gate blockers] }.`, RES_SCHEMA)
if (ship && !ship.skipped && !ship.skippedDone && !ship.died && !ship.ok) gateFail('ship_prep', ship?.summary || 'pre-launch gates not clean')  // !died: phaseAgent already recorded a died gate — don't double-count
const shipItems = recordFindings((ship?.findings || []).map(f => ({ phase: 'ship_prep', ...f })))
if (!ship?.skippedDone && (!ship?.skipped || ship?.budget || shipBlockedByReview)) await persistPhase('ship_prep', shipItems, 'Ship prep', shipBlockedByReview || ship?.died || ship?.budget || (ship && !ship.skipped && !ship.ok) ? 'blocked' : 'done')

// ── Finalize: the load-bearing end-state gate ─────────────────────────────────────
phase('Finalize')
const fin = await rAgent(
  `In ${ROOT} on ${BRANCH}, run the whole-workspace validate ONCE: ${VALIDATE}
   Report honestly. Return JSON { passed: bool, output: string (last 30 lines) }.`,
  { label: 'final-validate', phase: 'Finalize',
    schema: { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' }, output: { type: 'string' } } } })
if (!fin?.passed) gateFail('final_validation', `workspace validate is RED or did not run — the end-state truth gate blocks (${(fin?.output || '').slice(0, 300)})`)
const workflowConverged = register.length === 0
if (CK) {
  await agent(`Run: ${ck(`validation ${STATUS} ${fin?.passed ? 'green' : 'red'}`)}`, { label: 'status:validation', phase: 'Finalize' }).catch(() => null)
  await persistPhase('final_validation', [], 'Finalize', fin?.passed ? 'done' : 'blocked')
  // The ordinary lifecycle pass is not the full run. Leave the checkpoint resumable until the outer
  // skill completes auto-learn → auto-map and records both durable receipts.
  const result = workflowConverged ? 'ordinary lifecycle clean; closeout pending' : `${register.length} open item(s); closeout pending`
  await agent(`Run: ${ck(`finalize ${STATUS} needs_attention --result "${result}"`)}`, { label: 'status:final', phase: 'Finalize' }).catch(() => null)
}

if (missingAgents.size) log(`specialist routing: ${[...missingAgents].join(', ')} assigned by the plan but unavailable here — those tasks ran generic (report it so the user can install them)`)
return {
  converged: false,                        // final convergence belongs to the outer skill after closeout
  workflowConverged,                       // ordinary lifecycle + final validate + whole register only
  closeoutRequired: ['auto_learn', 'auto_map'],
  build: buildOut, blockedTaskCount: blocked.length,
  reviewConfirmed: confirmed.length,
  phasesSkipped: Object.entries(OPT).filter(([, v]) => !v).map(([k]) => k),
  workspaceValidatePassed: fin?.passed === true,
  specialistsUsed: [...usedSpecialists],   // installed agents the build actually routed to
  missingAgents: [...missingAgents],       // plan-assigned specialists absent here → ran generic
  register,                                // WHOLE actionable register — every source/severity feeds the bounded fix loop
  informational,                           // pure observations + explicit user-approved scope drops, reported separately
  statusFile: STATUS,
}
