---
name: adversarial-verify
version: 0.1.0
description: |
  Before an autonomous agent acts on a finding — a bug, a proposed fix, a "this is safe to ship" claim —
  PROVE it by trying to disprove it. Spawn N independent skeptic agents, each prompted to REFUTE the
  claim (optionally each through a distinct lens: correctness / security / does-it-actually-reproduce /
  perf), and keep the claim only if a majority fails to refute it. This is the gate that turns "plausible"
  into "verified" and stops false positives from driving edits, false negatives from being waved through,
  and confident-but-wrong findings from surviving. Use it to gate any finding list before you fix it, any
  fix before you commit it, and any clean verdict before you report it. Composes inside auto-review,
  auto-build's fix loop, auto-simplify, and go-live gating.
allowed-tools:
  - Agent
  - Workflow
  - Bash
  - Read
  - Grep
  - Glob
effort: high
argument-hint: "<the claim/finding to verify, or a path to a findings list>"
arguments:
  - claim
when_to_use: |
  Use before acting on anything an agent ASSERTED but hasn't PROVEN: a bug report before you fix it, a
  refactor before you commit it, a "no vulnerabilities" / "safe to ship" verdict before you trust it, a
  benchmark "win" before you accept it. Especially use when the action is expensive or hard to reverse.
  Do NOT use for facts already machine-verified (a test that passed, a command that exited 0) — those are
  proven; re-litigating them is wasted tokens.
---

<EXTREMELY-IMPORTANT>
Verification only works if the verifiers can actually FAIL the claim. Non-negotiable:
1. Verifiers must be INDEPENDENT and ADVERSARIAL — each is told to REFUTE, not to confirm. A verifier
   prompted to "check if this is right" rubber-stamps; one prompted to "prove this is wrong" finds the
   hole. Default-to-refuted on uncertainty.
2. FAIL CLOSED. If verifiers can't reach the majority-survive bar, the claim is REJECTED (or, for a
   "clean" claim, NOT clean). A tie or an ambiguous result is a rejection, never a pass. Never upgrade an
   unproven claim to verified to keep a loop moving.
3. Verifiers get ground truth, not just the assertion — the actual code/diff/repro, so they check reality,
   not the claimant's summary. A verifier that only reads the claim can't refute it.
4. NEVER let the claimant verify itself. The agent that produced the finding cannot be one of its
   skeptics — independence is the whole point.
5. Report the vote honestly: survivors, rejections, and WHY each was refuted. A rejected finding is a
   real result (a false positive caught), not a gap to hide.
</EXTREMELY-IMPORTANT>

# Adversarial Verify

## Inputs

- `$claim`: The thing to verify — a single finding, a fix to confirm, a verdict to stress, or a path to a
  list of findings to gate in bulk.

## Goal

Decide, cheaply and honestly, whether a claim is real enough to act on — by giving independent skeptics
the ground truth and a mandate to break it, then trusting the claim only if it survives. The output is a
verdict per claim (survived / rejected) plus the reasons, so the caller acts on verified items only.

## Step 1: Frame each claim as a refutable proposition

A claim you can't refute isn't verifiable — sharpen it first. Turn each finding into a concrete
proposition with a falsifiable failure scenario:

- vague: "there might be a race in the pool" → refutable: "concurrent `acquire()` past `max` returns a
  connection already lent out — under N parallel callers, two get the same handle."
- vague: "this is safe to ship" → refutable: "no enabled gate is red AND no untested path mutates money
  AND the final validate exits 0."

Attach the ground truth each verifier needs: the file:line, the diff, the repro command, the relevant
invariant. A proposition + its evidence is what gets voted on.

**Success criteria**: every claim is a falsifiable statement with the evidence a skeptic needs to test it.

## Step 2: Choose the verifier panel — count and lenses

- **Count (N)**: scale to the cost of being wrong. Low-stakes / cheap-to-reverse → N=1. Default → N=3.
  Expensive or irreversible (a security claim, a go-live verdict, a broad migration) → N=5. Odd N avoids
  ties.
- **Lenses**: if the claim can fail in more than one way, give each verifier a DISTINCT lens instead of N
  identical skeptics — diversity catches what redundancy can't:
  - **correctness** — is the logic actually wrong / the fix actually right?
  - **reproduction** — does the failing scenario actually occur? build the concrete input and trace it.
  - **security** — trust boundary, injection, authz, secret exposure.
  - **regression** — does the fix/optimization break something else or change behavior?
  - **measurement** (for perf claims) — does the benchmark actually show the win, apples-to-apples?
  Use identical refuters only when the claim has a single failure mode.

**Success criteria**: N and the lens assignment are chosen and justified by the claim's stakes and
failure modes.

## Step 3: Run the panel — independent, adversarial, evidence-based

Spawn the verifiers in parallel (single message / `parallel()` in a Workflow). Each verifier prompt MUST:

- state the proposition and hand over the ground truth (code/diff/repro), not just the claim text;
- assign the lens ("verify via the SECURITY lens");
- instruct: **try to REFUTE this. Default to refuted=true if you cannot positively confirm it.** Build the
  counterexample; run the repro if one exists; read the actual code path;
- return a structured verdict: `{ refuted: bool, confidence, evidence, counterexample? }`.

Never include the originating claimant among the verifiers. For a bulk list, fan out per finding (see
`fan-out-work`) with the panel nested per item.

**Success criteria**: N independent, evidence-grounded verdicts per claim, each with a reason.

## Step 4: Tally with a fail-closed rule

A claim **survives** only if a majority of verifiers fail to refute it (`refuted=false`). Otherwise it is
**rejected**. Fail-closed specifics:

- ties and "insufficient evidence" → rejected (for a defect claim: dropped; for a "clean/safe" claim:
  NOT clean — treat as an open concern).
- a single high-confidence refutation with a concrete counterexample can override a bare-assertion
  majority — a proven break beats unproven confirmations. Weigh evidence, not just headcount.
- dead/empty/timed-out verifiers do NOT count as "didn't refute" — a gate that didn't run is not a pass;
  re-run or treat as rejected.

**Success criteria**: each claim is survived/rejected by an explicit, fail-closed tally.

## Step 5: Return verified items + the rejection ledger

Hand back:

- **survivors** — the verified claims, safe to act on, with the evidence that held up.
- **rejections** — each refuted claim with its counterexample. This is a first-class result: a rejected
  finding is a false positive you just prevented from driving a bad edit; a rejected "safe to ship" is a
  gate you just kept honest.

The caller acts ONLY on survivors, and — for a clean-verdict use — treats any rejection as blocking.

**Success criteria**: the caller gets a clean survived/rejected split with reasons; nothing unproven is
labeled verified.

## Guardrails

- Never prompt verifiers to "confirm"; always to "refute". The framing is the mechanism.
- Never let the claimant sit on its own panel.
- Never pass only the claim text — pass the ground truth or the verifier can't actually test it.
- Never count a tie, an abstention, or a dead verifier as a survival. Fail closed.
- Never re-verify already machine-proven facts (a green test, a zero exit) — that's proven; save the
  tokens for the unproven claims.
- Never hide rejections — they're the evidence the gate is working.
- Scale N to stakes; don't run a 5-skeptic panel on a cosmetic lint finding, and don't run N=1 on a
  go-live verdict.

## When To Load References

- `references/verify-patterns.md`
  The Workflow-tool shapes (per-finding panel, dual-lens verify, majority-refute tally, bulk gating over
  a findings list), verifier prompt templates per lens, and the evidence-over-headcount weighting rule.
  Load when gating more than one claim or wiring verification into a phase skill.

## Output Contract

Report:

1. claims in → panel used (N + lenses) per claim
2. survived vs rejected, with the reason/counterexample for each rejection
3. for a clean-verdict use: the verdict, and any rejection that blocks it
4. what the caller should act on (survivors only)
