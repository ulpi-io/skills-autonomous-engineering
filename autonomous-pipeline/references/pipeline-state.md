# Pipeline State Machine, Gates & Handoffs

Load when wiring or resuming an `autonomous-pipeline` run. Defines the phase order, the fail-closed gate
each phase must clear before the next starts, the phase-to-phase handoff, and the checkpoint schema.

## Phases, artifacts, and gate conditions

| # | Phase | Consumes | Produces | Gate to pass before next phase |
|---|-------|----------|----------|-------------------------------|
| 1 | auto-spec | the request | `.ulpi/spec/<name>.md` | spec exists; all acceptance criteria testable; non-goals stated; open questions resolved or flagged |
| 2 | auto-plan | the spec | `.ulpi/plans/<name>.json` (single canonical artifact; the human view is rendered on demand, never stored) | DAG acyclic + topologically layered; every spec criterion covered; self-review clean |
| — | **APPROVAL** | the plan | user affirmative | unambiguous "approve/go/yes" (the single human gate) |
| 3 | auto-build | the plan | integrated commits per task | all tasks `done` (none blocked/dep_blocked); final workspace validate GREEN |
| 4 | auto-simplify | the build diff | cleaner diff | every kept edit verified behavior-preserving; suite still green |
| 5 | auto-test | the codebase | added tests, green suite | scoped suite green; added tests mutation-verified; nothing skipped/weakened |
| 6 | auto-review | the diff | verified findings | every dimension ran (fail closed on gaps); confirmed blockers resolved (or surfaced) |
| 7 | auto-performance | the target | measured optimizations | (if run) each kept change benchmark-proven + no regression; else skipped |
| 8 | auto-ship | verified work | PR / staged rollout | pre-launch gates green (fail closed); rollback ready; human sign-off for irreversible deploy |

A gate is fail-closed: a phase that did not reach its bar (a blocked/unbuilt build task, a red validate,
an unrun review dimension, a died phase agent) is recorded `blocked` (never `done`) and its items go to
the `openRegister` — so `converged` is false and, critically, a RESUME re-enters that phase rather than
skipping it. The run is ONE forward pass: downstream phases still execute over whatever integrated
(except `auto-simplify`, which is skipped when the build is incomplete — there's no stable base to
simplify), and the pass returns the register at the end. The pipeline does NOT pause mid-run for a
blocked gate (a Workflow can't ask the user); the "escalate" is post-run — the USER reads the register
and decides the fix round. A hard escalation an engineer raises (a decision only the user can make)
blocks THAT task with the reason in the register; it does not silently guess past it.

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

ONE `checkpoint-resume` status file holds BOTH a `phases` map (the lifecycle phases) AND a top-level
`units` map with one entry per BUILD TASK — there is no separate per-phase checkpoint file; the build's
per-task units live in this same document (exactly what `checkpoint.mjs` writes and `pipeline-workflow.js`
reads via `doneUnits`/`openItems`):

```json
{
  "schemaVersion": 1,
  "id": "pipeline-<label>-<UTC>",
  "task": "<the request>",
  "status": "running",                 // running | done | needs_attention | aborted
  "currentPhase": "build",
  "launch": {                          // the durable resume recipe — written by `checkpoint.mjs init --launch`.
    "scriptPath": "<pipeline-workflow.js>",   // this is where the approval + config live durably:
    "args": { "workingBranch": "<branch>", "approved": true,   // approved:true IS the recorded human sign-off
              "config": { "simplify": true, "performance": false, "shipPrep": true },
              "delegate": { "build": "native", "review": "native", "verify": "native" } }
  },
  "phases": {
    "spec":        { "status": "done", "artifact": ".ulpi/spec/x.md" },      // skill-recorded, pre-launch
    "plan":        { "status": "done", "artifact": ".ulpi/plans/x.json" },   // skill-recorded, pre-launch
    "build":       { "status": "running" },                                  // ── the workflow owns these six keys ──
    "simplify":    { "status": "pending" },
    "test":        { "status": "pending" },
    "review":      { "status": "pending" },
    "performance": { "status": "skipped" },
    "ship_prep":   { "status": "pending" }
  },
  "units": {                             // one entry per BUILD TASK (auto-plan id), IN THIS SAME FILE
    "T1": { "status": "done" },
    "T2": { "status": "in_progress" }
  },
  "openItems": [],                       // verified findings persisted as each phase ends (the register)
  "result": null
}
```

## Resume (any-point)

On resume: the workflow's preflight reads the checkpoint and (a) SKIPS every phase whose key is
recorded `done` (canonical keys, written by the workflow itself: `build`, `simplify`, `test`,
`review`, `performance`, `ship_prep` — each phase writes `running` when it starts and `done` when it
ends), (b) rebuilds the register from the durably-persisted `openItems` of those done phases, and
(c) within the build, skips every `done` unit. The returned register is identical whether the run was
interrupted or not. Never restart from `spec`; never overwrite the pipeline checkpoint with a fresh
pending doc. `spec`/`plan`/approval are SKILL-owned phases (they happen before launch); the workflow
owns the six keys above.

## Escalation ↔ pause

Any phase's escalation (unfixable failure, ambiguity, irreversible step) sets the pipeline
`status: needs_attention`, records the blocking detail in `openItems`, and stops. The user resolves it
and re-invokes `autonomous-pipeline resume` — it continues from `currentPhase`. The pipeline never decides
a user-owned question to keep itself moving.

## One pass, then stop

After `auto-ship` (or an early fail-closed stop), the pipeline verifies + returns the `register` (rebuilt from the persisted `openItems`) and sets
`status` (`done` if empty and everything shipped, else `needs_attention`). It does NOT loop the lifecycle.
A fix round is a fresh invocation with the findings as the request.
