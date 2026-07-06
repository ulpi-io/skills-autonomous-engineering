# Termination & Thrash Detection

Load this when wiring a new `converge-loop` or debugging one that won't stop. It defines the four
termination fields precisely and gives the detectors that keep a loop from spinning.

## The termination set (all four are mandatory)

A loop is safe only if it *cannot* run forever. That requires four independent stops — any one firing
ends the loop:

1. **done-condition** — the success target, machine-checkable. Examples: `test -z "$(knip --reporter=compact)"`,
   `pytest -q` exits 0, `cargo build` exits 0, a coverage number ≥ target. If you can't express it as a
   command/count/exit, you cannot use this loop — the condition is subjective.
2. **maxIterations** — a hard integer cap. Sized to the task: a typecheck-fix loop rarely needs >6; a
   broad dead-code sweep might take 8 rounds. Never `Infinity`, never absent.
3. **budget** — a token / tool-call / wall-clock ceiling. In a Workflow, use `budget.remaining()`; inline,
   estimate from tool-call count. The budget is a HARD stop, checked every iteration, independent of the
   iteration cap (a single iteration can be expensive).
4. **maxStall** — how many *unproductive* rounds are tolerated before abort (default 2). This is the
   subtle one: iterations and budget bound *cost*; maxStall bounds *futility*. A loop can have budget and
   iterations left and still be provably stuck.

## Measuring progress (so no-progress is detectable)

Progress must be a number you can compare round-to-round. Reduce the signal to a comparable value each
iteration:

- **until-green**: the count of distinct failures, plus a hash of the sorted failure identities
  (`test names` / `file:line:rule`). Fewer failures = progress. Same set = stall. A set seen before =
  oscillation.
- **until-dry**: the count of *new* items this round (items whose identity you haven't seen). Zero new =
  a dry round.

Keep a `seen` set of item identities across rounds. Dedup against ALL seen items, not just the last
round's — otherwise a finding the verifier rejected reappears every round and the loop never converges.

## The detectors

```
prevHash = null
stall = 0
seen = new Set()
for (iter = 1; iter <= maxIterations && withinBudget(); iter++) {
  const before = measure()                 // { count, hash, items }
  if (isDone(before)) return "converged"

  const unit = selectSmallestUnit(before, seen)   // one class / one fresh finding
  if (!unit) return stall >= maxStall ? "stalled" : "converged"  // nothing left to try
  seen.add(id(unit))

  act(unit)                                 // minimal change
  const after = measure()

  if (after.count > before.count) { revert(); stall++; }          // REGRESSION → revert
  else if (after.hash === before.hash) { stall++; }               // FLAT → stall
  else if (after.hash === prevHash) { stall++; markCoupled(); }   // OSCILLATION → stall
  else { stall = 0; }                                             // real progress
  prevHash = before.hash

  if (stall >= maxStall) return "stalled"
}
return isDone(measure()) ? "converged" : "exhausted"
```

The four exit points: `converged`, `stalled`, `exhausted` (iterations or budget), and — implicitly — an
escalation return when `act` needs a user decision.

## Anti-patterns that defeat termination (never do these)

- **Suppressing the signal.** Deleting/`skip`-ing a failing test, mass `eslint-disable` / `@ts-ignore` /
  `# type: ignore`, or `try/except: pass` to make the check "pass". This makes `isDone` lie; the loop
  reports converged while the problem is still there. If a test is genuinely wrong, that's a real edit
  with a stated reason — not a silencing to escape the loop.
- **Widening scope to force green.** Rewriting a whole module because one unit won't yield. The count may
  drop by luck while injecting new coupling; you've lost the progress signal.
- **Retrying identically.** Re-running the same failed edit "in case it works this time." Deterministic
  failures don't self-heal; a repeated identical attempt IS the stall.
- **Removing the cap "just for this run."** The cap is the safety rail. If 6 iterations wasn't enough,
  stop and report the gap — don't set it to 50.

## Reporting a non-converged exit

`exhausted` and `stalled` are honest, useful outcomes — report them as partial progress, not as
nothing:

```
converged: false   reason: stalled
signal: 11 failures → 3 failures (8 fixed over 5 iterations, ~40k tokens)
open (blocked):
  - src/auth/session.ts  — token refresh race; fix A re-breaks logout (oscillation with test 'logout clears session')
  - src/db/pool.ts       — needs a schema decision (nullable vs default) — USER decision, escalated
```

That tells the next actor exactly where to start. A bare "couldn't finish" does not.
