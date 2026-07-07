---
name: auto-simplify
version: 0.1.0
disable-model-invocation: true
user-invocable: true
description: |
  Reduce a change's complexity WITHOUT changing behavior, provably: find duplication/dead code/over-abstraction in the diff, apply the smallest clarifying edit, then prove behavior preserved (tests green + adversarial semantic check) or REVERT — looping until dry. Respects Chesterton's Fence: never removes code whose purpose isn't established. Use when code works but reads worse than it should.
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
argument-hint: "[scope — a diff, path, or module] (default: the current diff)"
arguments:
  - scope
when_to_use: |
  Use when code works but is harder to read or maintain than it should be — after a build, on a messy
  module, or to pay down a specific bit of complexity. Do NOT use to change behavior, fix bugs, add
  features, or optimize for speed (that's auto-build / auto-performance); simplification that alters
  observable behavior is a refactor gone wrong, not a simplification.
---

<EXTREMELY-IMPORTANT>
Simplification that changes behavior is a bug you introduced on purpose. Non-negotiable:
1. BEHAVIOR IS PRESERVED, PROVABLY. Every edit keeps observable semantics identical. Proof = the full
   relevant test suite still passes AND an adversarial check finds no behavioral difference. Anything not
   provably behavior-preserving is REVERTED, not kept.
2. CHESTERTON'S FENCE. Never remove or collapse code whose purpose you haven't established. "I don't see
   why this is here" is a reason to investigate, not to delete. If you can't explain what it guards,
   leave it and flag it.
3. SMALLEST CLARIFYING EDIT. One simplification at a time, each independently verified. Never a broad
   rewrite "to clean it all up" — that erases the behavior-preservation signal and smuggles in changes.
4. CLARITY OVER CLEVERNESS. The goal is code the next reader understands fastest — not the fewest lines
   or the most abstraction. A clever one-liner that's harder to read is not a simplification.
5. FAIL CLOSED. The loop ends when a round finds nothing worth simplifying (dry) OR it stalls. It never
   reports "simplified" for edits it couldn't verify behavior-preserving.
</EXTREMELY-IMPORTANT>

# Auto Simplify

## Overview

Make code easier to read and maintain while keeping exactly what it does — driven by an until-dry loop
where every edit must pass through a behavior-preservation gate before it counts. The discipline is what
makes it safe: simplification is the one refactor most likely to quietly change semantics, so each change
is minimal, verified, and reverted-on-doubt.

## Phase 0: Scope, baseline, safety net

- Resolve scope (`$scope` — the diff by default; a path/module otherwise).
- Establish the behavior baseline: the relevant tests are GREEN before you touch anything (if there are no
  tests around the target, that's a gap — consider `auto-test` first, or characterize behavior before
  simplifying). In pipeline order this net already exists: `auto-build` lands a test with every task,
  which is exactly why simplify runs after build. Record a snapshot of observable behavior for the target (inputs→outputs, key side effects).
- Open a `checkpoint-resume` run.

**Success criteria:** scope fixed; a green baseline + behavior snapshot exist as the safety net.

## Phase 1: Find simplification opportunities

Scan the scope for complexity that adds no behavior (prioritize by reader-cost):

- **duplication** — the same business logic in multiple places (DRY it — but not test DAMP);
- **dead code** — unreachable branches, unused exports/vars, commented-out blocks, debug output;
- **over-abstraction** — indirection/generalization with a single caller; a factory for one product;
- **tangled control flow** — deep nesting, redundant conditionals, boolean thickets that a guard clause or
  early return would flatten;
- **naming/structure** — names or shapes that hide intent (fixable without behavior change).

For each, apply Chesterton's Fence: establish WHY it exists before proposing to remove/collapse it.

**Success criteria:** a prioritized list of concrete, behavior-neutral simplifications, each with its
purpose understood.

## Phase 2: Simplify one thing, prove behavior preserved (converge until dry)

Run `converge-loop` in until-dry mode; per opportunity:

1. **Apply** the smallest clarifying edit.
2. **Prove behavior-preserving** (`adversarial-verify`, regression lens): run the relevant tests — still
   green? Then an adversarial check: does the edit change ANY observable output, side effect, error, or
   edge-case behavior vs. the baseline snapshot? Consider the inputs a naive reader wouldn't (nulls,
   empties, boundaries, concurrency). If any behavioral difference is found or suspected → **REVERT**.
3. **Keep or revert** — keep only verified-neutral edits; a reverted one is recorded, not retried
   identically.

Re-scan; exit when a round finds nothing more worth simplifying (dry) or it stalls.

**Success criteria:** each kept edit is verified behavior-preserving; the suite is green; no unverified
edit remains.

## Phase 3: Report

Close the checkpoint and report: what was simplified (and the reader-cost it removed), what was
investigated-and-kept (Chesterton's Fence — with the purpose found), and anything reverted for failing the
behavior gate. Confirm the suite is green.

**Success criteria:** an honest account of kept / kept-on-purpose / reverted, with a green suite.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "This code looks pointless, delete it." | You not seeing the purpose isn't proof there is none. Establish why it's there (Chesterton's Fence) before removing. |
| "Fewer lines is simpler." | Simpler = faster to understand, not shorter. A dense one-liner can be harder to read than the five lines it replaced. |
| "I'll refactor the whole module in one pass." | A broad rewrite destroys the behavior-preservation signal and hides semantic changes. One verified edit at a time. |
| "Tests pass, so behavior is preserved." | Tests are necessary, not sufficient — they may not cover the edge the edit changed. Add the adversarial semantic check. |
| "This abstraction might be needed later." | Speculative generality with one caller is complexity now for a maybe-later. Inline it; re-abstract when a second caller actually arrives. |
| "It's clearly equivalent, no need to verify." | "Clearly equivalent" is exactly where the subtle edge-case break hides. Verify or revert. |

## Red Flags

- Behavior changed (an output/error/side effect differs) after a "simplification".
- Code removed without its purpose being established.
- A large multi-concern diff labeled "simplify".
- Tests weakened/deleted to make a simplification "pass".
- "Simpler" that's actually just terser and harder to read.
- The loop kept re-attempting the same reverted edit.

## Guardrails

- Never change observable behavior; revert anything not provably neutral.
- Never remove code whose purpose you haven't established.
- Never do a broad rewrite; one small verified edit at a time.
- Never weaken tests to keep a simplification.
- Optimize for reader understanding, not line count or abstraction.

## When To Load References

- `converge-loop` (skill) — the until-dry simplification loop.
- `adversarial-verify` (skill) — the behavior-preservation (regression-lens) gate.
- `checkpoint-resume` (skill) — durable simplify-run state.
- `auto-test` (skill) — establish a test safety net first if the target is under-covered.

## Output Contract

Report:

1. scope + the behavior baseline used (tests green + snapshot)
2. simplifications kept (reader-cost removed), each verified behavior-preserving
3. code investigated and kept on purpose (Chesterton's Fence — the purpose found)
4. edits reverted for failing the behavior gate
5. final suite state (green)
