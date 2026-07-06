---
name: budget-guard
version: 0.1.0
description: |
  The discipline that keeps an autonomous run from becoming a runaway: before any unattended loop or workflow, declare the five stop conditions — done-condition, hard cap, token/time budget, no-progress rule, escalation triggers — then hold the run to them and stop the instant one fires. Fails closed: a capped run reports an honest partial, never fabricated success. Load at the start of ANY unattended run.
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
argument-hint: "[the run to bound — a phase, a loop, or the whole pipeline]"
arguments:
  - run
when_to_use: |
  Load at the start of ANY unattended run — a converge-loop, a fan-out, an auto-phase, the autonomous
  pipeline — to set and enforce its stop conditions. Especially load before a run that will spawn many
  agents or execute many rounds without a human in between. Do NOT skip it because "this will be quick" —
  the runs that grind for hours are exactly the ones that started without a declared budget.
---

<EXTREMELY-IMPORTANT>
An autonomous run without a declared budget is a bug, not a feature. Non-negotiable:
1. NO RUN STARTS WITHOUT A STOP DECLARATION: a done-condition, a hard cap (iterations AND/OR agents), a
   budget (tokens/tool-calls/wall-clock), a no-progress rule, and named escalation triggers. If you can't
   state all five, don't run it unattended — do a bounded piece and report.
2. THE BUDGET IS A CEILING, NOT A SUGGESTION. When the cap or budget is reached, the run STOPS — even
   mid-task — and reports what's done and what's left. Never "just a bit more" past the ceiling.
3. FAIL CLOSED. Hitting a limit without meeting the done-condition is an HONEST PARTIAL result
   (`converged:false` + the remaining gap), never a fabricated success to look finished.
4. ESCALATE ON NAMED TRIGGERS. Irreversible/destructive actions, ambiguous requirements, repeated
   no-progress, and "about to exceed budget" are STOP-and-ask points — the run does not decide these for
   the user.
5. NEVER RAISE THE CAP TO KEEP GOING. If the declared budget wasn't enough, that is a finding to surface,
   not a number to quietly bump. Re-scoping is a user decision.
</EXTREMELY-IMPORTANT>

# Budget Guard

## Overview

Give every autonomous run a contract it cannot exceed. Budget-guard is not an action so much as a
discipline the other skills wrap themselves in: it forces the five stop conditions to exist before the run
starts, holds the run to them during, and makes the exit honest. It's what turns a loop that *could* run
forever into one that *provably* terminates within a known cost.

## The five stop conditions (declare all before running)

| Condition | What it bounds | Example |
|---|---|---|
| **done-condition** | success — machine-checkable | validate exits 0 / finder returns 0 / all DAG units done |
| **hard cap** | count of iterations and/or agents | ≤6 loop rounds; ≤40 total agents |
| **budget** | cost — tokens / tool-calls / wall-clock | ≤150k output tokens; ≤20 min |
| **no-progress rule** | futility | stop after 2 rounds with no measured improvement |
| **escalation triggers** | user-owned decisions | destructive op, ambiguous spec, repeated stall, near-budget |

A run is safe only when ALL five exist. Missing one is the hole a runaway escapes through.

## Phase 0: Size the budget to the task and the directive

Set the numbers deliberately, not by reflex:

- If the user gave a token/scale directive (e.g. "+500k", "quick pass", "be thorough"), map it to the
  budget: a big target → a wider fan-out and more rounds; "quick" → tight caps. In a Workflow, read
  `budget.total` / `budget.remaining()`; the target is a HARD ceiling once reached.
- Scale the hard cap to the work: a typecheck-fix loop rarely needs >6 rounds; a broad audit might take 8.
  Total agents scale with the item count but stay bounded (and concurrency-capped — see `fan-out-work`).
- Default token budget when none is given: bound it (e.g. ~150k output tokens for a phase) rather than
  leaving it open. An unbounded default is not a default.

**Success criteria:** all five conditions have concrete values, justified by the task and any directive.

## Phase 1: Enforce during the run

Check the conditions every iteration / at every barrier, cheaply:

- decrement the iteration/agent counters; compare spend to the budget BEFORE launching the next expensive
  step (don't discover you're over budget after paying for the overshoot);
- track the progress signal (see `converge-loop`) so the no-progress rule can fire;
- watch the escalation triggers continuously — an irreversible step or an ambiguity is a stop, whenever it
  appears.

When any condition fires, halt at the next safe boundary (finish the in-flight unit's commit, don't abort
mid-write) and go to Phase 2.

**Success criteria:** the run cannot exceed any declared limit; a limit hit halts it at a safe point.

## Phase 2: Exit honestly (or escalate)

Classify and report the exit:

- **done** — done-condition met within budget. Report cost used.
- **capped / over-budget** — limit hit first. Report the honest partial: what's done, what remains, the
  cost spent. Offer the user the re-scope decision (raise budget / narrow scope / hand off) — never raise
  it yourself.
- **escalated** — a named trigger fired. STOP and surface the specific decision (with `AskUserQuestion`
  when interactive), then wait. Resume only on the user's answer.

**Success criteria:** exactly one exit reason; cost reported; any user decision surfaced, not assumed.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "It's almost done, let me go a little over the cap." | "Almost" is unmeasured optimism. The cap exists precisely for the case that feels almost-done and isn't. Stop and report. |
| "I'll set the budget after I see how it goes." | Then there is no budget. The runs that grind for hours all started this way. Declare it first. |
| "No progress this round, but the next one might work." | "Might" past the no-progress rule is thrash. Stop after the declared stalls and escalate. |
| "This delete/deploy is obviously fine, no need to ask." | Irreversible actions are escalation triggers by definition. Obvious-to-you is not authorization. |
| "Budget ran out, I'll just bump it and finish." | Re-scoping is the user's call. Raising your own ceiling silently defeats the guard. |
| "A budget will make me stop before it's perfect." | Bounded-and-honest beats unbounded-and-runaway. A reported partial is more useful than an hours-long grind. |

## Red Flags

- A loop/workflow launched with no stated caps in the transcript.
- Iteration or agent counts climbing past the declared cap.
- "Just one more round" after the no-progress rule should have fired.
- A cap or budget number quietly increased mid-run.
- An irreversible action taken inside an autonomous run without a stop-and-ask.
- A run reported "done" that actually hit a limit (a capped run wearing a success badge).

## Guardrails

- Never start an unattended run without all five stop conditions declared.
- Never exceed a declared cap/budget; halt at the next safe boundary and report.
- Never raise your own budget to keep going — that's a user decision.
- Never take an irreversible action or resolve a real ambiguity inside the run — escalate.
- Never report a capped/escalated run as a clean success.

## Native goal/loop routing

On Claude Code, compile the five stop conditions into the native machinery instead of only tracking
them by hand: the **done-condition** becomes the `/goal` objective (verified each turn by a separate
model — the strongest form of "machine-checkable"); the **hard cap** becomes `/loop`'s count/time stop;
the **budget** is the session/turn token target (in a Workflow, `budget.remaining()` — a HARD ceiling);
**escalation triggers** stay in the run body plus the deterministic guard hooks. The **no-progress
rule** has no native equivalent on Claude Code — keep it hand-tracked (Codex's `/goal` has it natively:
`blocked` after 3 consecutive stuck turns). Full mapping: `converge-loop`'s
`references/native-goal-loop.md`.

## When To Load References

- `converge-loop` (skill) — the loop-level termination set and no-progress/anti-thrash detectors this
  guard enforces at the iteration level; its `references/native-goal-loop.md` holds the /goal + /loop
  compilation table.
- `checkpoint-resume` (skill) — so a run stopped at a budget/escalation boundary resumes without redoing
  finished work.

## Output Contract

Report:

1. the five stop conditions used (with values)
2. cost spent (iterations / agents / tokens / time) vs. the budget
3. exit reason — done / capped / over-budget / escalated
4. on a non-done exit: the honest remaining gap + the user decision offered (never taken unilaterally)
