---
name: auto-test
description: |
  Codex adapter for the TEST phase — raise test health to a green, MEANINGFUL suite: find untested
  behaviors, write real tests, loop-until-green with every test MUTATION-CHECKED; fails closed, never games
  the suite green. Thin adapter: applies the Codex runtime map and delegates to the canonical auto-test
  methodology.
---

# Auto Test — Codex adapter

This is a **thin Codex adapter**. It applies the shared runtime map and delegates the methodology.

## 1. Apply the Codex runtime map

Read and obey **`../.shared/codex-runtime.md`** (the binding, implemented-only capability map) and
**`../.shared/source-layout.md`**. It is normative about what is runnable under Codex and what the
**honest degraded outcome** is otherwise.

Translation for this skill (Claude-only mechanic → honest Codex substitute):

- **No `Workflow()` / `Agent` fan-out.** The canonical auto-test composes `converge-loop` (until-green),
  `adversarial-verify` (mutation check), and `fan-out-work` (parallel gap discovery) over the
  Agent/Workflow runtime. Under Codex those are **not** executable tools. Run the loop **deterministically**:
  detect the runner, write one focused test, mutation-check it by hand (break the code — the test MUST go
  red; restore — it MUST go green), run the suite yourself, and read the real exit code. Convergence /
  termination maps to the budget ledger + `convergence-v1` (runtime map §12); tokens are observe-only.
- **The test-integrity gate is enforced, not advisory.** Under Codex, edits route through the
  `PreToolUse` matcher `Edit|Write|apply_patch` → `auto-test/scripts/guard-test-integrity.sh`, which
  **blocks (exit 2)** a `.skip`/`.only`/suppression added to a test file (runtime map §9/§10). Fail closed.
- **Do not** present `Workflow()`, `ScheduleWakeup`, `RemoteTrigger`, `CronCreate`, or native `/goal`+`/loop`
  as Codex-runnable operations.

## 2. Delegate to the canonical methodology

The single source of truth for WHAT auto-test does — ground the run (scope, runner, baseline, quality
bar), find the gaps, write-and-mutation-check each test, converge to green (or terminate honestly with
named blocked units), de-flake at the root, and the fail-closed report — is the canonical root skill:

**`../../auto-test/SKILL.md`** (delegate: `auto-test`).

Apply that methodology exactly, honoring its `<EXTREMELY-IMPORTANT>` block, its Verification checklist,
and its phase success criteria, executing each step through the Codex substitutes above. Where the
canonical text names a Claude-only mechanism, use the substitute from `../.shared/codex-runtime.md` and
report the honest outcome — never report a red suite as green and never count a test that can't fail.
