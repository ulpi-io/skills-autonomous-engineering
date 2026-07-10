# Pipeline State Machine, Gates & Handoffs

Load when wiring or resuming an `autonomous-pipeline` run. Defines the phase order, the fail-closed gate
each phase must clear before the next starts, the phase-to-phase handoff, and the checkpoint schema.

This doc is shared by BOTH backends (see the skill's **Runtime backends** section), which differ on ONE
axis — what a blocked required gate does mid-run:

- **CANONICAL — the deterministic coordinator CLI (`scripts/pipeline.mjs` + `scripts/lib/`).** A BLOCKED
  required gate **HARD-STOPS downstream execution**: the phase engine gates every later phase
  (`upstream-blocked`, never run), the coordinator returns `status:blocked` / `converged:false` at exit
  `4`, and no subsequent phase touches the tree. This is the runtime the Codex adapter launches; the
  state machine below (`pipeline-state.mjs`) is its literal source of truth.
- **LEGACY (Claude-only) — the `Workflow` template (`pipeline-workflow.js`).** A Workflow cannot ask the
  user or hard-pause, so instead of hard-stopping it does ONE FORWARD PASS: downstream phases still run
  over whatever integrated (except `auto-simplify`, skipped when the build is incomplete — no stable base)
  and it returns the collected findings register at the end. Same fail-closed *bookkeeping* (a missed bar
  is recorded `blocked`, never `done`; `converged` stays false), different *sequencing*. This paragraph is
  the ONLY place the two diverge — attribute any "forward pass" statement below to THIS legacy backend.

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

A gate is fail-closed in BOTH backends: a phase that did not reach its bar (a blocked/unbuilt build task,
a red validate, an unrun review dimension, a died phase agent) is recorded `blocked` (never `done`) and
its items go to the open register — so `converged` is false and, critically, a RESUME re-enters that phase
rather than skipping it. Where they diverge is sequencing:

- **Canonical coordinator:** a blocked required gate HARD-STOPS. The post-build phases run sequentially and
  the first blocked required phase gates every later one (`upstream-blocked`); the run exits `blocked`
  without touching downstream. The USER reads the register and re-invokes `resume` after fixing.
- **Legacy Workflow:** the run is ONE forward pass — downstream phases still execute over whatever
  integrated (except `auto-simplify`, skipped when the build is incomplete — there's no stable base to
  simplify), and the pass returns the register at the end. It does NOT pause mid-run for a blocked gate
  (a Workflow can't ask the user); the "escalate" is post-run.

In either backend a hard escalation an engineer raises (a decision only the user can make) blocks THAT
task with the reason in the register; it does not silently guess past it.

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

## Pipeline checkpoint schema (v2)

ONE `checkpoint-resume` status file holds BOTH a `phases` map (the lifecycle phases) AND a top-level
`units` map with one entry per BUILD TASK — there is no separate per-phase checkpoint file. Both backends
share ONE locked, atomic store (`checkpoint-resume/scripts/lib/checkpoint-store.mjs`): the canonical
coordinator imports it in-process; the legacy Workflow's status agents shell out to `checkpoint.mjs`.

New runs are written at **`schemaVersion: 2`** (a v1 run loads/resumes/finalizes unchanged — the only
mutation is an idempotent, add-only upgrade that inserts `resolvedItems: []` + bumps the version, never
rewriting existing units/phases/openItems/launch). v2 adds: **stable-id findings**, a durable
**`resolvedItems`** audit trail (findings MOVE `openItems → resolvedItems`, stamped `resolvedAt`, when
cleared — so a converged run still shows what was resolved), and a typed `launch` recipe.

Canonical state vocabularies (`checkpoint-store.mjs`):
- **unit** (build task) states: `pending | in_progress | done | blocked | dep_blocked` (`done` is
  terminal-forward — never demoted).
- **phase** states: `pending | running | done | blocked | skipped` (`running` = in-progress/crashed
  mid-flight, NON-terminal → re-entered on resume; only `done`/`skipped` are terminal).

```json
{
  "schemaVersion": 2,
  "id": "pipeline-<label>-<UTC>",
  "task": "<the request>",
  "status": "running",                 // running | done | needs_attention | aborted (canonical also: blocked / awaiting_authorization)
  "currentPhase": "build",
  "launch": {                          // the durable resume recipe — written by `checkpoint.mjs init --launch`.
    "scriptPath": "<pipeline-workflow.js>",   // legacy backend; the canonical CLI resumes by `--run <id>` (approval lives in a capability, see below)
    "args": { "workingBranch": "<branch>", "approved": true,   // legacy: approved:true IS the recorded sign-off; canonical: the ONE-USE plan capability is
              "config": { "simplify": true, "performance": false, "shipPrep": true },
              "delegate": { "build": "native", "review": "native", "verify": "native" } }
  },
  "phases": {
    "spec":        { "status": "done", "artifact": ".ulpi/spec/x.md" },      // skill-recorded, pre-launch
    "plan":        { "status": "done", "artifact": ".ulpi/plans/x.json" },   // skill-recorded, pre-launch
    "build":       { "status": "running" },                                  // ── the backend owns these six keys ──
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
  "resolvedItems": [],                   // v2: findings cleared from the register (audit trail, stamped resolvedAt)
  "result": null
}
```

In the canonical coordinator the plan approval is NOT the `approved:true` flag above — it is a one-use,
hash-bound capability minted by `approve` and consumed by `start` (see
`references/authorization-contract.md`); `approved:true` is the legacy Workflow's recorded sign-off.

## Convergence conjunction

The single done-condition (`doneCondition: convergence-v1`) is `pipeline-state.mjs`'s `converged()` —
`converged === convergenceFailures(state).length === 0`. A run is converged ONLY when ALL hold:

1. **every build unit is `done`** (any non-`done` unit → `unit-unfinished`);
2. **every required phase is `done`**, and every optional phase is `done` or legitimately `skipped` (a
   required phase `skipped` → `required-phase-skipped`; anything else non-green → `phase-not-green`);
3. **no unresolved blocker** — nothing in `blocked` (`blocked-unit` / `blocked-phase`) AND an empty open
   register (`open-register`);
4. **final validation is present AND green** (absent → `final-validation-missing`; red →
   `final-validation-red`).

The canonical coordinator evaluates this conjunction over the DURABLE checkpoint as the single gate to
finalize + publish; a non-empty failure list means `converged:false` and the run reports the exact
failures honestly — it never asserts a green verdict to exit.

## Resume (any-point)

On resume (canonical `pipeline.mjs resume --run <id>`, or the legacy Workflow relaunched with the same
args) the backend reads the checkpoint and (a) SKIPS every phase whose key is recorded `done` (the six
backend-owned keys: `build`, `simplify`, `test`, `review`, `performance`, `ship_prep` — each writes
`running` when it starts and `done` when it ends), (b) rebuilds the register from the durably-persisted
`openItems`, and (c) within the build, skips every `done` unit. The canonical coordinator additionally
reconciles crashed budget segments (never erasing spend or no-progress counters) and NEVER re-consumes or
re-mints the plan approval. The returned register is identical whether the run was interrupted or not.
Never restart from `spec`; never overwrite the pipeline checkpoint with a fresh pending doc.
`spec`/`plan`/approval are SKILL-owned phases (they happen before launch); the backend owns the six keys.

## Escalation ↔ pause

Any phase's escalation (unfixable failure, ambiguity, irreversible step) sets the pipeline status to a
non-terminal, attention-needing state (`needs_attention`, or the canonical coordinator's `blocked`),
records the blocking detail in `openItems`, and stops. In the canonical coordinator an irreversible action
additionally halts at `awaiting_authorization` and requires a fresh action capability (see
`references/authorization-contract.md`). The user resolves it and re-invokes `resume` — it continues from
`currentPhase`. The pipeline never decides a user-owned question to keep itself moving.

## One pass, then stop

After `auto-ship` (or an early fail-closed stop), the pipeline verifies + returns the `register` (rebuilt from the persisted `openItems`) and sets
`status` (`done` if empty and everything shipped, else `needs_attention`). It does NOT loop the lifecycle.
A fix round is a fresh invocation with the findings as the request.
