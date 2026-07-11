---
name: auto-performance
description: |
  Use when there is a performance requirement, a latency/throughput target, or a suspected regression and you
  want to optimize the RIGHT thing, proven by measurement. Triggers on "make it faster", a slow
  endpoint/page/query, a perf budget, "is this a regression", profiling. Not for a guessed "should be faster"
  with no benchmark.
---

# auto-performance — Codex adapter (thin)

This is a **thin Codex adapter**. It carries no methodology of its own. It does two things:

1. **Apply the Codex runtime capability map** in [`../.shared/codex-runtime.md`](../.shared/codex-runtime.md).
   That map is the binding, implemented-only contract for what Codex can actually do, and the honest
   degraded outcome for anything it cannot.

2. **Delegate to the canonical methodology** — the root **`auto-performance`** skill
   (`auto-performance/SKILL.md`). That canonical skill is the single source of truth: metric +
   reproducible baseline first, profile to the real hotspots, per-hotspot benchmark-gated accept/revert,
   correctness held, stop at target or diminishing returns.

## What Codex runs, honestly

- The measure → profile → change → re-benchmark loop is **methodology**, driven with Codex's real
  execution and editing (Bash/Read/Edit). Its convergence and termination follow the deterministic
  stance in the runtime map (§12): stop-and-report at the target, at diminishing returns, or on budget
  exhaustion — never a fabricated win.
- No optimization is accepted on assertion: a change is kept **only** when the benchmark proves it faster
  beyond variance with correctness intact, else it is reverted.
- Do NOT present any Claude-only mechanism (`Workflow()`, native `/goal`+`/loop`) as a Codex operation;
  use the substitutes named in the runtime map.

Follow the root `auto-performance` methodology end-to-end; use this file only to stay inside Codex's real
capabilities.
