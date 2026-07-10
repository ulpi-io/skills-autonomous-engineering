---
name: auto-spec
description: |
  Codex adapter — turn a raw feature request into a grounded, TESTABLE spec: recon the real repo/domain to
  ground every claim, draft the spec, then run an adversarial completeness-critic loop until stable, and
  write .ulpi/spec/<name>.md. The DEFINE phase that feeds auto-plan. Explicit-user-only. Delegates the
  methodology to the canonical auto-spec skill and runs it under the Codex runtime map.
---

# Auto Spec — Codex adapter (thin)

This is the **Codex adapter**. It holds no methodology of its own: the canonical contract — the
`<EXTREMELY-IMPORTANT>` rules (ground every requirement, every acceptance criterion testable, explicit
non-goals, surface-don't-guess, fail-closed completeness), the four phases (intake → recon → draft →
critic loop → finalize), and the Output Contract — lives in the root **`auto-spec/SKILL.md`**. Read and
apply that skill in full; this file only maps its runtime to what Codex can execute.

## 1. Apply the shared runtime map (binding)

Apply **`codex-skills/.shared/codex-runtime.md`** first — the implemented-only capability contract.
Consequences for this adapter:

- **No Claude-only mechanism is a Codex operation.** Where the canonical skill composes the Claude
  `Workflow`/`Agent` fan-out for recon, native `/goal`+`/loop` convergence, or `ScheduleWakeup`, those are
  Claude-Code-only and MUST NOT be invoked or emulated on Codex. Run recon and the critic loop as ordinary
  sequential/bounded Codex work instead — the convergence bound is deterministic (stop when a round is dry
  or it stalls), not a native loop primitive.
- **Fail closed on completeness.** The critic loop exits only when no material gap remains OR it stalls;
  a stalled loop reports the open gaps and never claims a "looks complete" it did not earn. Never fabricate
  a clean verdict to exit.

## 2. Delegate

Apply **`auto-spec/SKILL.md`** (canonical) for all phase semantics, guardrails, and the Output Contract.
This adapter changes only the runtime binding; it changes nothing about the methodology. The spec it
produces (`.ulpi/spec/<name>.md`) is the input to the `$auto-plan` adapter.
