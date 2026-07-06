---
name: schedule-recurring-agent
version: 0.1.0
description: |
  Stand up a recurring cron routine for standing work (triage, monitoring, audits, digests): a self-contained IDEMPOTENT brief (each run wakes memory-less and must dedup prior work), a cadence matched to how often work actually arrives, a per-run budget, escalation rules, and a teardown condition. Use for scheduled repeat work — not one-off waits (watch-and-act).
allowed-tools:
  - Bash
  - Read
  - Write
  - CronCreate
  - CronList
  - CronDelete
  - AskUserQuestion
argument-hint: "<the recurring job> [schedule — e.g. 'weekday 9am' or 'hourly']"
arguments:
  - job
when_to_use: |
  Use to create/manage a standing scheduled agent that should run repeatedly on a cadence (daily/weekly/
  hourly cron) with no human kicking it off each time — recurring triage, monitoring, audits, digests. Do
  NOT use for a one-off wait on a signal within the current run (that's watch-and-act), or for work that
  should run once now. Confirm with the user before creating a routine that will take actions on its own.
---

<EXTREMELY-IMPORTANT>
A recurring agent acts unattended, repeatedly, forever — the failure modes compound. Non-negotiable:
1. THE BRIEF IS SELF-CONTAINED AND IDEMPOTENT. Each run wakes with NO memory of prior runs. The task brief
   must carry all its own context (what to do, where, how to report) and be SAFE TO RUN REPEATEDLY —
   deduplicate against prior work (don't re-file the same issue, re-ping the same PR, re-send the same
   digest). A non-idempotent routine spams.
2. EVERY RUN IS BOUNDED. Declare a per-run budget/cap (`budget-guard`) so one invocation can't grind for
   hours or fan out unboundedly. The schedule bounds frequency; the brief bounds each run.
3. CADENCE MATCHES THE WORK. Pick the cron interval from how often the work actually arrives — not "as
   often as possible". Over-frequent routines burn tokens and create noise; too-rare ones miss the window.
4. IRREVERSIBLE ACTIONS STILL ESCALATE. A routine may triage, monitor, and PREPARE, but it does not deploy,
   delete, merge, or send externally-visible messages on its own unless the user explicitly authorized
   that specific action. When in doubt, it produces a draft/report and asks.
5. HAS AN OFF-SWITCH. Define when the routine should stop or tear itself down (job done, N empty runs,
   user cancels). A routine with no teardown condition runs forever for no reason. List/inspect/delete it
   via the cron tools.
6. HONEST, LOW-NOISE REPORTING. Each run reports what it actually did (including "nothing to do") through
   the agreed channel — never fabricates activity, never floods.
</EXTREMELY-IMPORTANT>

# Schedule Recurring Agent

## Overview

Stand up an agent that does a recurring job on a schedule, correctly: a self-contained idempotent brief,
a cadence matched to the work, a per-run bound, clear reporting, an escalation rule for anything
irreversible, and a teardown condition. Getting the brief and the bounds right is what separates a useful
routine from one that spams, grinds, or acts beyond its mandate.

## Phase 0: Confirm it should be a recurring routine

- Is this genuinely RECURRING standing work (arrives repeatedly on its own timeline), or a one-off? A
  one-off wait on a signal is `watch-and-act`; work to do once is just done now.
- Does it act autonomously in a way the user must authorize? Confirm scope (especially any action beyond
  read/report) with `AskUserQuestion` before creating it.

**Success criteria:** confirmed recurring + the autonomy scope the user authorized.

## Phase 1: Write the self-contained, idempotent brief

The brief is what the routine wakes into with zero memory — make it complete and repeat-safe:

- **What to do**, precisely, and where (repo/paths/queries) — no reliance on session context.
- **Idempotency rule** — how it recognizes and skips work already done (a marker label, a state file, a
  "since last run" query, a dedup key). This is the load-bearing part: without it, the routine repeats
  itself every run.
- **Per-run bound** (`budget-guard`) — max items handled, token/time cap, so a busy day can't turn one run
  into a grind.
- **Report + escalate** — the channel it reports through, and the triggers that make it stop-and-ask a
  human instead of acting (irreversible/ambiguous/high-volume).
- **Teardown condition** — when it should stop (job complete, N consecutive empty runs, a date, user
  cancel).

**Success criteria:** a brief a fresh, memory-less agent can execute correctly and repeatedly without
duplicating work or exceeding its mandate.

## Phase 2: Pick the cadence and create the routine

- Choose the cron cadence from the work's real arrival rate: issue triage → weekday mornings; CVE watch →
  weekly; PR babysitting → a few times a day; nightly audit → once daily. Prefer the LEAST frequent
  cadence that still catches the work in time.
- Create it with `CronCreate` (the schedule + the brief). Confirm it registered.

**Success criteria:** the routine is created on a justified cadence; registration confirmed.

## Phase 3: Manage the lifecycle

- List/inspect existing routines (`CronList`) before creating a near-duplicate — extend one rather than
  stacking overlapping schedules.
- When the teardown condition is met (or the user asks), delete it (`CronDelete`). Don't leave dead
  routines running.

**Success criteria:** no duplicate/overlapping routines; completed/cancelled routines are torn down.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The routine will remember what it did last time." | It won't — each run is memory-less. Put an idempotency rule in the brief or it re-does/re-spams every run. |
| "Run it every 15 minutes so nothing's missed." | Over-frequent routines burn tokens and create noise. Match the cadence to how often the work actually arrives. |
| "Let it auto-merge / auto-deploy when it looks good." | Irreversible actions need explicit per-action authorization. A routine prepares and reports; it doesn't pull irreversible triggers unbidden. |
| "No need for a per-run cap, it's a small job." | Small-usually is not small-always. A busy day turns an unbounded run into a grind. Bound every run. |
| "I'll leave it running; it's harmless." | A routine with no teardown runs forever, spending tokens for nothing. Give it an off-switch. |
| "Report only when there's something interesting." | Silent runs hide failures. Report what it did, including 'nothing to do' — just don't flood. |

## Red Flags

- A brief that assumes memory of prior runs (no idempotency/dedup rule).
- A cadence far more frequent than the work arrives.
- A routine authorized to take irreversible actions without explicit per-action sign-off.
- No per-run bound (one run can grind or fan out unboundedly).
- No teardown condition; overlapping duplicate routines accumulating.
- A run that fabricates activity or floods the report channel.

## Guardrails

- Never write a brief that relies on prior-run memory; make it self-contained + idempotent.
- Never over-schedule; match the cron cadence to the work's arrival rate.
- Never let a routine take irreversible/external actions without explicit authorization.
- Never create an unbounded per-run job; declare a per-run cap.
- Never leave a completed/duplicate routine running; tear it down.

## Native goal/loop routing

On Claude Code, a routine's BRIEF should itself be goal-shaped: state the per-run done-condition the
way `/goal` would ("triage every issue opened since the last run; done when each has a label and a
priority"), so each scheduled invocation runs as a bounded goal loop rather than an open-ended prompt.
Routines are the scheduled form; `/loop` is the in-session form; this skill is about choosing and
briefing the former correctly.

## When To Load References

- `budget-guard` (skill) — the per-run bound + escalation contract each invocation enforces.
- `watch-and-act` (skill) — for a one-off in-session wait instead of a standing routine.
- The phase/loop skills (`auto-*`, `converge-loop`, …) — the actual work a routine's brief invokes.

## Output Contract

Report:

1. the routine created — its job, cadence (with the rationale), and the idempotency rule
2. the per-run bound and the report/escalation channel
3. the teardown condition + how to list/cancel it (cron tools)
4. confirmation it registered (or the duplicate it extended instead)
