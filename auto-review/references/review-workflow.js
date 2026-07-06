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
const N_SKEPTICS = Math.max(1, Number(CFG.skeptics) || 3)
const MAX_PARALLEL = Math.max(1, Number(CFG.maxParallel) || 6)
if (!DIMENSIONS.length) throw new Error('auto-review: dimensions must be a non-empty array — zero reviewers would report a vacuous clean')

async function mapCapped(items, cap, fn) {
  const out = []; let i = 0
  async function worker() { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k) } }
  await Promise.all(Array.from({ length: Math.min(cap, Math.max(items.length, 1)) }, worker))
  return out
}

// Retry transient agent deaths (rate-limit storms AND network blips) with fixed backoff — a dead
// reviewer must be a RETRIED reviewer before it becomes a reported coverage gap (fail-closed, but not
// trigger-happy). A null return (died at the door / after the runtime's own retries) is always retried;
// a THROWN error is retried only when isTransient matches (rate-limit OR a dropped connection), so a
// genuine bug still surfaces. If retries exhaust, the dimension is reported as a gap, never faked clean.
const RETRY_DELAYS = [3000, 10000, 30000]
const isTransient = (e) => /rate.?limit|429|overloaded|529|too many requests|quota|502|503|504|bad gateway|gateway time|service unavailable|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed|network error|network|connection (?:reset|closed|error|refused|aborted)|timed? ?out|premature close|terminated/i.test(String((e && (e.message || e)) || ''))
const HAS_TIMER = typeof setTimeout === 'function'   // sandbox may lack timers: retries still happen, just without backoff
const sleep = (ms) => (HAS_TIMER ? new Promise(r => setTimeout(r, ms)) : Promise.resolve())
async function withRetry(fn, label) {
  for (let attempt = 0; ; attempt++) {
    try { const r = await fn(); if (r != null) return r }
    catch (e) { if (!isTransient(e)) throw e }
    if (attempt >= RETRY_DELAYS.length) return null
    log(`${label || 'agent'} died (attempt ${attempt + 1}/${RETRY_DELAYS.length + 1}) — likely a rate-limit or network blip; ${HAS_TIMER ? `backing off ${RETRY_DELAYS[attempt] / 1000}s` : 'no timer: immediate retry'}`)
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
// Verify runs n skeptics PER finding — bound total concurrency, not just finding-count
const verified = await mapCapped(dedup, Math.max(1, Math.floor(MAX_PARALLEL / Math.min(3, N_SKEPTICS))), async (f) => {
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
  // FAIL CLOSED: a dead panel (below quorum) makes the finding UNVERIFIED — kept and flagged,
  // never conflated with 'rejected'. Rejection requires a quorum that actually voted.
  const quorum = votes.length >= Math.ceil(n / 2)
  const verdict = !quorum ? 'unverified' : (confirms > refutes && !hardRefute ? 'confirmed' : 'rejected')
  return { f, verdict, votes: { confirms, refutes, of: votes.length } }
})

const bySev = (a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9)
const confirmed  = verified.filter(v => v.verdict === 'confirmed').map(v => ({ ...v.f, votes: v.votes })).sort(bySev)
const unverified = verified.filter(v => v.verdict === 'unverified').map(v => ({ ...v.f, votes: v.votes })).sort(bySev)
const rejected   = verified.filter(v => v.verdict === 'rejected').map(v => ({ ...v.f, votes: v.votes }))
log(`verify: ${confirmed.length} confirmed, ${unverified.length} unverified-kept (dead panels fail closed), ${rejected.length} rejected`)

return {
  clean: confirmed.length === 0 && unverified.length === 0 && gaps.length === 0,   // every dimension ran, every panel reached quorum, nothing survived
  confirmed,                                             // act on these
  unverified,                                            // panels died below quorum — treat as OPEN, re-verify or review by hand
  rejected,                                              // the rejection ledger — filtering made visible
  coverage,                                              // which dimensions actually ran (fail-closed record)
}
