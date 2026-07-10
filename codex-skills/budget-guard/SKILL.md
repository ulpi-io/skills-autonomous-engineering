---
name: budget-guard
description: |
  Codex adapter for the budget-guard methodology — before any unattended loop or workflow, declare the
  five stop conditions (done-condition, hard cap, token/time budget, no-progress rule, escalation triggers)
  and hold the run to them, stopping the instant one fires. Fails closed: a capped run reports an honest
  partial, never fabricated success. Load at the start of ANY unattended run. Thin adapter: delegates.
---

# Budget Guard — Codex adapter

This is a **thin Codex adapter**. The canonical methodology — the five stop conditions, sizing them to the
task/directive, enforcing them every iteration, and exiting honestly (done / capped / over-budget /
escalated) — lives in the root skill and is the single source of truth.

## Apply the runtime map first

Read `codex-skills/.shared/codex-runtime.md` and hold to it. It is the binding capability contract naming
the implemented Codex path and honest degraded outcome for every mechanism this skill relies on.

**Codex-specific translation (do NOT present any Claude-only mechanic as an executable Codex operation):**

- Native **`/goal` + `/loop`** are **Claude-only** — not Codex-runnable. Do not "compile the stop
  conditions into `/goal`+`/loop`" on Codex.
- On Codex the termination set is enforced by the deterministic
  `autonomous-pipeline/scripts/lib/budget-ledger.mjs` (runtime map §6/§12): `reserve()` atomically refuses
  when a `maxCodexCalls` / wall-clock / attempt limit is exhausted, and `evaluate()` drives
  `convergence-v1`. **Honest token stance:** Codex has **no pre-turn hard token ceiling** — a requested
  token ceiling is *rejected*, tokens are **observed and reported, never enforced**. Size the hard cap on
  iterations/agents/wall-clock instead, and never claim a token bound the surface cannot keep.
- **Escalation triggers** (irreversible ops, ambiguous spec, repeated stall, near-budget) are STOP-and-ask
  points; on Codex, approval is a one-use hash-bound capability minted only by an interactive operator
  (runtime map §7). Never raise your own cap to keep going — re-scoping is the user's decision.

## Delegate to the canonical methodology

Apply the root **`budget-guard`** skill (`budget-guard/SKILL.md`) end to end — Phase 0 (size the budget)
through Phase 2 (exit honestly), its Rationalizations/Red-Flags tables, Guardrails, and Output Contract.
This adapter changes only the *mechanism* (no native goal/loop on Codex; tokens observed not enforced),
never the *discipline*.
