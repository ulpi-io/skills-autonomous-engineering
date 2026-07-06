# Pipeline State Machine, Gates & Handoffs

Load when wiring or resuming an `autonomous-pipeline` run. Defines the phase order, the fail-closed gate
each phase must clear before the next starts, the phase-to-phase handoff, and the checkpoint schema.

## Phases, artifacts, and gate conditions

| # | Phase | Consumes | Produces | Gate to pass before next phase |
|---|-------|----------|----------|-------------------------------|
| 1 | auto-spec | the request | `.ulpi/spec/<name>.md` | spec exists; all acceptance criteria testable; non-goals stated; open questions resolved or flagged |
| 2 | auto-plan | the spec | `.ulpi/plans/<name>.{json,md}` | DAG acyclic + topologically layered; every spec criterion covered; self-review clean |
| — | **APPROVAL** | the plan | user affirmative | unambiguous "approve/go/yes" (the single human gate) |
| 3 | auto-build | the plan | integrated commits per task | all tasks `done` (none blocked/dep_blocked); final workspace validate GREEN |
| 4 | auto-simplify | the build diff | cleaner diff | every kept edit verified behavior-preserving; suite still green |
| 5 | auto-test | the codebase | added tests, green suite | scoped suite green; added tests mutation-verified; nothing skipped/weakened |
| 6 | auto-review | the diff | verified findings | every dimension ran (fail closed on gaps); confirmed blockers resolved (or surfaced) |
| 7 | auto-performance | the target | measured optimizations | (if run) each kept change benchmark-proven + no regression; else skipped |
| 8 | auto-ship | verified work | PR / staged rollout | pre-launch gates green (fail closed); rollback ready; human sign-off for irreversible deploy |

A gate is fail-closed: if a phase did not reach its bar (a blocked build task, a red validate, an unrun
review dimension), the pipeline does NOT start the next phase with a false-green — it pauses and
escalates, or records the phase `blocked` and returns the register early.

Optional phases (user-configurable at intake): `auto-simplify`, `auto-performance`, and the deploy portion
of `auto-ship` may be skipped. `auto-build` and `auto-test` are not skippable. A skipped phase is recorded
as `skipped` (a deliberate choice), not `done`.

## Handoff contract

Each phase hands the next a small, explicit payload — never the whole transcript:

- spec → plan: the spec path.
- plan → build: the plan path (`{tasks, layers}`).
- build → simplify/test: the working branch + the integrated diff range + the build checkpoint (so
  downstream knows what changed and what's blocked).
- test/simplify → review: the diff to review.
- review → performance/ship: the confirmed (verified) findings; performance target if any.
- ship: the release branch + gate results.

Thread artifacts by PATH/REF, not by inlining content — the phases read what they need.

## Pipeline checkpoint schema

Extends `checkpoint-resume` with one unit per phase (each phase ALSO keeps its own per-task/per-unit
checkpoint):

```json
{
  "schemaVersion": 1,
  "id": "pipeline-<label>-<UTC>",
  "task": "<the request>",
  "status": "running",                 // running | done | needs_attention | aborted
  "currentPhase": "build",
  "config": { "simplify": true, "performance": false, "shipDeploy": false },
  "workingBranch": "<branch>",
  "approvedPlan": true,
  "phases": {
    "spec":        { "status": "done",    "artifact": ".ulpi/spec/x.md" },
    "plan":        { "status": "done",    "artifact": ".ulpi/plans/x.json" },
    "build":       { "status": "running", "checkpoint": ".ulpi/runs/build-x.json" },
    "simplify":    { "status": "pending" },
    "test":        { "status": "pending" },
    "review":      { "status": "pending" },
    "performance": { "status": "skipped" },
    "ship":        { "status": "pending" }
  },
  "openRegister": [],                    // verified findings carried to the end
  "result": null
}
```

## Resume

On resume: read the checkpoint, jump to `currentPhase`, and within it defer to that phase's own
`checkpoint-resume` (skip its `done` units). Never restart from `spec`; never overwrite the pipeline
checkpoint with a fresh pending doc. A phase recorded `done` is skipped; a `running`/`blocked` phase is
re-entered.

## Escalation ↔ pause

Any phase's escalation (unfixable failure, ambiguity, irreversible step) sets the pipeline
`status: needs_attention`, records the blocking detail in `openRegister`, and stops. The user resolves it
and re-invokes `autonomous-pipeline resume` — it continues from `currentPhase`. The pipeline never decides
a user-owned question to keep itself moving.

## One pass, then stop

After `auto-ship` (or an early fail-closed stop), the pipeline verifies + returns `openRegister` and sets
`status` (`done` if empty and everything shipped, else `needs_attention`). It does NOT loop the lifecycle.
A fix round is a fresh invocation with the findings as the request.
