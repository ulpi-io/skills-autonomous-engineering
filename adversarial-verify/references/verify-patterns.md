# Verify Patterns — panels, lenses, and bulk gating

Load when gating more than one claim or wiring adversarial verification into a phase skill. These are the
concrete Workflow-tool shapes plus verifier prompt templates.

## Verifier prompt template (per lens)

Every verifier prompt has the same skeleton; the lens swaps the emphasis:

```
You are an adversarial verifier. Your job is to REFUTE the claim below, not to confirm it.

CLAIM (proposition): <the falsifiable statement>
FAILURE SCENARIO it asserts: <inputs/state → wrong behavior>
GROUND TRUTH: <file:line excerpts / the diff / the repro command — the ACTUAL code, not a summary>

Via the <LENS> lens, try to prove this claim is WRONG:
  - correctness:   trace the logic on a concrete input. Find the case where the claim's conclusion fails.
  - reproduction:  actually construct the input/state and run/trace it. Does the failure occur? If it
                   can't be reproduced, refute.
  - security:      probe the trust boundary — injection, authz bypass, secret exposure, unsafe deserialize.
  - regression:    find an existing behavior this fix/change breaks. Run the affected path.
  - measurement:   re-check the benchmark apples-to-apples (same input, warm vs cold, variance). Does the
                   improvement survive?

Default to refuted=true if you cannot POSITIVELY establish the claim with evidence.
Return: { refuted: bool, confidence: "low"|"med"|"high", evidence: string, counterexample?: string }
```

## Per-finding panel (single claim, N skeptics)

```js
const votes = (await parallel(Array.from({length: N}, (_, i) => () =>
  agent(verifierPrompt(claim, LENSES[i % LENSES.length]), { schema: VERDICT })
)).then(vs => vs.filter(Boolean)))

// fail closed: dead verifiers don't count as survivals
const refuted   = votes.filter(v => v.refuted).length
const confirmed = votes.filter(v => !v.refuted).length
const survives  = confirmed > refuted && votes.length >= Math.ceil(N/2)   // majority AND quorum

// evidence override: one high-confidence counterexample beats bare confirmations
const hardRefute = votes.some(v => v.refuted && v.confidence === "high" && v.counterexample)
const verdict = survives && !hardRefute
```

## Dual-lens verify (a claim with two failure modes)

Don't run identical skeptics when the claim can break two ways — assign the lenses:

```js
const lenses = ['correctness', 'security']              // or ['regression','reproduction'], etc.
const vs = (await parallel(lenses.map(L => () =>
  agent(verifierPrompt(claim, L), { schema: VERDICT })))).filter(Boolean)
// FAIL CLOSED: require EVERY lens to have actually returned before AND-ing. agent() returns null on
// death/skip and .filter(Boolean) drops it, and [].every() / a short array's .every() is `true` — so
// without the length check a dead (or half-dead) panel would falsely "clear" a safe-to-ship claim.
const verdict = vs.length === lenses.length && vs.every(v => !v.refuted)   // both lenses RAN and cleared it
```

For a claim that must hold under ALL lenses (a "safe to ship"), use AND across lenses. For a defect that
"is real if it can fail in any way", a single lens refuting is enough to keep it as a real defect.

## Bulk gating over a findings list

The common case: a finder produced many findings; verify each before fixing. Fan out, panel per finding,
as soon as each finding is ready (pipeline, no barrier):

```js
export const meta = { name:'gate-findings', description:'adversarially verify each finding before acting',
  phases:[{title:'Verify'}] }

const verified = (await parallel(findings.map(f => () => {
  const lenses = pickLenses(f)
  return parallel(lenses.map(L => () =>
    agent(verifierPrompt(f, L), { phase:'Verify', schema: VERDICT })))
    // pass the EXPECTED count so tally fails closed on a dead panel: a filtered-empty verdict set must
    // be REJECTED, never survive. tally(returned, expected) → rejected when returned < ceil(expected/2).
    .then(vs => ({ f, real: tally(vs.filter(Boolean), lenses.length) }))
}))).filter(Boolean)

return {
  survivors:  verified.filter(v => v.real).map(v => v.f),
  rejections: verified.filter(v => !v.real).map(v => ({ finding: v.f, reason: 'refuted by panel' })),
}
```

`pickLenses(f)` chooses lenses by finding type (a security finding → security+reproduction; a perf claim
→ measurement+regression).

## The tally rule, stated once

A claim SURVIVES iff (`tally(returned, expected)` enforces all three — pass it BOTH the surviving verdicts
and the count you dispatched, or it cannot check #1):
1. a quorum of verifiers actually returned (`returned ≥ ceil(expected/2)`; dead/timed-out don't count), AND
2. a majority of returned verdicts are `refuted=false`, AND
3. no single high-confidence, counterexample-backed refutation stands.

Anything else → REJECTED. For a "clean/safe" claim, REJECTED means "not clean" — carry it as an open,
blocking concern, never as a pass.

## Cost discipline

- N=1 for cheap, reversible, low-stakes (a cosmetic lint call).
- N=3 default.
- N=5 + multi-lens for irreversible / high-stakes (security, go-live, broad migration).
- Don't verify what's already machine-proven — a green test IS the verification. Spend the panel on the
  claims that only have an agent's word behind them.
