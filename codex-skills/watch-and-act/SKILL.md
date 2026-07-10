---
name: watch-and-act
description: |
  Codex adapter for waiting on an EXTERNAL signal (CI, deploy, queue, endpoint) on a cache-aware cadence,
  bounded by a deadline, acting on the transition — with a durable, resumable watch state when polling must
  cross a turn. Delegates to the canonical methodology.
---

# watch-and-act — Codex adapter (thin)

This is a **thin Codex adapter**. The authoritative methodology — the cache-aware cadence table
(≤270s active, ≥1200s idle, never ~300s), the mandatory bound, act-on-the-transition, escalate-on-terminal,
and the `<EXTREMELY-IMPORTANT>` guardrails — lives in the canonical root skill and is the single source of
truth you MUST apply:

- **Canonical methodology:** `watch-and-act/SKILL.md` (the `delegate` target). Follow it verbatim.

## Apply the shared Codex runtime map first

Before acting, apply the binding capability contract in **`../.shared/codex-runtime.md`**. For this skill:

- **Durable watch state is Codex-native here.** When a poll crosses a turn, persist the ORIGINAL bound
  (absolute deadline + poll cap + interval) with the real Codex-runnable CLI, and read-then-bump it each
  cycle so a fresh process still stops honestly:
  - `node watch-and-act/scripts/watch-state.mjs init|observe|next|status …` — atomic, terminal-no-restart;
    `init` REFUSES harness-tracked work and a ~300s dead-zone interval; `next` returns the action.
- **Do NOT present a Claude-only wake mechanic as a Codex operation.** `Monitor`, `ScheduleWakeup`, and a
  native `/goal`+`/loop` are **Claude-only** — never claim them as executable Codex wakes. On Codex there
  is **no wake capability**: call `watch-state.mjs next --wake none`, which returns a **resumable PENDING
  report** and NEVER blocks the turn. Honest degradation beats a hung run (`codex-runtime.md` §8, Claude-only table).
- Never watch harness-tracked background work; never poll unbounded; read the REAL state each cycle.

## What to do

1. Apply `../.shared/codex-runtime.md` (durable watch-state CLI is Codex-native; no native Codex wake —
   degrade to a resumable PENDING report, do not block).
2. Follow the canonical `watch-and-act/SKILL.md` end to end — confirm the signal is external and not yet
   resolved, set a deadline + cache-aware cadence, poll → observe → act on the transition, and report the
   honest final state (proceeded / diagnosed / timed out / handed off a resumable PENDING report).
