---
name: auto-plan
description: |
  Codex adapter — turn a spec into a self-reviewed DAG of atomic build tasks: each task gets acceptance
  criteria, a disjoint write scope (≤3 files), and a slice-scoped validate; dependencies are wired and
  topologically layered so nothing builds on a missing base; adversarial critics attack the graph until it
  is clean. Runs the deterministic structural gate and writes .ulpi/plans/<name>.json. Explicit-user-only.
  Delegates the methodology to the canonical auto-plan skill and runs it under the Codex runtime map.
---

# Auto Plan — Codex adapter (thin)

This is the **Codex adapter**. It holds no methodology of its own: the canonical contract — the
`<EXTREMELY-IMPORTANT>` rules (ground every task, atomic and independently verifiable, acyclic + layered,
correct dependencies, fail-closed self-review), the phases, and the Output Contract — lives in the root
**`auto-plan/SKILL.md`**. Read and apply that skill in full; this file only maps its runtime to what
Codex can execute.

## 1. Apply the shared runtime map (binding)

Apply **`codex-skills/.shared/codex-runtime.md`** first — the implemented-only capability contract.
Consequences for this adapter:

- **No Claude-only mechanism is a Codex operation.** Where the canonical skill composes the Claude
  `Workflow`/`Agent` fan-out for the self-review critics or native `/goal`+`/loop` convergence, those are
  Claude-Code-only and MUST NOT be invoked or emulated on Codex. Run the adversarial self-review as
  ordinary bounded Codex work; the convergence bound is deterministic (exit when a review pass is clean or
  it stalls), not a native loop primitive.
- **Fail closed.** The self-review exits only when the graph is clean OR it stalls; a stalled review
  reports the specific unresolved defects and never signs off a graph it could not validate.

## 2. The implemented structural gate (real Codex operation)

The DAG's safety properties are deterministic CODE, not prose — run the same gate the canonical skill and
the coordinator preflight run:

```
node auto-plan/scripts/validate-plan.mjs .ulpi/plans/<name>.json
```

Exit 1 = fix the graph and re-run until 0 (acyclicity, topological layer order, intra-layer write-scope
disjointness, ≤3-entry atomicity, ≥2 criteria/task, blocked whole-suite-e2e validates; executable plans
get the hardened id/field/end-state checks). Use `--render` to derive the human-readable markdown view on
demand (never write that twin to disk).

## 3. Delegate

Apply **`auto-plan/SKILL.md`** (canonical) for all phase semantics, guardrails, and the Output Contract.
This adapter changes only the runtime binding; it changes nothing about the methodology. The plan it
produces (`.ulpi/plans/<name>.json`) is the input to the build phase / the `$autonomous-pipeline` adapter.
