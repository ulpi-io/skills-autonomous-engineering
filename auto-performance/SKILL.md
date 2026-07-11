---
name: auto-performance
version: 0.1.0
disable-model-invocation: true
user-invocable: true
description: |
  Use when there is a performance requirement, a latency/throughput target, or a suspected regression and you
  want to optimize the RIGHT thing, proven by measurement. Triggers on "make it faster", a slow
  endpoint/page/query, a perf budget, "is this a regression", profiling. Not for a guessed "should be faster"
  with no benchmark.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Agent
  - Workflow
effort: high
argument-hint: "[target — endpoint/function/page/metric, or a perf budget] (default: profile to find it)"
arguments:
  - target
when_to_use: |
  Use when there's a performance requirement or a suspected regression and you want to optimize the RIGHT
  thing, proven by measurement. Do NOT use to add features, fix functional bugs (auto-build), or do
  behavior-neutral readability cleanups (auto-simplify); and do NOT "optimize" without a benchmark — an
  unmeasured change is a guess, and guesses here routinely make things slower or wronger.
---

<EXTREMELY-IMPORTANT>
Optimization without measurement is superstition, and optimization that breaks correctness is a
regression. Non-negotiable:
1. MEASURE FIRST. Establish the metric + a reproducible baseline benchmark BEFORE any change. No baseline
   → no optimization; you can't improve what you haven't measured.
2. PROFILE, DON'T GUESS. Target the hotspots the profiler shows, not the ones intuition suggests. Most
   guessed bottlenecks aren't; optimizing a non-hotspot adds complexity for no gain.
3. BENCHMARK-GATED ACCEPT. Keep a change ONLY if a re-benchmark shows a REAL improvement (beyond
   run-to-run variance, apples-to-apples: same input, same warm/cold state). "Looks faster" / "should be
   faster" is never acceptance — REVERT anything unproven.
4. NO CORRECTNESS REGRESSION. Every kept optimization must pass the full relevant test suite AND an
   adversarial regression check (edge cases the speedup might have changed). A faster wrong answer is a
   bug, not a win.
5. STOP AT DIMINISHING RETURNS. When the target is met, or the remaining gains are small relative to the
   complexity they cost, STOP — don't keep trading readability for microseconds.
6. FAIL CLOSED. Report real measured deltas. Never claim an improvement you didn't measure.
</EXTREMELY-IMPORTANT>

# Auto Performance

## Overview

Turn "make it faster" into a disciplined, measured loop: define the metric, baseline it, profile to the
real hotspots, and improve them one at a time — each improvement earning its place with a before/after
number and a clean correctness check, or getting reverted. The measurement gate is the whole point: it's
what separates real optimization from complexity-adding cargo-culting.

## Phase 0: Define the metric and baseline it (measure first)

- Pin the METRIC to the target: latency (p50/p95/p99), throughput, memory/allocations, bundle size, or a
  web vital (LCP/CLS/INP) — with a numeric target if one exists (from the spec or a budget).
- Build a REPRODUCIBLE benchmark for it: fixed input, controlled warm/cold state, enough iterations to see
  past variance. Record the baseline (with its variance/spread — a single number isn't enough).
- Open a `checkpoint-resume` run.

**Success criteria:** a metric, a numeric target (or "reduce X"), and a reproducible baseline with known
variance.

## Phase 1: Profile to the real hotspots

- Run a profiler / measurement appropriate to the stack (CPU/alloc profiler, query logs, flame graph,
  bundle analyzer, DevTools performance trace). Identify where the time/memory actually goes.
- Rank hotspots by contribution to the metric. Ignore cold paths — optimizing them is wasted complexity.
- For each hotspot, note the likely class (algorithmic complexity, N+1/roundtrips, needless allocation,
  blocking I/O, re-render/re-compute, oversized payload).

**Success criteria:** a ranked list of the hotspots that actually move the metric, each with a suspected
cause.

## Phase 2: Optimize one hotspot, prove it (converge, benchmark-gated)

Run `converge-loop` toward the target; per hotspot (highest-impact first):

1. **Hypothesize** the change and the expected effect on the metric.
2. **Apply** the smallest optimization that tests the hypothesis.
3. **Re-benchmark** and **verify** (`adversarial-verify`, two lenses):
   - **measurement lens** — is the delta real (beyond variance, apples-to-apples)? or noise / a broken
     benchmark?
   - **regression lens** — does the full relevant test suite still pass? does any edge case now behave
     differently (the classic "optimized the happy path, broke the boundary")?
4. **Accept or revert** — keep ONLY if the improvement is real AND correctness holds. Otherwise revert and
   record why (no gain / regressed / not worth the complexity). Update the checkpoint.

Exit when the target is met, or when the remaining hotspots offer gains too small to justify their
complexity cost.

**Success criteria:** each kept change has a measured before/after and a clean correctness check; unproven
changes are reverted.

## Phase 3: Report

Close the checkpoint and report: baseline → final metric (with the real delta and variance), the
optimizations kept (each with its measured gain), the ones tried-and-reverted (why), and whether the
target was met or where it stalled and why.

**Success criteria:** an honest, measured account — no claimed gain lacks a number.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "This is obviously the bottleneck, optimize it." | Obvious bottlenecks are usually wrong. Profile — optimizing a non-hotspot adds complexity for zero gain. |
| "It should be faster now, ship it." | "Should be" isn't measured. Re-benchmark; if the delta isn't real (beyond variance), revert. |
| "It's a bit faster and the tests pass, good enough." | A tiny gain that costs real readability/complexity may be a net loss. Weigh the gain against the complexity; stop at diminishing returns. |
| "The happy path is faster." | And did an edge case break? A faster wrong answer is a regression. Run the regression lens. |
| "Micro-optimize every function." | Cold-path micro-opts add complexity with no metric impact. Optimize hotspots only. |
| "One benchmark run showed improvement." | One run is noise. Use enough iterations and compare against variance before believing the delta. |

## Red Flags

- A change accepted with no before/after measurement.
- Optimizing code the profiler didn't flag as hot.
- A benchmark that isn't apples-to-apples (different input, warm vs cold, changed between runs).
- Correctness tests not re-run after an optimization (or a subtle edge-case behavior change ignored).
- Claimed speedups within run-to-run variance.
- Complexity piled on for sub-threshold gains past the target.

## Guardrails

- Never optimize without a baseline; never accept a change without a re-benchmark showing a real delta.
- Never optimize a non-hotspot; profile first.
- Never keep an optimization that regresses correctness; revert on any behavioral change.
- Never claim an unmeasured improvement.
- Stop at the target / diminishing returns — don't trade clarity for noise-level gains.

## When To Load References

- `converge-loop` (skill) — the optimize-toward-target loop with termination + anti-thrash.
- `adversarial-verify` (skill) — the measurement + regression lenses that gate each accept.
- `checkpoint-resume` (skill) — durable perf-run state.
- `auto-test` (skill) — ensure a correctness safety net exists before optimizing under-covered code.

## Output Contract

Report:

1. metric + target; baseline (with variance) → final (with the real delta)
2. optimizations kept — each with its measured gain and the hotspot it addressed
3. optimizations tried and reverted — with why (no gain / noise / regression / not worth complexity)
4. target met, or where it stalled and the reason
