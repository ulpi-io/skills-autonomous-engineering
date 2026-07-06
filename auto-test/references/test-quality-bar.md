# The Test-Quality Bar

Our standard for what counts as a *good* test — the bar `auto-test` writes to. Self-contained; load in
Phase 0. A test that doesn't clear this bar is not coverage, it's noise.

## The one property that matters most: a test must be able to fail

Every other rule is secondary to this. A test that passes no matter what the code does is worse than no
test — it's a green light wired to nothing. So `auto-test` proves each test can fail before trusting it:

- **Mutation check (mandatory here).** Make a small, targeted break in the code under test — flip a
  comparison (`>` → `>=`), drop a side effect (remove a write/return), return a wrong constant, skip a
  branch. Re-run just this test: it MUST go red. Restore: it MUST go green. A test that survives the
  mutation is a tautology — rewrite it to assert the actual behavior.
- This is stronger than "write the test first (RED)". RED only proves the test failed against *absent*
  code; the mutation check proves it fails against *wrong* code — which is what regressions actually are,
  and it works for characterization tests of code that already exists.

If you can only afford one quality gate, it's this one.

## The pyramid — invest where the cost/confidence trade is best

```
        ╱╲   E2E (~5%)          full flows, real browser/services — minutes, brittle, few
       ╱──╲  Integration (~15%) boundaries: API+test DB, component trees — seconds
      ╱────╲ Unit (~80%)        pure logic, isolated — milliseconds, deterministic, many
```

Most tests small and fast; a thin cap of slow end-to-end. An inverted pyramid (mostly E2E) is slow,
flaky, and hard to debug — a red flag to correct, not extend.

**Test sizes (resource model):** Small = single process, no I/O/network/DB (ms). Medium = localhost,
test DB, no external services (s). Large = external services, multi-machine (min). Prefer the smallest
size that still exercises the behavior for real.

## What to assert

- **State, not interactions.** Assert the *outcome* (`result.status === 'completed'`), not that some
  internal method was called. Interaction assertions (`expect(db.query).toHaveBeenCalledWith(...)`) break
  on refactors that don't change behavior — they test the code's shape, not its contract.
- **Behaviors, not lines.** Coverage % counts lines executed; it does not count behaviors verified. Target
  the untested *behavior* (an error path, an edge case, a boundary), not a coverage number. 90% coverage
  of vacuous assertions proves nothing.
- **One concept per test.** Each test verifies one behavior and is named like a spec sentence
  (`sets completedAt when a task is completed`, `throws NotFoundError for an unknown id`). A test that
  asserts five things fails ambiguously and reads like nothing.

## How to write it

- **Arrange-Act-Assert**, in that order, visibly separated.
- **DAMP over DRY.** In tests, Descriptive And Meaningful Phrases beat Don't-Repeat-Yourself: a little
  duplication so each test is readable standalone beats a web of shared helpers you must trace. Tests are
  the spec; a spec you can't read at a glance is a bad spec.
- **Real over mocks.** Preference: real implementation > fake (in-memory) > stub > mock. Mock ONLY at
  boundaries that are slow, non-deterministic, or have uncontrollable side effects (external APIs, email,
  clock, randomness). Over-mocking yields tests that pass while production breaks.
- **Deterministic.** Inject the clock, seed randomness, fix timezones, await all async, isolate per-test
  state. Non-determinism is a bug in the test, not a fact of life.
- **Consider property-based tests** for pure logic with a wide input space (parsers, encoders,
  invariants): assert a property over generated inputs (`decode(encode(x)) === x`) instead of a handful of
  examples. One property test can subsume dozens of example tests and find the edge case you'd miss.

## Anti-patterns (reject on sight)

| Anti-pattern | Why it's bad | Fix |
|---|---|---|
| Tautology (`toBeDefined`, `not.toThrow` on everything) | Can't fail — proves nothing | Assert the specific value/behavior; mutation-check it |
| Testing implementation details | Breaks on behavior-preserving refactors | Assert inputs → outputs, not internals |
| Over-mocking | Green tests, broken production | Real deps; mock only slow/nondeterministic boundaries |
| Flaky (timing/order/shared-state) | Erodes trust in the whole suite | Fix the root (isolate/inject/await) — never retry/sleep |
| Snapshot abuse | Huge snapshots nobody reads; break on any change | Tiny, reviewed snapshots or explicit assertions |
| Skipped/`.only`/commented-out to go green | Fakes the done-condition | Never; fix or surface the failure |
| Testing framework/library code | Wastes effort on third-party behavior | Only test YOUR code |

## The exit bar for a single test

A test `auto-test` adds is "good" only when ALL hold:
- [ ] it targets a real, previously-untested behavior (not a coverage-number filler);
- [ ] it is mutation-verified (fails on broken code, passes on correct code);
- [ ] it asserts state/outcome, one concept, with a spec-like name;
- [ ] it is deterministic and at the smallest size that still exercises the behavior for real;
- [ ] it did not require weakening/skipping any other test to pass.
