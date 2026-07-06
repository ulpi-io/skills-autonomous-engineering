# Compiling the Termination Set onto Native Goal/Loop Primitives

Both major agent platforms now ship a NATIVE autonomous loop. This reference maps `converge-loop`'s
termination set onto them, so a loop runs on the platform's machinery — with its independent
verification and its budget accounting — instead of a hand-rolled imitation. **Prefer the native
primitive whenever it is available**; hand-roll only the parts it doesn't cover (anti-thrash,
per-iteration scoping).

## The mapping at a glance

| Termination-set field | Claude Code native | Codex native |
|---|---|---|
| **done-condition** | `/goal` objective — verified after each turn by a SEPARATE model (the actor never grades itself) | `/goal` objective — the completion audit must PROVE each requirement against current evidence before `update_goal complete` |
| **maxIterations** | `/loop` stop conditions (count/time/event) | goal turns bound by the token budget |
| **budget** | the session/turn token target; routines have per-run budgets | budgeted goals — a hard token budget on the goal; usage reported at completion |
| **maxStall (no-progress)** | NOT native — keep the skill's stall/oscillation detection inside the loop body | `update_goal blocked` fires only after the SAME blocking condition recurs 3 consecutive goal turns — native maxStall=3 |
| **escalation triggers** | the loop body stops and asks (AskUserQuestion); hooks block irreversibles deterministically | `blocked` status returns control to the user; the brief must name the escalation triggers |

## Claude Code: /goal + /loop + routines

- **`/goal`** pins WHAT DONE MEANS for the session. Its power is the separated verifier: a different,
  faster model checks the completion condition after each turn — the model that wrote the code never
  gets to declare its own work done. That is exactly `converge-loop`'s "the done-condition must be
  machine-checkable and independently measured" rule, implemented by the platform.
  - Formulate the goal AS the done-condition, measurably: "`pnpm -w test` exits 0 with no test
    skipped/weakened; every new test fails when its target is mutated" — not "improve the tests".
  - Bake the fail-closed clause into the goal text: "a gate that did not run is not passed."
- **`/loop`** re-fires a prompt/skill on an interval or event until a stop condition — use it for the
  CYCLES (re-run `/auto-test` until its Output Contract reports converged), with a time/count stop as
  the outer `maxIterations`.
- **`ScheduleWakeup`** (dynamic /loop) for self-paced ticks — pick delays per the cache-window rules in
  `watch-and-act`.
- **Routines** (scheduled cloud agents) for standing loops — see `schedule-recurring-agent`.
- **What stays hand-rolled here:** the anti-thrash detectors (flat-signal, oscillation-hash,
  regression-revert) and one-unit-per-iteration scoping — the native loop bounds time and cost, not
  futility. Keep Step 3 of `converge-loop` active inside the goal.

## Codex: /goal (the built-in agentic loop)

Codex's goal loop is plan → act → test → review → iterate, with three properties that map directly:

- **The completion audit IS the fail-closed done-condition.** Before marking complete, the model must
  derive concrete requirements from the objective and prove EACH against current evidence (files,
  command output, test results) — "uncertain or indirect evidence = not achieved; keep working."
  Write the goal brief so the requirements are enumerable and checkable (list the validate commands,
  the acceptance criteria, the gates).
- **`update_goal` is complete-or-blocked only** — no self-pause, no drift. `blocked` may fire only
  after the same blocking condition recurs for 3 consecutive goal turns: a native `maxStall = 3`.
  Don't fight it; align the skill's stall counter with it.
- **Budgeted goals** put a hard token ceiling on the run and report final usage — `budget-guard`'s
  budget field, natively enforced. Set it at goal creation; never treat near-exhaustion as "done"
  (the tool description itself forbids completing a goal just because the budget is nearly spent).

Goal brief template (Codex):

```
GOAL: <the done-condition, measurable — e.g. "make `pnpm -w test` exit 0 over src/auth">
REQUIREMENTS (the completion audit will check each):
  1. <validate command> exits 0
  2. no test was skipped/weakened/deleted to get there (git diff shows no .only/.skip additions)
  3. every added test fails when its target is mutated (state the mutation probe per test)
ESCALATE (mark blocked / stop) when: <ambiguous expected behavior | irreversible step needed | same
  failure 3 turns running>
BUDGET: <token budget>
```

## When NOT to use the native loop

- The work needs MID-LOOP user decisions at known points (gate questions, plan approval) — a goal loop
  runs unattended between checkpoints; split into goal-sized segments around the human gates instead
  (exactly how `autonomous-pipeline` places its single approval BETWEEN plan and build).
- The stop condition is a count of *discovered* items (until-dry) — express it as "N consecutive dry
  rounds", which both audits can check, or keep the loop hand-rolled.
- Sub-minute micro-loops (single-command fix cycles) — goal overhead isn't worth it; run inline.

## The rule

The native goal loop replaces the *scaffolding* of a converge-loop (re-invocation, independent
verification, budget stop). It does not replace the *discipline* (small verified iterations,
anti-thrash, never weakening the signal to pass). Compile the termination set into the goal; keep the
discipline in the loop body.
