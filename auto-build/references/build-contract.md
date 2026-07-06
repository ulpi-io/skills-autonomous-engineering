# The Per-Task Build Contract

Load when executing Phase 2 of `auto-build`. This is the exact contract each task runs through. It is the
same for every task; the DAG decides the order, the worktree gives isolation, and the checkpoint records
the outcome.

## Preconditions (per task)

- All `dependsOn` are `integrated` on the working branch. If any isn't → `dep_blocked`, pointing at the
  ROOT that never landed. Do not build.
- The task's write scope is known and disjoint from other tasks in the same layer.
- The task's slice-scoped `validate` command is known (greenable once this slice + deps integrate).

## Step 1 — Implement on an isolated worktree branch (RED → GREEN → REFACTOR)

```
git worktree add <path> -b task/<id> <workingBranch>
```

Inside the worktree, work test-first:

1. **RED** — write a test that expresses the task's acceptance criteria and FAILS against the current
   code. A test that passes immediately proves nothing (mutation-check it if unsure — break the target,
   the test must fail).
2. **GREEN** — the minimum code to make the test pass. Don't over-build beyond the task's criteria.
3. **REFACTOR** — clean up with tests green; run the slice validate after each refactor.

Stay strictly inside the task's write scope. If you find you must edit outside it, that's a PLAN defect
(a missing dependency or a mis-drawn scope) — stop and flag it, don't silently widen scope.

## Step 2 — Integrate (serialized, merge-only)

Integration happens on the working branch, ONE task at a time (serialize even when tasks ran in parallel):

```
git -C <root> merge --no-ff task/<id>        # onto workingBranch
git -C <root> worktree remove <path>          # remove the merged worktree
git -C <root> branch -d task/<id>
```

Integration is **merge-only** — it does NOT run the whole-workspace validate. A whole-suite failure in a
half-built tree must never become a per-task blocker (that loops a clean slice to death). Prune the
worktree immediately so leftover checkouts can't poison a later validate.

## Step 3 — Review the integrated slice (slice-scoped)

`adversarial-verify` the integrated change against THIS task's acceptance criteria only. Give the reviewer
the rest of the plan for context, but:

- a defect INSIDE the task's write scope → a real finding (goes to the fix loop);
- an unmet whole-codebase invariant a LATER task owns (a legacy path a later task removes, a route/consumer
  a later task adds) → an OBSERVATION attributed to the owning task, NOT a block on this slice.

Skip this step only if the user disabled per-task review.

## Step 4 — Bounded fix loop

`converge-loop` (until-green on the slice validate), bounded by `MAX_FIX` (≈3):

```
for attempt in 1..MAX_FIX:
    address one in-scope finding (minimal change)
    run the slice validate
    if green: break
else:
    mark task `blocked` with the specific unresolved finding   # do NOT spin globally
```

Only act on findings inside the task's write scope — the engineer can't fix what it can't touch. Escalate
(don't loop) if a fix needs a decision outside the task.

## Step 5 — Commit + checkpoint (the task-exit gate)

A task is `done` only when ALL hold:

- [ ] its acceptance criteria are met, verified test-first (failing-then-passing test exists);
- [ ] its slice-scoped validate is GREEN on the integrated working branch;
- [ ] the review (if enabled) found no in-scope blocker, or the fix loop cleared them;
- [ ] only this task's files (+ its status update) are staged — never `git add -A`.

Then commit and mark the checkpoint unit `done`:

```
git -C <root> add <task's files>              # explicit paths only
git -C <root> commit -m "<type>(<scope>): <task title>"
```

If the exit gate isn't met within budget → `blocked` (with the reason). Never mark `done` on a red
validate; never weaken the validate to force the gate.

## Pre-existing failure attribution

If a slice's validate is red ONLY because of pre-existing / out-of-scope failures it doesn't own: the
slice is still correct and integrated — record a `preexistingNote` (classify new-vs-pre-existing against
the base), don't discard the correct work, and don't mark the task `blocked` for a failure it didn't
cause. Surface the pre-existing breakage as its own owning task for the report.

## The barrier between layers

Finish (integrate) all of layer N before starting layer N+1. This is what makes "build only on integrated
dependencies" hold. Within a layer, tasks run in parallel (capped, isolated); across layers, serialize.
