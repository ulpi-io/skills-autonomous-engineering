---
name: converge-loop
version: 0.1.0
description: |
  Use whenever the task is "repeat an action until a measurable condition holds" — fix until tests or
  typecheck pass, clean until a linter is quiet, harden until an audit is dry, add tests until coverage is met
  — and you want it to STOP honestly rather than spin. Triggers on "keep going until it's green", "loop until
  done", until-green / until-dry work. Not for one-shot tasks or unmeasurable goals.
allowed-tools:
  - Workflow
  - Bash
  - Read
  - Edit
  - Write
  - Agent
  - Grep
  - Glob
effort: high
argument-hint: "<goal — e.g. 'make `pnpm test` pass' or 'remove all dead exports'>"
arguments:
  - goal
when_to_use: |
  Use whenever a task is "repeat an action until a measurable condition holds" — fix until tests/typecheck
  pass, clean until a linter is quiet, harden until an audit is dry, add tests until coverage targets are
  met. Do NOT use for one-shot tasks (a single edit, a single command), for open-ended exploration with no
  stop condition, or when the stop condition is subjective and unmeasurable — define a measurable signal
  first, or don't loop.
---

<EXTREMELY-IMPORTANT>
A loop with no exit is the single most expensive failure mode of an autonomous agent. Non-negotiable:
1. NEVER start a loop without a declared TERMINATION SET: (a) a done-condition, (b) a max-iteration cap,
   (c) a budget (tokens/tool-calls/wall-clock), and (d) a no-progress rule. If you cannot state all four,
   do not loop — do the task once and report.
2. The done-condition MUST be machine-checkable (an exit code, a count, a diff, a benchmark number) — not
   a vibe. "Looks good" is not a stop condition.
3. FAIL CLOSED. If the loop hits the cap or budget WITHOUT meeting the done-condition, it is NOT done.
   Report `converged: false` with the remaining gap. Never fabricate success to exit.
4. STOP ON NO-PROGRESS. If an iteration does not measurably improve the signal (same failures, same count,
   or a re-introduced regression), that is a THRASH signal — stop after `maxStall` stalled rounds and
   escalate. Do not "try the same thing again, harder."
5. Each iteration must be SMALLER-SCOPED than the problem: one failure class, one file, one finding at a
   time. Never rewrite broadly hoping the signal turns green.
6. ESCALATE, don't spin. When blocked on a decision that is the user's to make (ambiguous requirement,
   destructive change, an external dependency), stop the loop and surface it.
</EXTREMELY-IMPORTANT>

# Converge Loop

## Inputs

- `$goal`: What "done" means, stated as a measurable target — e.g. `make `pnpm -w test` exit 0`,
  `remove every unused export reported by knip`, `no findings from the security audit`.

## Goal

Drive the codebase from its current state to the target state through a series of small, verified steps,
and stop the instant one of four things is true: it converged, it ran out of iterations, it ran out of
budget, or it stopped making progress. The value is not "it loops" — it's "it loops *and reliably
stops*, with an honest verdict either way."

## Step 0: Choose the mode and pin the termination set

Pick the mode:

- **until-green** — there is a single command whose success IS the goal (`tsc --noEmit`, `pytest`,
  `cargo build`, `eslint`, a validate script). The loop drives that command's exit status to 0.
- **until-dry** — the goal is "no more of X exists", where X is discovered each round (dead code,
  lint findings, missing tests, audit findings). The loop repeats find→act until a round finds nothing.

Then WRITE DOWN the termination set before touching code (state it in your reply so it's auditable):

| Field | until-green default | until-dry default |
|---|---|---|
| **done-condition** | the validate command exits 0 | a find round returns 0 new items |
| **maxIterations** | 6 | 8 rounds |
| **budget** | inherit the turn's token target; else ~150k output tokens | same |
| **maxStall** (no-progress rounds before abort) | 2 | 2 dry-or-stalled rounds |
| **scope-per-iteration** | one failure class / file | one finding / file |

Adjust the numbers to the task, but never remove a field. A missing cap is a bug.

**Success criteria**: mode chosen; all four termination fields have concrete values.

## Step 1: Baseline the signal

Run the check ONCE before changing anything and record the starting signal:

- until-green: run the validate command, capture the exit code and the *structured* failure list
  (which tests, which files, which errors — grouped by class). This is iteration 0.
- until-dry: run the finder once and record the count + identity (file:line) of each item, so you can
  tell "new this round" from "already seen".

If the signal is already at target (green / empty), STOP — `converged: true`, zero iterations. Don't
loop for the sake of it.

**Success criteria**: you have a concrete starting count/exit and a stable way to re-measure it.

## Step 2: The iteration — one small, verified step

Repeat until a termination field fires. Each iteration:

1. **Select** the smallest next unit — ONE failure class (until-green) or ONE fresh finding (until-dry).
   Prefer the root-cause failure when several share a cause (fixing it clears many at once).
2. **Act** minimally — the smallest change that addresses that unit. Do not opportunistically refactor
   unrelated code; that muddies the progress signal and risks new regressions.
3. **Re-measure** — re-run the check. Compare to the previous signal:
   - **Improved** (fewer failures / smaller count, nothing regressed) → keep the change, continue.
   - **No change or regressed** → this is a STALL. Revert the failed attempt if it made things worse,
     record the stall, and either try a *different* approach to the same unit or, if you're out of
     distinct approaches, mark that unit `blocked` and move to the next one.
4. **Account** — decrement the iteration counter; check the token/tool budget; increment the stall
   counter if this round didn't progress (reset it to 0 if it did).

For heavy or parallelizable work (a wide findings list, independent fix lanes), delegate the per-unit
work to `Agent` / `fan-out-work` rather than doing it all inline — but the loop control, measurement,
and termination accounting stay here in the coordinator.

**Success criteria**: every iteration ends with a re-measured signal and updated counters; no iteration
leaves the tree in a worse state than it found it.

## Step 3: Detect no-progress and anti-thrash

Progress is measured, not assumed. Between iterations, guard against the classic loops:

- **Flat signal** — the same count/failure set two rounds running → stall. After `maxStall` stalls,
  STOP; the loop cannot make progress on its own.
- **Oscillation** — a fix for A re-breaks B, whose fix re-breaks A. Detect by hashing the failure set;
  a repeated hash is oscillation → stop and report both as coupled.
- **Regression** — the count went UP. Revert the last change immediately; a loop must never ratchet the
  codebase backwards to chase a local win.
- **Scope creep** — you're editing files unrelated to any failure/finding. Stop; you've left the loop's
  mandate.

When any of these trips, the loop STOPS with `converged: false` and names the blocking unit(s) — it does
not keep trying.

**Success criteria**: the loop provably cannot run more than `maxStall` unproductive rounds.

## Step 4: Terminate and report honestly

Exit the moment any termination field fires, and classify the exit:

- **converged** — done-condition met (green / dry). Report the final signal and the units resolved.
- **exhausted-iterations** / **exhausted-budget** — cap hit before target. Report the *remaining* gap
  (which failures/findings are still open) — this is a real, honest partial result, not a failure to
  hide.
- **stalled** — no-progress/oscillation/blocked. Report the specific unit(s) that couldn't be moved and
  why, so a human (or a stronger agent) can take them.

Always report the delta: starting signal → ending signal, iterations used, budget spent. A loop that
went 12 failures → 2 failures and stopped is a *useful* partial result; say so plainly.

**Success criteria**: exactly one exit reason is reported; open items (if any) are enumerated; no exit
claims success it didn't achieve.

## Guardrails

- Never loop without all four termination fields. A missing cap is the bug, not a convenience.
- Never report `converged: true` unless the machine-checkable done-condition actually passed on the final
  measured run. A "should be passing now" is not a pass — re-run and read the exit code.
- Never make the per-iteration change bigger than the unit it addresses; broad rewrites destroy the
  progress signal and inject regressions.
- Never re-attempt an identical failed change; a repeated attempt with the same result is thrash.
- Never let the loop ratchet the tree backwards — revert any change that increases the failure count.
- Never suppress the signal to "pass" (deleting/skipping failing tests, `// eslint-disable` en masse,
  `@ts-ignore` to silence a real type error) — that is faking the done-condition, the cardinal sin here.
- Escalate on user-owned decisions instead of guessing inside the loop.

## Native goal/loop routing (prefer the platform's machinery)

Claude Code ships the loop scaffolding natively — **compile the termination set into it** instead of
hand-rolling scaffolding:

- **`/goal`** = the done-condition, verified after each turn by a SEPARATE model (the actor never
  grades its own work — stronger than any self-check this skill could prescribe). Formulate the goal
  AS the measurable done-condition, with the fail-closed clause in the text.
- **`/loop`** = the cycles, with time/count/event stops as the outer `maxIterations`.
- **What stays hand-rolled:** the anti-thrash detectors (Step 3) and one-unit-per-iteration scoping —
  native loops bound time and cost, not futility.

Load `references/native-goal-loop.md` for the full field-by-field compilation (including the Codex
/goal mapping: completion audit, blocked-after-3-stalls, budgeted goals).

## When To Load References

- `references/native-goal-loop.md`
  The termination-set → native `/goal` + `/loop` compilation for Claude Code (and the Codex mapping).
  Load FIRST when the platform's native goal loop is available — it replaces the scaffolding, not the
  discipline.
- `references/termination-and-thrash.md`
  The full termination-set rationale, the no-progress/oscillation detectors (failure-set hashing), and
  the budget-accounting recipe. Load when wiring a new loop or debugging one that won't stop.
- `references/loop-patterns.md`
  Concrete until-green and until-dry patterns — inline vs. Workflow-tool shapes (fan-out with
  adversarial verify, per-unit bounded fix loops), and how the coordinator keeps termination control
  while delegating the work. Load when the loop is non-trivial or parallel.

## Output Contract

Report:

1. mode (until-green / until-dry) and the termination set used
2. starting signal → ending signal (the delta)
3. iterations used, budget spent, exit reason (converged / exhausted / stalled)
4. units resolved, and — if not converged — the enumerated open units with why each is still blocked
