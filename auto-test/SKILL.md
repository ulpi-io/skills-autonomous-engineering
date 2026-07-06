---
name: auto-test
version: 0.1.0
description: |
  Autonomously raise a codebase's test health to a green, MEANINGFUL suite — find the untested behaviors
  and missing regression tests, write real tests for them, and run a bounded loop-until-green until the
  suite passes, de-flaking along the way. Every added test is proven to actually exercise its target (a
  mutation check — break the code, the test must fail — not a tautology that passes no matter what). The
  run is checkpointed so it resumes cleanly, and it fails closed: it never makes the suite "green" by
  skipping, deleting, or weakening tests. Use as the VERIFY phase after a build, to add coverage to a
  risky area, or to stabilize a flaky suite. Self-contained — it carries its own test-quality bar (test
  pyramid, DAMP, state-not-interaction, mutation-verified) — and composes converge-loop,
  adversarial-verify, and checkpoint-resume.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Agent
  - Skill
  - Workflow
effort: high
argument-hint: "[scope — path/module/diff, or 'flaky' to stabilize] (default: the current diff)"
arguments:
  - scope
when_to_use: |
  Use to prove code works and lock in behavior: after auto-build (or any implementation) to cover what
  was written, to raise coverage on a specific risky module, to add a regression test that reproduces a
  known bug, or to de-flake an unreliable suite. Do NOT use to write tests DURING implementation of new
  behavior — that is test-first build work (auto-build's RED→GREEN loop); this
  phase is the autonomous coverage-and-green runner over code that already exists. Do NOT use on a repo
  with no test runner configured — set one up first.
---

<EXTREMELY-IMPORTANT>
A green suite is worthless if it was made green by cheating, and dangerous if its tests don't actually
test anything. Non-negotiable:
1. NEVER make the suite pass by weakening the signal: no deleting/`skip`/`xit`/`.only`, no
   `expect(true)`, no loosening an assertion to match wrong output, no commenting out a failing test, no
   raising a timeout to paper over a real hang. If a test is genuinely wrong, fixing it is a real,
   explained change — not a silencing to escape the loop.
2. NEVER add a test that can't fail. Every added test is mutation-checked: break the code under test, the
   test MUST go red; restore it, the test MUST go green. A test that passes on a broken implementation is
   a tautology and is rejected, not counted as coverage.
3. FAIL CLOSED. If the loop hits its iteration/budget cap without a green suite, report `converged:false`
   with the exact failing tests. A red suite is NEVER reported as done, and "should pass now" is not a
   pass — re-run and read the exit code.
4. Distinguish a test that reveals a real bug from a test that is itself wrong. If a new characterization
   test fails because the CODE is wrong, that is a finding to surface (or fix, if in scope) — do NOT
   rewrite the test to assert the buggy behavior.
5. Coverage is a means, not the goal. Never chase a coverage % with vacuous tests. One meaningful test of
   a real behavior beats ten that assert nothing.
6. ESCALATE, don't guess. Ambiguous expected behavior (is this output the bug or the spec?), a test that
   needs a product decision, or a flaky failure rooted in infra → stop and surface it.
</EXTREMELY-IMPORTANT>

# Auto Test

## Overview

Drive a codebase from "some/unknown test health" to "a green suite that meaningfully covers the target",
autonomously and safely. The value is the combination: it *loops* (find gaps → write → run → fix →
re-run) but it *stops honestly* (bounded, fails closed) and it *doesn't cheat* (every test is proven able
to fail, the suite is never gamed green). It runs the `converge-loop` until-green pattern, gates each new
test through `adversarial-verify` (mutation check), and checkpoints via `checkpoint-resume`.

## When to Use

- After `auto-build` / any implementation, to cover the behavior that was just written
- To raise real coverage on a specific risky module (auth, money, data migrations, parsers)
- To add a regression test that reproduces a reported bug before it's fixed (the Prove-It pattern)
- To de-flake an unreliable suite (`auto-test flaky`)

**When NOT to use:** writing tests test-first *while* implementing new behavior (that's `auto-build`'s
RED→GREEN loop); a repo with no runner configured (set one up first);
pure-config/docs changes with no behavioral surface.

## Phase 0: Ground the run — scope, runner, baseline, methodology

Before writing anything:

1. **Resolve scope** (`$scope`): a path/module, the current diff (default — `git diff` against the base),
   or `flaky` (stabilize mode). Narrow, targeted scope beats "test the whole repo."
2. **Detect the runner + coverage tool** — read the repo: `package.json` scripts, `pytest.ini`,
   `Cargo.toml`, a `Makefile`. Capture the exact command to run the whole suite and to run a single
   file/test (you'll use the single-test form for tight loops). If none exists, STOP and say so.
3. **Baseline the signal** — run the suite ONCE. Record: pass/fail counts, which tests fail, and (if
   available) current coverage on the scope. This is `converge-loop` iteration 0. If it's already green
   with the target covered, there may be nothing to do — say so, don't invent busywork.
4. **Load our test-quality bar** — this skill carries its own standard for what a good test is (see
   `references/test-quality-bar.md`): the test pyramid (≈80/15/5), test sizes, DAMP-over-DRY,
   state-not-interaction assertions, real-implementations-over-mocks, and the anti-patterns to avoid.
   Apply it directly; it is self-contained, not a pointer to another collection.
5. **Open a checkpoint** — start a `checkpoint-resume` run (`.ulpi/runs/<id>.json`) with one unit per
   target behavior/file. On resume, skip units already `done`.

**Success criteria:** scope fixed; exact suite + single-test commands known; a concrete baseline
(counts + failing tests + coverage) recorded; checkpoint open.

## Phase 1: Find the gaps — the work list

Identify the *behaviors* that lack a meaningful test (not just uncovered lines):

- diff the scope against the tests that touch it; list public functions/branches/error paths with no
  assertion behind them;
- prioritize by risk — untested error/edge paths, money/auth/data-mutation code, and recently changed
  code rank above cosmetic getters;
- for `flaky` mode, instead identify the tests that fail intermittently (run the suite N times, collect
  the non-deterministic failures) — those are the units.

For a large scope, fan the discovery out with `fan-out-work` (one agent per module) and merge the gap
list. Record each gap as a checkpoint unit.

**Success criteria:** a prioritized, de-duplicated list of concrete missing tests (or flaky tests),
each an addressable unit.

## Phase 2: Write one meaningful test — and prove it can fail

Per unit (smallest first), write ONE focused test, then verify it's real BEFORE trusting it:

1. **Write** it following the methodology — Arrange-Act-Assert, a descriptive name that reads like a spec,
   one concept per test, state-based assertions, real implementations over mocks. For a bug repro, write
   it to FAIL against current code (RED).
2. **Mutation-check it** (`adversarial-verify` for tests): make a small, targeted break in the code under
   test (flip a comparison, drop a write, return a wrong constant) and re-run just this test — it MUST go
   red. Restore the code — it MUST go green. A test that stays green on the broken code is a tautology:
   reject it, rewrite it to actually assert the behavior. For heavy verification, delegate the
   mutation-probe to a subagent.
3. **Classify a genuine failure** — if, against the *correct* code, the test fails, decide: is the TEST
   wrong (fix the test) or is the CODE wrong (a real bug — surface it; fix only if in scope, never by
   asserting the buggy output)?

**Success criteria:** each added test provably fails when its target is broken and passes when it's
correct; any real bug the test exposed is recorded, not papered over.

## Phase 3: Converge the suite to green

Run the `converge-loop` until-green pattern over the whole target, with its full termination set (done =
suite exits 0 over the scope; maxIterations; token budget; maxStall=2):

- after each added/fixed test, run the suite (single-file form for speed during the loop; full suite at
  round boundaries to catch regressions);
- if a change regresses another test, revert and reconsider — never ratchet the suite backwards;
- if a unit can't be made green in `MAX_FIX` (≈3) attempts, mark it `blocked` with the reason and move
  on — do not spin;
- update the checkpoint as each unit reaches `done` / `blocked`.

**Success criteria:** the scoped suite is green (or the loop terminated honestly with the specific
blocked units named); no regressions introduced.

## Phase 4: De-flake (stabilize mode, or any flake surfaced)

For any test that passes/fails non-deterministically:

- reproduce by running it in a loop / with randomized order; find the root cause class — shared state,
  time/timezone, ordering, real network, unawaited async;
- fix the ROOT (isolate state, inject the clock, await properly, fake the boundary) — never "fix" a flake
  by adding a retry or a sleep to mask it;
- confirm stability: N consecutive green runs (and randomized order) before calling it fixed.

**Success criteria:** previously-flaky tests pass deterministically across repeated + reordered runs; no
flake masked by retries/sleeps.

## Phase 5: Report

Finalize the checkpoint and report honestly (see Output Contract). Include the before→after signal
(counts + coverage delta), the tests added, any real bugs surfaced, and any blocked units.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The suite is green, we're done." | Green via a tautological or skipped test is a false signal. Green + mutation-proven + nothing skipped is done. |
| "This test passes immediately, ship it." | A test that passes on the first run may test nothing. Mutation-check it: break the target — if it stays green, it's vacuous. |
| "The test fails, let me relax the assertion to match." | If the code output is wrong, that's a bug to surface, not an assertion to loosen. Loosening hides the defect. |
| "I'll just skip the failing test to get green." | Skipping is faking the done-condition — the exact cardinal sin. A skipped test is an untested behavior wearing a green badge. |
| "It's flaky, add a retry." | A retry masks a real race/state bug that will bite in production. Fix the root; retries are not stabilization. |
| "Coverage is at 90%, good enough." | Coverage counts lines executed, not behaviors asserted. Ten vacuous tests raise the number and prove nothing. |
| "I ran the tests earlier, they're fine." | After any code change, the earlier run is stale. Re-run after the change; read the actual exit code. |

## Red Flags

- The suite went green in the same edit that deleted/`skip`ped/`.only`'d a test.
- A newly added test passes against a deliberately broken version of the code.
- An assertion was changed to match the code's current (possibly wrong) output.
- A flake "fixed" by a `sleep`, a retry wrapper, or an increased timeout.
- Coverage % climbing while assertions are vacuous (`toBeDefined`, `not.toThrow` on everything).
- "All tests pass" reported without a suite run in the transcript.
- The loop is on its 6th iteration re-trying the same failing approach (thrash — stop and escalate).

## Guardrails

- Never weaken, skip, delete, or `.only` tests to reach green. Fail closed instead.
- Never count a test that can't fail — mutation-check every addition.
- Never rewrite a test to assert buggy behavior; surface the bug.
- Never mask a flake with sleeps/retries/timeouts; fix the root cause.
- Never chase a coverage number with vacuous tests.
- Never report green without a final real suite run and its exit code.
- Keep each iteration small and measured (one test/behavior); revert any regression immediately.
- Escalate ambiguous expected-behavior questions instead of guessing.

## When To Load References

- `converge-loop` (skill) — the until-green loop with the termination set + anti-thrash. The engine of
  Phase 3.
- `adversarial-verify` (skill) — the mutation-check / tautology-rejection gate for Phase 2.
- `checkpoint-resume` (skill) — the durable run state for skip-done resume.
- `fan-out-work` (skill) — parallel gap discovery / test writing over a large scope.
- `references/test-quality-bar.md` — OUR standard for a good test: pyramid, sizes, DAMP,
  state-not-interaction, real-over-mocks, and the anti-patterns. Load in Phase 0.

## Verification

Before reporting done, confirm:

- [ ] The scoped suite passes on a fresh, real run (exit code read, not assumed)
- [ ] Every test added this run was mutation-checked (fails on broken code, passes on correct code)
- [ ] No test was skipped, deleted, `.only`'d, or weakened to reach green
- [ ] Any real bug a test exposed is surfaced (and fixed only if in scope — never asserted-as-correct)
- [ ] Flaky tests (if any) pass deterministically across repeated + reordered runs, with no masking
- [ ] Coverage delta (if tracked) reflects real behaviors, not vacuous assertions
- [ ] The checkpoint file reflects the final per-unit state; blocked units are named with reasons

## Output Contract

Report:

1. scope + suite command used; baseline → final signal (pass/fail counts, coverage delta)
2. tests added (by behavior), each noted mutation-verified
3. real bugs surfaced (and whether fixed in scope or handed off)
4. flakes stabilized (root cause + how) — if any
5. loop outcome: converged, or the honest list of blocked/failing units with reasons
6. checkpoint file path (durable record; resume-able)
