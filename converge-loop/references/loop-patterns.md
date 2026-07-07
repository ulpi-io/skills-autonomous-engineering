# Loop Patterns — inline vs. Workflow, single vs. fan-out

Load when the loop is non-trivial or parallel. These are concrete, copy-adaptable shapes for the two
modes, at increasing scale. Pick the smallest that fits — an inline loop is cheaper than a Workflow.

## When to stay inline vs. reach for the Workflow tool

- **Inline** (the coordinator runs the loop directly with Bash/Edit): the default for until-green on a
  single validate command, and for small until-dry sweeps. Cheapest, fully observable, no orchestration
  overhead.
- **Workflow tool**: when each iteration's work is heavy or parallelizable — a wide findings list, many
  independent fix lanes, per-item adversarial verification. The Workflow gives you `budget.remaining()`,
  concurrency caps, and deterministic loop control. The loop's *termination accounting* still lives in
  the script.

The coordinator ALWAYS keeps termination control. Delegating the *work* of an iteration to agents is
fine; delegating the *decision to continue* is not.

## until-green, inline

```
# termination set: done = `$VALIDATE` exit 0 ; maxIterations=6 ; maxStall=2 ; budget≈150k
before = run($VALIDATE)                      # capture exit + grouped failures
iter=0; stall=0; prevFailures=null
while (before.exit != 0 && iter < 6 && stall < 2 && withinBudget()):
    iter++
    cls  = pick_root_failure_class(before.failures)   # ONE class, prefer shared root cause
    apply_minimal_fix(cls)
    after = run($VALIDATE)
    if after.failures.count > before.failures.count:  revert(); stall++       # regression
    elif same_set(after.failures, before.failures):   stall++                 # flat
    elif same_set(after.failures, prevFailures):       stall++; note_couple() # oscillation
    else:                                              stall=0                # progress
    prevFailures = before.failures; before = after
report(before.exit==0 ? "converged" : (stall>=2 ? "stalled" : "exhausted"), delta, open=before.failures)
```

## until-dry, inline

```
# termination set: done = finder returns 0 NEW ; maxRounds=8 ; maxStall=2 (dry-or-flat)
seen=set(); dry=0; round=0
while (round < 8 && dry < 2 && withinBudget()):
    round++
    found = run_finder()                      # e.g. knip / eslint / a grep-based audit
    fresh = [f for f in found if id(f) not in seen]
    if not fresh: dry++; continue             # a dry round
    dry=0
    for f in fresh:
        seen.add(id(f))
        fix_minimal(f)                        # or defer to an agent (see fan-out below)
report("converged" if dry>=2 else "exhausted", rounds=round, resolved=len(seen))
```

Note `dry` counts consecutive *dry* rounds, and `seen` dedups across ALL rounds — a finding you looked
at and chose not to fix (or that a verifier rejected) must not re-trigger work next round.

## until-dry with fan-out + adversarial verify (Workflow tool)

For a wide findings list where each fix is independent and each finding should be verified before it's
acted on. The loop-until-dry, the concurrency cap, and the budget stop are in the script; the finding,
verifying, and fixing are agents.

```js
export const meta = { name: 'converge-clean', description: 'find → verify → fix until dry',
  phases: [{title:'Find'},{title:'Verify'},{title:'Fix'}] }

const seen = new Set(); const resolved = []; let dry = 0, rounds = 0
const MAX_ROUNDS = 8                                        // the mandated max-iteration cap (never loop on budget+dry alone)
while (dry < 2 && rounds++ < MAX_ROUNDS && (!budget.total || budget.remaining() > 40_000)) {
  const found = await agent('Find the next batch of <X>. Return {items:[{id,file,line,desc}]}.',
                            {phase:'Find', schema: FOUND})
  if (!found || !found.items?.length) { dry++; continue }  // null = finder died → dry round, never crash (found.items would throw)
  const fresh = found.items.filter(f => !seen.has(f.id))
  if (!fresh.length) { dry++; continue }
  dry = 0; fresh.forEach(f => seen.add(f.id))

  // verify each fresh finding (majority-refute) before fixing — see the adversarial-verify skill
  const real = (await parallel(fresh.map(f => () =>
    agent(`Try to REFUTE this finding: ${f.desc}. Default refuted=true if uncertain.`,
          {phase:'Verify', schema: VERDICT}).then(v => ({f, keep: v ? !v.refuted : false})))))  // dead verifier → not kept (fail closed)
    .filter(Boolean).filter(x => x.keep).map(x => x.f)

  await parallel(real.map(f => () =>
    agent(`Apply the minimal fix for: ${f.desc} in ${f.file}. Change ONLY what this finding requires.`,
          {phase:'Fix'})))
  resolved.push(...real.map(f => f.id))
}
return { converged: dry >= 2, resolved, rounds_dry: dry }
```

## until-green with a bounded fix loop per unit (the auto-build / auto-test shape)

When each failing unit gets a few attempts before it's declared blocked — the shape phase skills use:

```
for unit in failing_units:                     # e.g. per task, per test file
    for attempt in range(MAX_FIX):             # MAX_FIX ≈ 3, a per-unit iteration cap
        apply_fix(unit)
        if run(unit.validate).exit == 0: break
    else:
        mark_blocked(unit)                     # exhausted this unit's attempts → don't spin globally
```

`MAX_FIX` is the per-unit cap; the outer loop still has its own `maxIterations`/budget. Nesting caps is
fine — every level must have one.

## The one rule across all patterns

Measure before and after every iteration, compare, and let the comparison — not optimism — decide
whether to continue. The moment progress stops being *measured*, the loop stops being *bounded*.
