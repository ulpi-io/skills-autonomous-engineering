---
name: converge-loop
description: |
  Use whenever the task is "repeat an action until a measurable condition holds" — fix until tests or
  typecheck pass, clean until a linter is quiet, harden until an audit is dry, add tests until coverage is met
  — and you want it to STOP honestly rather than spin. Triggers on "keep going until it's green", "loop until
  done", until-green / until-dry work. Not for one-shot tasks or unmeasurable goals.
---

# Converge Loop — Codex adapter

This is a **thin Codex adapter**. The canonical methodology — the four-field termination set, the
until-green / until-dry modes, the anti-thrash detectors, and the honest exit classification — lives in
the root skill and is the single source of truth.

## Apply the runtime map first

Read `codex-skills/.shared/codex-runtime.md` and hold to it. It is the binding capability contract: it
names, for every mechanism this loop relies on, the **implemented Codex path** and the **honest degraded
outcome** when Codex cannot do what Claude Code does.

**Codex-specific translation (do NOT present any Claude-only mechanic as an executable Codex operation):**

- Native **`/goal` + `/loop`** and the **`Workflow()`** tool are **Claude-only** — they are NOT
  Codex-runnable. Do not "compile the termination set into `/goal`+`/loop`" on Codex.
- On Codex the loop is driven either **by hand** (you run the check, select one unit, act, re-measure,
  account) or **deterministically** by the pipeline CLI, whose convergence is `convergence-v1` evaluated by
  `autonomous-pipeline/scripts/lib/budget-ledger.mjs` `evaluate()` (runtime map §12). Either way the
  **discipline is unchanged**: declare all four termination fields before looping, fail closed, stop on
  no-progress, and report the delta honestly.
- Never fabricate a green verdict to exit. A capped/stalled loop reports `converged:false` + the open units.

## Delegate to the canonical methodology

Apply the root **`converge-loop`** skill (`converge-loop/SKILL.md`) end to end — Step 0 (pin the
termination set) through Step 4 (terminate and report honestly), its Guardrails, and its Output Contract.
This adapter changes only the *mechanism* (no native goal/loop on Codex), never the *discipline*.
