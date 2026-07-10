---
name: auto-ship
description: |
  Codex adapter for the SHIP phase. Take verified work to shippable: run the pre-launch gate (final
  validate green, review clean, security/observability/rollback checks) where a gate that did NOT
  actually run is a blocker, never "clean"; then prepare the release (atomic commits, changelog/release
  notes grounded in the real changes, version bump, docs for user-visible/API changes) and open the PR or
  stage the rollout. The deploy itself is gated on explicit human approval. Fails closed — never
  fabricates a green gate to ship. Thin adapter — applies the Codex runtime map and delegates to the
  canonical methodology.
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
