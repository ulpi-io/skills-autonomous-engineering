---
name: auto-simplify
description: |
  Use when code works but reads worse than it should — duplication, dead code, over-abstraction, a tangled
  diff or messy module you want clarified WITHOUT changing behavior. Triggers on "clean this up", "simplify",
  "reduce complexity", "make it readable", a post-build tidy. Not for changing behavior, fixing bugs, or
  optimizing speed.
---

# Auto Simplify — Codex adapter

This is a **thin Codex adapter**. It applies the shared runtime map and delegates the methodology.

## 1. Apply the Codex runtime map

Read and obey **`../.shared/codex-runtime.md`** (the binding, implemented-only capability map) and
**`../.shared/source-layout.md`**. It is normative about what is runnable under Codex and what the
**honest degraded outcome** is otherwise.

Translation for this skill (Claude-only mechanic → honest Codex substitute):

- **No `Workflow()` / `Agent` fan-out.** The canonical auto-simplify composes `converge-loop` (until-dry)
  and `adversarial-verify` (behavior-preservation gate) over the Agent/Workflow runtime. Under Codex those
  are **not** executable tools. Run the loop **deterministically**: apply the smallest edit, run the
  relevant tests yourself, do the adversarial semantic diff against the recorded baseline snapshot, and
  **REVERT** anything not provably behavior-preserving. The convergence/termination discipline maps to the
  budget ledger + `convergence-v1` (runtime map §12) — stop when a round is dry or it stalls; never spin.
- **Do not** present `Workflow()`, `ScheduleWakeup`, `RemoteTrigger`, `CronCreate`, or native `/goal`+`/loop`
  as Codex-runnable operations. Tokens are observe-only (no hard ceiling; runtime map §6).

## 2. Delegate to the canonical methodology

The single source of truth for WHAT auto-simplify does — scope + green baseline + behavior snapshot,
finding behavior-neutral simplifications, the one-edit-at-a-time prove-or-revert loop, Chesterton's Fence,
and the honest kept/kept-on-purpose/reverted report — is the canonical root skill:

**`../../auto-simplify/SKILL.md`** (delegate: `auto-simplify`).

Apply that methodology exactly, honoring its `<EXTREMELY-IMPORTANT>` block and phase success criteria,
executing each step through the Codex substitutes above. Where the canonical text names a Claude-only
mechanism, use the substitute from `../.shared/codex-runtime.md` and report the honest outcome — never
keep an unverified edit and never fabricate a behavior-preserving verdict.
