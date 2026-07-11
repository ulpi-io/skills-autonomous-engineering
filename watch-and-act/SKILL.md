---
name: watch-and-act
version: 0.2.0
description: |
  Use to wait on EXTERNAL state that changes on its own timeline and the harness won't wake you for — CI or
  build status, a deploy, a remote queue draining, a URL becoming healthy, an approval landing — then act on
  the transition. Triggers on "wait for CI", "watch the deploy", "poll until it's ready/green". Not for
  harness-tracked background work (it re-invokes you automatically), and not for a one-time inline check.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Write
  - Monitor
  - ScheduleWakeup
  - Agent
argument-hint: "<signal to watch — e.g. 'CI on branch X' or 'deploy status'> [until <condition/deadline>]"
arguments:
  - signal
when_to_use: |
  Use to wait on EXTERNAL state that changes on its own timeline and the harness won't wake you for — CI/
  build status, a deployment, a remote queue draining, a URL becoming healthy, an approval landing. Do NOT
  use to poll for harness-tracked background work you started (a background Agent/Task/Workflow re-invokes
  you automatically on completion — polling it is wasted). Do NOT use for a signal you can check once
  inline (just check it).
---

<EXTREMELY-IMPORTANT>
A watcher that polls forever, or polls the wrong thing, is pure waste. Non-negotiable:
1. NEVER POLL HARNESS-TRACKED WORK. Background agents, tasks, and workflows notify you on completion — you
   are re-invoked automatically. Scheduling a wakeup to check them is wasted tokens. Only watch state the
   harness CANNOT see: CI, deploys, remote queues, external endpoints.
2. ALWAYS BOUNDED. Declare a deadline and/or a max-poll count up front. When it's hit without the target,
   STOP and report "not reached in time" — never poll indefinitely.
3. CACHE-AWARE CADENCE. Pick the delay deliberately: 60–270s to stay within the ~5-minute prompt cache
   when ACTIVELY watching a signal that changes in minutes; 1200s+ when idle or the state changes slowly.
   Do NOT pick ~300s (worst of both — pays the cache miss without amortizing it). Match the delay to how
   fast the watched state actually changes.
4. ACT ON THE TRANSITION, HONESTLY. Report the real observed state each check; act on the change (green →
   proceed, red → diagnose). Never assume the signal or fabricate that it flipped.
5. ESCALATE ON TERMINAL FAILURE. A red/errored signal that won't self-resolve is a stop-and-surface, not a
   thing to keep re-polling hoping it turns green.
</EXTREMELY-IMPORTANT>

# Watch and Act

## Inputs

- `$signal`: the external signal to watch (e.g. "CI on branch X", "deploy status"), optionally with
  an `until <condition/deadline>` clause that seeds the bound.

## Overview

Bridge your run to something happening elsewhere: poll an external signal on a sensible cadence, react to
the change, and stop when it resolves or the deadline passes. The discipline is in the cadence (cache-
aware, matched to the signal) and the bound (never forever) — a watcher that gets those wrong wastes cache
and tokens or hangs a run.

## Phase 0: Confirm it's the right thing to watch

Before scheduling anything:

- Is this signal HARNESS-TRACKED? If it's a background Agent/Task/Workflow you started, DON'T watch it —
  you'll be re-invoked on completion. Watching is only for state the harness can't notify you about.
- Can you just check it ONCE right now? If it's already resolved, do that and skip the loop.
- What's the transition you're waiting for, and what do you do on each outcome (green/red/ready/timeout)?

**Success criteria:** confirmed external + not-yet-resolved + a clear act-on-each-outcome plan.

## Phase 1: Set the cadence and the bound

- **Deadline / max polls** (`budget-guard`): how long is it worth waiting? (a CI run ~a few min; a deploy
  ~minutes; a queue ~unknown). Set a hard stop.
- **Delay per poll** — matched to how fast the state changes AND the ~5-min cache window:
  - actively watching a minutes-scale signal → 60–270s (stays in cache);
  - idle / slow-changing / a long fallback heartbeat → 1200–1800s+;
  - never ~300s.
- Estimate the poll count = deadline / delay; if it's huge, the delay is too short — widen it.

**Success criteria:** a deadline and a justified per-poll delay (not ~300s; matched to the signal).

## Phase 2: Poll → observe → act

**Pick the wake mechanism, best-available-first:**

1. **A native wait/monitor capability** (e.g. `Monitor`) — if the harness can block on the external
   condition for you and re-enter on the transition, use it. No cross-turn bookkeeping is needed: the bound
   is the capability's own timeout.
2. **A cross-turn schedule** (`ScheduleWakeup`, or a `/loop`) — when you must yield the turn and be
   re-invoked later. This is where the bound MUST be made durable (below).
3. **No wake capability at all** — do NOT block the run waiting forever. Persist the watch, emit a
   **resumable PENDING report**, and let a later turn (or a human) resume it. Honest degradation beats a hung run.

**When polling crosses a turn, record the bound as DURABLE, ATOMIC state** with
`scripts/watch-state.mjs` (it reuses the checkpoint store's atomic write + lock). A re-invocation lands in a
FRESH process with no memory of when you started or how many times you've polled, so a deadline / max-poll
stop fires honestly ONLY if the absolute deadline and the count live on disk and each cycle reads-then-bumps
them. A relative "wait 30 min" held only in context evaporates on the next wake — and the loop never stops.

```bash
WS=watch-and-act/scripts/watch-state.mjs
# FIRST cycle — REQUIRES an external target + an absolute future deadline + a poll cap + a valid interval.
# REFUSES harness-tracked work (--harness-tracked always errors) and a ~300s dead-zone interval.
node "$WS" init .ulpi/runs/ci-watch.json --target "CI on feat-x" \
  --deadline 2026-07-10T12:00:00Z --max-polls 20 --interval 120
# EACH cycle — one real observation, atomically counted; a terminal outcome can never silently restart.
node "$WS" observe .ulpi/runs/ci-watch.json --state pending --evidence "queued"   # or success | failure
# Decide the next move from the DURABLE state. --wake reflects the capability you actually have; with none
# it returns a resumable PENDING report and NEVER blocks.
node "$WS" next .ulpi/runs/ci-watch.json --wake schedule   # or native | none (default none)
```

Each cycle:

1. **Check** the signal with a real command (`gh run list`/`gh pr checks`, a curl health check, a queue
   depth query) — read the ACTUAL state — and record it with `observe` (evidence + atomic count bump).
2. **Classify** via `next`: reached-target (success) / still-pending / terminal-failure / deadline /
   exhausted. Terminal states are DURABLE — `observe`/`init` refuse to re-open them.
3. **Act** on `next`'s reported action:
   - `proceed` (target reached) → do the follow-up action (next phase, notify, continue the run) and STOP;
   - `schedule-next-poll` (still pending, wake available) → schedule the next check at `intervalSec`
     (re-evaluate the delay if the state's pace changed);
   - `resume-when-woken` (still pending, no wake capability) → emit the resumable PENDING report and STOP
     the current turn — do NOT busy-wait;
   - `diagnose-or-escalate` (terminal failure) → STOP and diagnose/escalate (optionally kick a
     `converge-loop` fix if it's yours to fix, e.g. a red CI you can address);
   - `report-timeout` / `report-exhausted` (deadline / max polls) → STOP and report "not reached in time".

**Success criteria:** each cycle reads the real state, records it durably, and takes the right action; the
loop advances toward a stop and the bound survives a fresh process.

## Phase 3: Report

Report the final observed state, how long/many polls it took, and the action taken (proceeded / diagnosed
/ timed out). If it timed out or failed terminally, say so plainly with the last observed state.

**Success criteria:** an honest account of what the signal did and what you did about it.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll poll my background agent every minute to check progress." | Background work re-invokes you on completion. Polling it is pure waste — just wait for the notification. |
| "I'll check every 5 minutes." | ~300s is the worst delay: it pays the cache miss without amortizing it. Drop to 270s (in-cache) or go 1200s+. |
| "I'll keep polling until it turns green." | Some signals never turn green on their own. Bound it; a terminal failure is a stop-and-diagnose, not infinite retry. |
| "Poll every 10s so I don't miss the moment it flips." | 10s burns cache and tokens for a CI run that takes minutes. Match the delay to the state's real pace. |
| "It's probably green by now." | "Probably" isn't observed. Check the real status; never assume the transition. |
| "There's no wake capability, so I'll just spin/wait in-line until it flips." | Blocking a turn forever is a hung run. `watch-state next` with no wake capability returns a resumable PENDING report — persist and hand off; a later turn resumes from the durable file. |
| "I'll hold the deadline and count in context between wakes." | A re-invocation is a fresh process with no memory. The bound must live on disk (`watch-state.mjs`) and be read-then-bumped each cycle, or the stop never fires. |
| "It errored, but I'll just re-init the watch and try again." | A terminal watch is durable — `init`/`observe` refuse to silently restart it. Diagnose the failure or start a deliberately new watch id; don't re-open a closed one. |

## Red Flags

- A `ScheduleWakeup` scheduled to poll a background Agent/Task/Workflow the harness already tracks.
- No deadline / no max-poll bound on the watch.
- A ~300s delay, or a very short delay on a slow-changing signal.
- The loop re-polling a terminal failure hoping it self-resolves.
- A reported "green" with no actual status check in the transcript.
- A cross-turn watch whose deadline/count lives only in context (evaporates on the next wake).
- Blocking the turn in-line because there's no wake capability, instead of emitting a resumable PENDING report.
- Re-initing a watch over an existing durable one to "restart" a terminal outcome.

## Guardrails

- Never watch harness-tracked background work; only genuinely external signals.
- Never poll unbounded; declare a deadline / max polls.
- Never pick ~300s; keep active polls in-cache (≤270s) or go long (≥1200s), matched to the signal.
- Never assume the signal; read the real state each cycle.
- Escalate a terminal failure instead of re-polling it.
- Never hold a cross-turn bound in context; persist it with `watch-state.mjs` and read-then-bump each cycle.
- Never block a turn forever for want of a wake capability; degrade to a resumable PENDING report.
- Never re-open a terminal watch; a durable outcome is final.

## Native goal/loop routing

On Claude Code, a watch IS a `/loop`: interval = the cadence table above, stop condition = the
deadline/target ("stop when CI on branch X is green, or after 30 min"). For a watch that gates a
larger objective, pair it with `/goal` so the independent verifier confirms the transition actually
happened rather than trusting the actor's report. Prefer a native `Monitor`/wait capability when it can
block on the condition and re-enter for you; `ScheduleWakeup` is the dynamic-pacing form when you're
self-pacing inside a session. On a platform (or in a run) with NO wake capability, don't block —
`watch-state.mjs next` degrades to a resumable PENDING report and the durable file lets a later turn or
a human resume the exact bound.

## When To Load References

- `scripts/watch-state.mjs` — the durable, atomic, resumable cross-turn watch state: `init` (bound +
  refusals), `observe` (atomic count + evidence, terminal-no-restart), `next` (act / schedule /
  resume-when-woken), `status` (read-only dump). Load it whenever a poll must cross a turn.
- `budget-guard` (skill) — the deadline / max-poll bound and the escalation contract.
- `converge-loop` (skill) — when a red signal is yours to fix, the bounded diagnose-and-fix loop.
- `schedule-recurring-agent` (skill) — if the watch should become a standing recurring check rather than a
  one-off wait.

## Output Contract

Report:

1. the signal watched (and confirmation it's external, not harness-tracked)
2. the wake mechanism used (native monitor / scheduled cross-turn / none→resumable-pending) and, for a
   cross-turn watch, the durable state file
3. cadence used (delay + why) and the bound (deadline / max polls)
4. the transition observed and the action taken (proceeded / diagnosed / escalated / timed out /
   handed off a resumable PENDING report)
5. total wait / poll count and the final state
