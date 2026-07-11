---
name: fan-out-work
description: |
  Use when you have (or can cheaply discover) a list of INDEPENDENT items that each need the same multi-step
  treatment and doing them serially wastes wall-clock — audit every module, migrate every call site, test
  every gap, review every changed file. Triggers on "do this to all of them", a broad sweep, a per-file pass
  over a big N. Not for a handful of items or cross-item-dependent work.
---

# fan-out-work — Codex adapter (thin)

This is a **thin Codex adapter**. The authoritative methodology — scout-inline-first, prove independence,
per-item pipeline vs barrier, caps/isolation/retry/drop policy, faithful aggregation, and the
`<EXTREMELY-IMPORTANT>` no-silent-truncation guardrails — lives in the canonical root skill and is the
single source of truth you MUST apply:

- **Canonical methodology:** `fan-out-work/SKILL.md` (the `delegate` target). Follow it verbatim.

## Apply the shared Codex runtime map first

Before acting, apply the binding capability contract in **`../.shared/codex-runtime.md`**. It maps each
capability to its implemented path and honest degraded outcome. For this skill specifically:

- **There is NO native Codex fan-out primitive.** The Claude `Workflow()` tool and the `Agent`-runtime
  `~min(16, cores−2)` concurrency figure are **Claude-only** — do NOT present either as a Codex operation
  and do NOT cite that concurrency cap for a Codex run (`codex-runtime.md` §3, Claude-only table).
- **The Codex substitute is the deterministic coordinator's own fan-out:** within a plan layer the build
  engine spawns one Codex executor child per task, each in a **distinct worktree** (structural isolation),
  awaited as a **layer barrier**, then integrated one-by-one. The real enforced bound on total spawns is
  the budget's `maxCodexCalls` (not a live concurrency cap). Drive it via the deterministic CLI:
  `node autonomous-pipeline/scripts/pipeline.mjs approve|start|resume|status` (`codex-runtime.md` §3/§4).
- **Honesty is non-negotiable:** never silently truncate — a capped/sampled run LOGS what was covered and
  what was skipped; a failed item is a REPORTED null, never a hidden success; writers are isolated.

## What to do

1. Apply `../.shared/codex-runtime.md` (fan-out has no native Codex primitive; use the coordinator +
   worktree isolation, bounded by `maxCodexCalls`).
2. Follow the canonical `fan-out-work/SKILL.md` end to end — scout the list inline, prove independence,
   run each item through the same stages with isolation for writers, and report EVERY item (covered /
   failed / dropped) with no gap between N discovered and N reported.
