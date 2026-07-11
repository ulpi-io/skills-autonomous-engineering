---
name: adversarial-verify
description: |
  Use when you're about to act on something an agent claimed but did not prove — before fixing a reported bug,
  committing a refactor, trusting a "no vulnerabilities" / "safe to merge" verdict, or accepting a benchmark
  "win" — and getting it wrong would be expensive or hard to reverse. Triggers on unverified findings, "should
  be fine", "looks clean", a single-source assertion about to drive a mutation.
---

# Adversarial Verify — Codex adapter

This is a **thin Codex adapter**. The canonical methodology — refutable propositions, panel sizing (N +
lenses), the independent adversarial run, and the fail-closed majority-refute tally — lives in the root
skill and is the single source of truth.

## Apply the runtime map first

Read `codex-skills/.shared/codex-runtime.md` and hold to it. It is the binding capability contract that
names the implemented Codex path and the honest degraded outcome for every mechanism this skill relies on.

**Codex-specific translation (do NOT present any Claude-only mechanic as an executable Codex operation):**

- The **`Workflow()`** tool and Claude's **`Agent`** fan-out primitive are **Claude-only** — not
  Codex-runnable. Do not spawn a Claude `parallel()` panel on Codex.
- On Codex the skeptic panel is realized by the **deterministic coordinator's** per-task Codex children in
  isolated worktrees (runtime map §3), or run **sequentially/by hand** as independent refuters. Whichever
  the surface supports, the **rules are unchanged**: each verifier gets ground truth (code/diff/repro),
  is told to REFUTE (default-to-refuted on uncertainty), and the claimant never sits on its own panel.
- **Fail closed.** Ties, abstentions, and dead/timed-out verifiers count as rejection (a "clean/safe"
  claim that can't clear the bar is treated as NOT clean). Never upgrade an unproven claim to verified.

## Delegate to the canonical methodology

Apply the root **`adversarial-verify`** skill (`adversarial-verify/SKILL.md`) end to end — Step 1 (frame a
refutable proposition) through Step 5 (return survivors + the rejection ledger), its Guardrails, and its
Output Contract. This adapter changes only the *mechanism* (no Claude Workflow/Agent panel on Codex),
never the *discipline*.
