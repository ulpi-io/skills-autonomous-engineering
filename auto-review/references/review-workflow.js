// review-workflow.js — the runnable Workflow behind `auto-review`.
//
// Fan out one reviewer per dimension over a diff → dedup across dimensions (a genuine barrier:
// dedup needs the full set) → adversarially verify each finding with a skeptic panel → return
// ONLY the survivors, severity-ranked, plus the rejection ledger and the coverage record.
// FAIL-CLOSED: a dimension whose reviewer died is reported as a COVERAGE GAP, never as "clean".
//
// Launch (from the skill):
//   Workflow({ scriptPath: "<this file>", args: {
//     root: "<abs repo path>",             // REQUIRED
//     diffCmd: "git diff main...HEAD",     // REQUIRED — the exact diff command for the scope
//     dimensions: ["correctness", ...],    // optional — defaults below
//     skeptics: 3,                         // optional — panel size per finding (odd; 3 default, 5 high-stakes)
//     maxParallel: 6                       // optional — concurrent reviewers/verifiers
//   }})

export const meta = {
  name: 'auto-review',
  description: 'Multi-dimension diff review → dedup → adversarial verification; returns confirmed findings + rejection ledger + coverage (fail-closed)',
  phases: [
    { title: 'Review', detail: 'one independent reviewer per dimension over the diff' },
    { title: 'Verify', detail: 'majority-refute skeptic panel per deduped finding' },
  ],
}

let CFG = {}
if (args && typeof args === 'object') CFG = args
else if (typeof args === 'string' && args.trim()) { try { CFG = JSON.parse(args) } catch { CFG = {} } }
const need = (k) => { if (!CFG[k]) throw new Error(`auto-review: missing required arg '${k}'`); return CFG[k] }
const ROOT = need('root'), DIFF = need('diffCmd')
const DIMENSIONS = CFG.dimensions || [
  'correctness (logic errors, edge/error paths, races, null/empty, wrong assumptions)',
  'security (trust boundaries, injection, authz, secrets, unsafe deserialization)',
  'performance (N+1, blocking calls, needless allocation on hot paths — flag, do not assert unmeasured speedups)',
  'maintainability (duplication, complexity, intent-hiding structure — concrete, not style opinion)',
  'test adequacy (new behaviors without meaningful tests, vacuous assertions)',
  'API/contract compatibility (public interface changes, backward compat, error semantics)',
]
const N_SKEPTICS = CFG.skeptics ?? 3
const MAX_PARALLEL = CFG.maxParallel ?? 6

async function mapCapped(items, cap, fn) {
  const out = []; let i = 0
  async function worker() { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k) } }
  await Promise.all(Array.from({ length: Math.min(cap, Math.max(items.length, 1)) }, worker))
  return out
}

// Retry transient agent deaths (rate-limit storms) with fixed backoff — a dead reviewer must be a
// RETRIED reviewer before it becomes a reported coverage gap (fail-closed, but not trigger-happy).
const RETRY_DELAYS = [3000, 10000, 30000]
const isRateLimit = (e) => /rate.?limit|429|overloaded|529|too many requests|quota/i.test(String((e && (e.message || e)) || ''))
const sleep = (ms) => (typeof setTimeout === 'function' ? new Promise(r => setTimeout(r, ms)) : Promise.resolve())
async function withRetry(fn, label) {
  for (let attempt = 0; ; attempt++) {
    try { const r = await fn(); if (r != null) return r }
    catch (e) { if (!isRateLimit(e)) throw e }
    if (attempt >= RETRY_DELAYS.length) return null
    log(`${label || 'agent'} died (attempt ${attempt + 1}/${RETRY_DELAYS.length + 1}) — backing off ${RETRY_DELAYS[attempt] / 1000}s`)
    await sleep(RETRY_DELAYS[attempt])
  }
}

const FINDINGS = { type: 'object', required: ['findings'], properties: {
  findings: { type: 'array', items: { type: 'object', required: ['file', 'issue', 'severity'], properties: {
    file: { type: 'string' }, line: { type: 'integer' }, issue: { type: 'string' },
    severity: { type: 'string', enum: ['blocker', 'concern', 'nit', 'fyi'] },
    scenario: { type: 'string' }, fix: { type: 'string' } } } } } }
const VERDICT = { type: 'object', required: ['refuted'], properties: {
  refuted: { type: 'boolean' }, confidence: { type: 'string', enum: ['low', 'med', 'high'] },
  evidence: { type: 'string' }, counterexample: { type: 'string' } } }

// ── Review: one independent lens per dimension ────────────────────────────────────
phase('Review')
const results = await mapCapped(DIMENSIONS, MAX_PARALLEL, (dim, i) => withRetry(() => agent(
  `You are reviewer ${i + 1}/${DIMENSIONS.length}, lens: ${dim}.
   In ${ROOT}, run: ${DIFF}
   Review ONLY through your lens. Read the actual changed code (not just the diff hunks) where the
   diff is ambiguous. Every finding needs a CONCRETE failure scenario (inputs/state → wrong outcome),
   a file, a line, an honest severity (blocker = ship-stopping defect; concern = real but survivable;
   nit/fyi = minor), and a suggested fix. No style opinions, no unverifiable speculation.
   Return { findings: [...] } — an empty array is a valid, honest result.`,
  { label: `review:${dim.split(' ')[0]}`, phase: 'Review', schema: FINDINGS }), `review:${dim.split(' ')[0]}`))

const coverage = DIMENSIONS.map((dim, i) => ({ dimension: dim.split(' ')[0], ran: !!results[i] }))
const gaps = coverage.filter(c => !c.ran)
if (gaps.length) log(`COVERAGE GAP: ${gaps.map(g => g.dimension).join(', ')} did not run — fail closed, these are NOT clean`)

// barrier is genuine here: dedup needs every dimension's findings at once.
// Keep the HIGHEST severity per key — last-write-wins would let a nit clobber a blocker.
const rank = { blocker: 0, concern: 1, nit: 2, fyi: 3 }
const byKey = {}
for (const f of results.filter(Boolean).flatMap(r => r.findings || [])) {
  const k = `${f.file}:${f.line ?? 0}:${(f.issue || '').toLowerCase().slice(0, 48)}`
  if (!byKey[k] || (rank[f.severity] ?? 9) < (rank[byKey[k].severity] ?? 9)) byKey[k] = f
}
const dedup = Object.values(byKey)
log(`review: ${results.filter(Boolean).flatMap(r => r.findings || []).length} raw → ${dedup.length} deduped`)

// ── Verify: majority-refute skeptic panel per finding ─────────────────────────────
phase('Verify')
const LENSES = ['correctness — trace the logic on a concrete input', 'reproduction — actually construct the failing input/state', 'regression — does the claimed defect really change observable behavior']
const verified = await mapCapped(dedup, MAX_PARALLEL, async (f) => {
  const n = f.severity === 'blocker' ? N_SKEPTICS + 2 : N_SKEPTICS   // blockers genuinely get a stronger panel
  const votes = (await parallel(Array.from({ length: n }, (_, i) => () => withRetry(() => agent(
    `Adversarial skeptic ${i + 1}/${n}, lens: ${LENSES[i % LENSES.length]}.
     Try to REFUTE this finding against the ACTUAL code in ${ROOT} (read the file, build the input):
     ${JSON.stringify(f).slice(0, 900)}
     Default refuted=true if you cannot POSITIVELY establish it with evidence.
     Return { refuted, confidence, evidence, counterexample? }.`,
    { label: `verify:${(f.file || '?').split('/').pop()}`, phase: 'Verify', schema: VERDICT }), 'skeptic')))).filter(Boolean)
  const confirms = votes.filter(v => !v.refuted).length
  const refutes = votes.filter(v => v.refuted).length
  const hardRefute = votes.some(v => v.refuted && v.confidence === 'high' && v.counterexample)
  const survives = votes.length >= Math.ceil(n / 2) && confirms > refutes && !hardRefute
  return { f, survives, votes: { confirms, refutes, of: votes.length } }
})

const confirmed = verified.filter(v => v.survives).map(v => ({ ...v.f, votes: v.votes }))
  .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9))
const rejected = verified.filter(v => !v.survives).map(v => ({ ...v.f, votes: v.votes }))
log(`verify: ${confirmed.length} confirmed, ${rejected.length} rejected by the panel`)

return {
  clean: confirmed.length === 0 && gaps.length === 0,   // clean ONLY if every dimension ran AND nothing survived
  confirmed,                                             // act on these
  rejected,                                              // the rejection ledger — filtering made visible
  coverage,                                              // which dimensions actually ran (fail-closed record)
}
