---
name: auto-build
description: |
  Codex adapter for the BUILD phase — implement an approved DAG plan autonomously, one clean commit per
  task, test-first, never building on a broken base. Requires an approved plan + clean git baseline. Thin
  adapter: it applies the Codex runtime map and delegates to the canonical auto-build methodology.
---

# Auto Build — Codex adapter

This is a **thin Codex adapter**. It does not restate the methodology; it points Codex at the two things
it needs.

## 1. Apply the Codex runtime map

Before doing anything, read and obey **`../.shared/codex-runtime.md`** (the binding, implemented-only
capability map) and **`../.shared/source-layout.md`**. That map is normative: it tells you which
capabilities are actually runnable under Codex and what the **honest degraded outcome** is when one is not.

Translation for this skill (Claude-only mechanic → honest Codex substitute):

- **No `Workflow()` / `Agent` fan-out.** The Claude auto-build SKILL.md composes `fan-out-work`,
  `converge-loop`, `adversarial-verify` and drives layers with the Agent/Workflow runtime. Under Codex
  those primitives do **not** exist as executable tools. The implemented substitute is the **deterministic
  pipeline/build coordinator**: `node autonomous-pipeline/scripts/pipeline.mjs approve|start|resume|status|authorize`
  (per-task Codex children, worktree isolation, layer barrier, budget ledger, one-use approval). Do not
  present `Workflow()`, `ScheduleWakeup`, `RemoteTrigger`, `CronCreate`, or native `/goal`+`/loop` as
  Codex-runnable operations.
- **Budgets are observe-only for tokens.** A hard token ceiling is rejected; `maxCodexCalls` / wall-clock /
  attempt caps are the enforced termination set (see runtime map §6/§12).
- **The one human gate (plan approval)** is the one-use, interactive-operator-only capability from
  `authorization.mjs` (runtime map §7) — a non-interactive/child invocation is refused, never auto-chained.

## 2. Delegate to the canonical methodology

The single source of truth for WHAT auto-build does — preflight, the one approval gate, the per-task
build contract (RED→GREEN→REFACTOR, integrate, slice-scoped review, bounded fix loop, per-task commit),
the stop-and-ask triggers, and the fail-closed final validate — is the canonical root skill:

**`../../auto-build/SKILL.md`** (delegate: `auto-build`).

Apply that methodology exactly, honoring its `<EXTREMELY-IMPORTANT>` block and phase success criteria,
but execute every step through the Codex-implemented substitutes above. Where the canonical text names a
Claude-only mechanism, use the substitute from `../.shared/codex-runtime.md` and report the honest
outcome — never fabricate a green verdict or an emulated orchestration.
