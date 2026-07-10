---
name: auto-review
description: |
  Codex adapter for the REVIEW phase. Review a change across every dimension at once (correctness,
  security, performance, maintainability, test adequacy, API/contract compatibility), keep only the
  findings that survive an adversarial refute check, and report them severity-labeled and actionable
  (file:line, why, suggested fix). Fails closed: a dimension that did not actually run is a gap, never
  "clean". Thin adapter — it applies the Codex runtime map and delegates to the canonical methodology.
---

# auto-review — Codex adapter (thin)

This is a **thin Codex adapter**. It carries no methodology of its own. It does two things:

1. **Apply the Codex runtime capability map** in [`../.shared/codex-runtime.md`](../.shared/codex-runtime.md).
   That map is the binding, implemented-only contract: it tells you which capabilities are real under
   Codex and, for anything Claude-only, the **honest degraded outcome** to return instead.

2. **Delegate to the canonical methodology** — the root **`auto-review`** skill
   (`auto-review/SKILL.md`). That canonical skill is the single source of truth for the review contract:
   the six review dimensions, dedup, the majority-refute verification every finding must survive, the
   fail-closed gap rule, and the optional bounded fix loop.

## What Codex runs, honestly

- **Fan-out over dimensions** is a **methodology structure**, not a Claude `Workflow()`/`Agent` call.
  Under Codex there is no native multi-agent fan-out primitive — run the review dimensions as bounded,
  independent passes per the runtime map (§3, §4). Do NOT present `Workflow()` or Agent fan-out as a
  Codex operation.
- **Adversarial verification** of findings and the **optional fix loop** follow the deterministic
  convergence/termination stance in the runtime map (§12) — stop-and-report on exhaustion, never a
  fabricated green.
- Any dimension that could not actually run is reported as a **gap** (`gateNotRun`), never as clean.

Follow the root `auto-review` methodology end-to-end; use this file only to stay inside Codex's real
capabilities.
