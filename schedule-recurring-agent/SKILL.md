---
name: schedule-recurring-agent
version: 0.2.0
description: |
  Use when standing work should run repeatedly on a cadence with no human kicking it off each time — recurring
  triage, monitoring, audits, or digests on a daily/weekly/hourly schedule. Triggers on "every morning",
  "check X weekly", "run this on a schedule", "set up a recurring agent / routine / cron". Not for a one-off
  wait within the current run.
allowed-tools:
  - Skill
  - RemoteTrigger
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

## Inputs

- `$job`: the recurring job description, optionally followed by a schedule ("weekday 9am", "hourly")
  that seeds the cadence choice in Phase 2.

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

## Phase 2: Pick the cadence and the mechanism, then create the routine

- Choose the cron cadence from the work's real arrival rate: issue triage → weekday mornings; CVE watch →
  weekly; PR babysitting → a few times a day; nightly audit → once daily. Prefer the LEAST frequent
  cadence that still catches the work in time.
- **Pick the mechanism honestly — this is the load-bearing choice:**
  - **Durable / unattended (the usual case)** — work that must run on its own timeline even while you are
    offline (nightly audits, CVE watch, weekday triage): stand it up as a **claude.ai Routine** via the
    **`/schedule` skill** (backed by the `RemoteTrigger` API). Routines run on Anthropic's infrastructure
    on a cron schedule, persist across sessions, and their runs count against your plan's usage/rate
    limits. This is the ONLY mechanism that actually delivers "runs when no one's kicking it off."
  - **In-session only (the lighter alternative)** — a recurrence you want ONLY while a session stays
    open: `CronCreate`. It is NOT a standing cloud agent — see the constraints below before choosing it.
- Create it, then confirm it registered (`/schedule` list for a Routine; `CronList` for an in-session cron).

### Constraints of each mechanism (state these to the user — they change what "recurring" means)

| | claude.ai Routine (`/schedule` · `RemoteTrigger`) | In-session cron (`CronCreate`) |
|---|---|---|
| Runs while you're offline | **Yes** — on Anthropic infra | **No** — only while this session's REPL is idle |
| Survives closing Claude | **Yes** — persistent | **No** — in-memory; gone when the session exits |
| Lifetime | until you disable/remove it | **auto-expires after 7 days** (one final fire, then deleted) |
| Per-run token budget | **no native cap** — bound via brief + `budget-guard`; runs count against plan usage | same — no native cap |

There is NO native per-run token budget on either — the per-run bound is enforced by the brief +
`budget-guard`, not a platform parameter.

**Success criteria:** created on the mechanism that matches its durability need, on a justified cadence;
registration confirmed; the mechanism's constraints stated to the user.

## The validated job schema (the gate)

Both the brief (Phase 1) and the creation (Phase 2) are enforced deterministically by
`scripts/validate-job.mjs` — the guardrails above are mechanically checkable, so they do NOT ship as
prose only. A recurring job is a JSON object that MUST declare all nine fields; missing/empty any → the
gate exits nonzero and names it:

| Field | What it pins | Shape |
|---|---|---|
| `key` | a STABLE idempotency + registration key (dedup and the automation id are built from it) | `[A-Za-z0-9][A-Za-z0-9_-]*` |
| `repo` | where it operates — no reliance on session context | string |
| `cadence` | a TIMEZONE-anchored recurrence (a cron with no tz drifts) | `{ timezone, cron\|expression }` |
| `prompt` | the self-contained brief a memory-less run executes | string (≥ 20 chars) |
| `dedup` | the idempotency rule — marker/state/since-query so repeats don't re-file/re-spam | string or object |
| `perRunCap` | a POSITIVE per-run bound so one run can't grind or fan out | `{ maxItems\|maxTokens\|maxMinutes\|maxActions }` or a positive number |
| `reporting` | the channel each run reports through (incl. "nothing to do") | string or object |
| `escalation` | the stop-and-ask rule for irreversible/ambiguous/high-volume work | string or object |
| `teardown` | the off-switch (job done, N empty runs, a date, user cancel) | string or object |

```
node schedule-recurring-agent/scripts/validate-job.mjs validate <job.json>
```

## The capability ladder (honest creation — never a false registration)

Creation runs through the same gate in `create` mode, and the ORDER is load-bearing:

```
node schedule-recurring-agent/scripts/validate-job.mjs create <job.json> \
  [--capability RemoteTrigger|CronCreate] [--authorize] [--existing <registry.json>]
```

1. **Validate the schema.** Invalid → `created:false`, exit 2, nothing registered.
2. **List + DEDUP FIRST.** Before any capability check, the job's `key` is looked up in the registry. A
   match is a correct idempotent NO-OP (`created:false`, `reason:duplicate`, the existing id echoed, exit
   0) — a re-run never stacks a second routine. This is why the key must be stable.
3. **Capability + authorization.** A verifiable automation id (`<capability>:<key>`) is minted ONLY when
   a SUPPORTED capability AND explicit `--authorize` are both present:
   - `RemoteTrigger` — durable claude.ai Routine (the `/schedule` skill). **Claude Code only.**
   - `CronCreate` — in-session cron. **Claude Code only.**
   - **anything else (Codex, plain CLIs) → NO capability.** The gate returns `created:false`,
     `registered:false`, exit 3, and a **ready brief** for manual/other-platform registration. It NEVER
     claims a RemoteTrigger/CronCreate registration on a platform that has neither — it degrades and says
     so. Missing `--authorize` on a supported platform degrades the same way.
4. **On success** the id is appended to the `--existing` registry, so a later list/create sees it — the
   id is VERIFIABLE, not invented.

## Phase 3: Manage the lifecycle

- List/inspect existing routines before creating a near-duplicate — extend one rather than stacking
  overlapping schedules (`/schedule` list for claude.ai Routines; `CronList` for in-session crons).
- When the teardown condition is met (or the user asks), tear it down (disable/remove via `/schedule`
  for a Routine; `CronDelete` for an in-session cron). Don't leave dead routines running.

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

- `scripts/validate-job.mjs` — the deterministic job-schema + honest-creation gate (run it in `validate`
  mode on the brief, in `create` mode to stand the routine up dedup-first with a verifiable id).
- `budget-guard` (skill) — the per-run bound + escalation contract each invocation enforces.
- `watch-and-act` (skill) — for a one-off in-session wait instead of a standing routine.
- The phase/loop skills (`auto-*`, `converge-loop`, …) — the actual work a routine's brief invokes.

## Output Contract

Report:

1. the routine created — its job, cadence (with the rationale), the MECHANISM (claude.ai Routine vs
   in-session cron) and why, and the idempotency rule
2. the per-run bound and the report/escalation channel
3. the teardown condition + how to list/cancel it (via `/schedule` for a Routine, or the cron tools for
   an in-session cron)
4. confirmation it registered (or the duplicate it extended instead)
