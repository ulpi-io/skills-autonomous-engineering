---
name: autonomous-pipeline
version: 0.1.0
description: |
  Run the whole engineering lifecycle end-to-end from one request — spec → plan → build → simplify → test
  → review → performance → ship — as a single autonomous pass with ONE human approval (the plan) and
  hard-gated escalation for anything irreversible. It chains the auto-* phase skills, carries a durable
  pipeline checkpoint so a stop/crash resumes at the exact phase and task it left off, watches the signal
  between phases (a phase's gate must be green before the next starts — fail closed), and returns a
  verified findings register at the end. It does NOT loop on its own: after one pass it reports what
  shipped and what's open, and the user decides on any fix round. This is the top-level "maximise
  autonomous agents" entry point. Composes every auto-* phase plus checkpoint-resume, budget-guard,
  watch-and-act, and adversarial-verify.
allowed-tools:
  - Skill
  - Agent
  - Workflow
  - AskUserQuestion
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
disable-model-invocation: true
user-invocable: true
effort: high
argument-hint: "<feature request to take from idea to shipped> (or 'resume' to continue a run)"
arguments:
  - request
when_to_use: |
  Use when the user wants "prompt → spec'd, planned, built, cleaned, tested, reviewed, tuned, shipped" in
  one autonomous run rather than invoking each phase by hand. Do NOT use for a single phase (invoke that
  auto-* skill directly), or for a quick one-off edit. It spawns many agents across many rounds over the
  whole lifecycle — it is explicit-user-only.
---

<EXTREMELY-IMPORTANT>
This is the most powerful and the most dangerous skill here — the full lifecycle, unattended. It inherits
every phase's guardrails and adds pipeline-level ones. Non-negotiable:
1. ONE HUMAN GATE (plan approval); irreversible/ambiguous/unfixable situations from ANY phase still STOP
   and ask. Approval authorizes the plan, not surprises.
2. ONE PASS, NO AUTONOMOUS RECURSION. The pipeline runs each phase once, returns a verified findings
   register, and STOPS. It never silently loops the whole lifecycle — an autonomous fix-loop is what turns
   a run into a multi-hour grind. A fix round is a deliberate user choice (re-invoke with the findings).
3. PHASE GATES FAIL CLOSED. Each phase must reach its own success bar before the next starts. A phase that
   didn't converge (build blocked, red validate, unverified review) does NOT hand a false-green to the
   next phase — it surfaces and the pipeline pauses or escalates. Never fabricate a phase's clean verdict
   to keep the pipeline moving.
4. DURABLE, RESUMABLE. A pipeline checkpoint records the current phase + each phase's state; a stop/crash
   resumes at the exact phase/task, skipping completed work — never restarting from spec.
5. BUDGET THE WHOLE RUN. Declare a pipeline-level budget/escalation contract (`budget-guard`) on top of
   each phase's. The lifecycle is long; an unbounded pipeline is a runaway.
6. HONEST END STATE. Report what actually shipped, which gates ran, and the open findings — caveated by
   which phases the user chose to skip. Never present a pipeline with a dead gate or a red end-state as
   done.
</EXTREMELY-IMPORTANT>

# Autonomous Pipeline

## Overview

One request in, shipped-quality work out — by running the eight phases as one governed pass. The pipeline
is not magic autonomy; it's *disciplined* autonomy: a single approval, fail-closed gates between phases, a
durable checkpoint, a whole-run budget, and an honest findings register at the end. It removes the human
stepping between phases, not the verification each phase enforces.

## Phase order and gates

```
 auto-spec → auto-plan →[APPROVAL]→ auto-build → auto-simplify → auto-test → auto-review → auto-performance → auto-ship
    │            │                      │             │              │            │              │                │
 testable    acyclic DAG           all tasks     behavior-      green,       verified      measured, no      gates green,
   spec      + self-reviewed       integrated,   preserving     meaningful   findings      correctness       rollback ready,
             covers spec           tests green   cleanups       coverage     (no false +)  regression        human sign-off
```

Each arrow is a fail-closed gate: the downstream phase starts only when the upstream phase met its success
bar. The user may configure which optional phases run (simplify/performance/go-live can be skipped);
build/test are not skippable. (This order follows spec→plan→build first; simplify runs against the
build's test safety net, test then hardens coverage.)

## Phase 0: Intake — request, config, budget, mode

- Detect **new run** vs **resume** (`$request` = "resume" / a pipeline checkpoint id → resume; skip
  intake, load the checkpoint, continue at the recorded phase).
- New run: capture the request; ask the FEW configuration questions (`AskUserQuestion`): which optional
  phases to run (simplify, performance, go-live/ship-deploy), and any budget/scope steer. Keep it light.
- Verify a git work tree + working branch; declare the pipeline `budget-guard` contract; create the
  pipeline `checkpoint-resume` file (one unit per phase).

**Success criteria:** run mode determined; phase config + budget set; git preflight passed; checkpoint
open.

## Phase 1: Run the lifecycle (one approved pass)

Drive the phases in order, each via its `auto-*` skill (or as Workflow phases), threading each phase's
output to the next and updating the pipeline checkpoint at every phase boundary. See
`references/pipeline-state.md` for the state machine, the per-phase gate conditions, and the handoff
contract.

- **spec → plan** run first; then a SINGLE approval gate on the plan (unambiguous affirmative required).
- After approval, **build → simplify → test → review → performance → ship** run autonomously, each gated
  on the prior's success bar.
- Between phases, optionally use `watch-and-act` to wait on an external signal (CI on the pushed branch,
  a deploy check) before proceeding.
- Any phase's escalation (unfixable/ambiguous/irreversible) PAUSES the pipeline and asks the user; on
  resolution, re-invoke to resume from that phase.

**Success criteria:** each phase reached its success bar before the next began; the checkpoint reflects
progress; escalations reached the user, not a guessed-through continuation.

## Phase 2: Verify + return the findings register (no auto-loop)

- Collect the phases' findings (review blockers, perf gaps, ship blockers), dedup, and `adversarial-verify`
  the aggregate so the register holds only real, confirmed items.
- The pipeline runs ONE pass and returns. If the register is non-empty, PRESENT it and let the user choose:
  run a fix round (re-invoke with the findings as the request — same intake), hand-fix, or accept-with-risk.
  Never loop the whole lifecycle on its own.

**Success criteria:** a verified, deduped findings register is returned; the next move is the user's, not
an autonomous recursion.

## Phase 3: Report

Read the pipeline checkpoint and report end-to-end (see Output Contract): what each phase produced, which
gates ran vs. were skipped (by user config), what shipped, and the open register. Fail closed — a run with
a dead gate or a red end-state is not "done".

**Success criteria:** an honest, phase-by-phase account; the durable checkpoint reflects the final state.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "It's autonomous, let it loop until everything's perfect." | An unbounded whole-lifecycle loop is the multi-hour-grind failure mode. One pass, return findings, let the user decide. |
| "Build came back with blocked tasks but let's just run review anyway." | A phase that didn't meet its bar hands a false-green downstream. Gates fail closed — pause or escalate. |
| "The user approved the plan, so I can deploy too." | Plan approval ≠ deploy approval. Irreversible steps in any phase still need explicit sign-off. |
| "Resume by re-running from spec, it's cleaner." | That redoes finished work and can diverge from what shipped. Resume from the checkpoint at the recorded phase. |
| "Report it as shipped — most of it worked." | Partial is not done. Report what shipped, which gates ran, and the open register honestly. |
| "Skip the budget, the phases have their own." | The lifecycle is long; phase budgets don't bound the whole. Declare a pipeline budget too. |

## Red Flags

- The whole pipeline looping on its own without a user-initiated fix round.
- A downstream phase started while the upstream phase had unresolved blockers.
- A deploy/irreversible step taken on the strength of the plan approval alone.
- A resume that restarted from spec and redid integrated work.
- "Shipped" reported while a gate didn't run or the end-state validate is red.
- No pipeline-level budget declared for a full lifecycle run.

## Guardrails

- One approval gate (the plan); every irreversible/ambiguous/unfixable situation still escalates.
- One pass, no autonomous whole-lifecycle recursion; fix rounds are user-initiated.
- Phase gates fail closed; never pass a false-green downstream.
- Durable resume from the checkpoint; never restart from spec.
- Declare and enforce a pipeline-level budget.
- Report the honest end state, caveated by which phases were skipped.

## When To Load References

- `references/pipeline-state.md` — the phase state machine, per-phase gate conditions, the phase-to-phase
  handoff contract, and the pipeline checkpoint schema. Load when wiring or resuming a run.
- The phase skills — `auto-spec`, `auto-plan`, `auto-build`, `auto-simplify`, `auto-test`, `auto-review`,
  `auto-performance`, `auto-ship` — each runs its own phase to its own bar.
- `checkpoint-resume` (skill) — the durable pipeline + per-phase state.
- `budget-guard` (skill) — the whole-run budget + escalation contract.
- `watch-and-act` (skill) — wait on CI/deploy signals between phases.
- `adversarial-verify` (skill) — verify the returned findings register.

## Output Contract

Report:

1. the run config — which phases ran vs. skipped; the working branch; the single approval recorded
2. per phase: outcome + gate status (met its bar / blocked / skipped)
3. what shipped (PR / rollout) and the end-state validate result (honest)
4. the verified open findings register + the next-move options (fix round / hand-fix / accept-with-risk)
5. the pipeline checkpoint path (durable, resumable record)
