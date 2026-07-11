---
name: auto-ship
description: |
  Use when a change is already built, tested, and reviewed and you want it taken to shippable — release gates
  run, changelog/version/docs prepared, PR opened or a rollout staged. Triggers on "ship it", "cut a release",
  "open the PR", "prepare the deploy". Explicit-user-only; never deploys anything irreversible without human
  sign-off.
---

# auto-ship — Codex adapter (thin)

This is a **thin Codex adapter**. It carries no methodology of its own. It does two things:

1. **Apply the Codex runtime capability map** in [`../.shared/codex-runtime.md`](../.shared/codex-runtime.md).
   That map is the binding, implemented-only contract, including the honest human-approval and
   fail-closed-gate behavior Codex must return.

2. **Delegate to the canonical methodology** — the root **`auto-ship`** skill (`auto-ship/SKILL.md`).
   That canonical skill is the single source of truth: the pre-launch gate set, the fail-closed
   gate-didn't-run-is-a-blocker rule, atomic commits, grounded changelog/release notes, version bump,
   docs, PR/rollout staging, and the human sign-off on anything irreversible.

## What Codex runs, honestly

- The **pre-launch gate** is fail-closed: a gate that did not actually run is reported as `gateNotRun`
  and treated as a **blocker**, never as clean. No green is ever fabricated to ship.
- **Human approval for irreversible actions** follows the runtime map's approval contract (§7): approval
  is a one-use, interactive-operator capability. A non-interactive / piped / child context is **refused**
  — Codex does not auto-approve a deploy.
- Do NOT present any Claude-only mechanism (`Workflow()`, `RemoteTrigger`, `CronCreate`) as a Codex
  operation; the deterministic pipeline CLI and honest degraded outcomes in the runtime map are the
  substitutes.

Follow the root `auto-ship` methodology end-to-end; use this file only to stay inside Codex's real
capabilities.
