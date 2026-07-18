---
name: autonomous-pipeline
version: 0.1.1
description: |
  Run the whole engineering lifecycle end-to-end from one request — spec → plan → build → simplify → test
  → review → performance → ship — as a single autonomous pass with ONE human approval (the plan) and
  hard-gated escalation for anything irreversible. It chains the auto-* phase skills, carries a durable
  pipeline checkpoint so a stop/crash resumes at the exact phase and task it left off, watches the signal
  between phases (a phase that misses its gate is recorded blocked and surfaces in the register — fail closed, no false-green downstream), and returns a
  verified findings register at the end. Autonomous: it AUTO-FIXES the confirmed findings in a bounded
  converge-loop (never asking permission to fix), returning only the residual it can't converge within
  budget or a fix needing an irreversible/ambiguous decision. This is the top-level "maximise
  autonomous agents" entry point. Composes every auto-* phase plus checkpoint-resume, budget-guard,
  watch-and-act, and adversarial-verify.
allowed-tools:
  - Skill
  - Agent
  - Workflow
  - AskUserQuestion
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
disable-model-invocation: true
user-invocable: true
effort: high
argument-hint: "<feature request to take from idea to shipped> (or 'resume' to continue a run)"
arguments:
  - request
when_to_use: |
  Use when the user wants "prompt → spec'd, planned, built, cleaned, tested, reviewed, tuned, shipped" in
  one autonomous run rather than invoking each phase by hand. Do NOT use for a single phase (invoke that
  auto-* skill directly), or for a quick one-off edit. It spawns many agents across many rounds over the
  whole lifecycle — it is explicit-user-only.
---

<EXTREMELY-IMPORTANT>
This is the most powerful and the most dangerous skill here — the full lifecycle, unattended. It inherits
every phase's guardrails and adds pipeline-level ones. Non-negotiable:
1. ONE HUMAN GATE (plan approval); irreversible/ambiguous/unfixable situations from ANY phase still STOP
   and ask. Approval authorizes the plan, not surprises.
2. AUTO-FIX TO CONVERGENCE — BOUNDED, NEVER INFINITE. Autonomous means the pipeline FIXES what it finds; it
   NEVER hands you a list of confirmed blockers and asks permission to fix them. After review it runs a
   bounded fix converge-loop (`converge-loop` + `budget-guard`): fix the confirmed findings, regression-test,
   re-review, repeat until the register is clean. It STOPS and returns the STILL-OPEN residual ONLY when a
   termination condition fires — the fix budget/round-cap is exhausted without convergence, no-progress/thrash
   is detected, or a fix needs a genuinely irreversible/ambiguous human decision (that one escalates).
   Exhausted ≠ converged: a loop that spent its budget returns the open items, never a fabricated green.
3. PHASE GATES FAIL CLOSED. A phase that doesn't reach its bar (build blocked, red validate, unverified
   review, a died agent) is recorded `blocked` — never `done` — its items go to the register and
   `converged` is false, so a resume re-enters it and no phase ever hands a FALSE-GREEN forward. The run
   is ONE forward pass through the phases: rather than hard-stop mid-run (a Workflow can't ask the user),
   downstream phases still execute over whatever integrated and collect their findings (except auto-simplify,
   which needs a stable base and is skipped when the build is incomplete). Those findings feed the bounded
   auto-fix converge-loop (rule 2); only what it can't converge, or a fix needing an irreversible/ambiguous
   human decision, is returned open. Never fabricate a phase's clean verdict to keep the pipeline moving.
4. DURABLE, RESUMABLE. A pipeline checkpoint records the current phase + each phase's state; a stop/crash
   resumes at the exact phase/task, skipping completed work — never restarting from spec.
5. BUDGET THE WHOLE RUN. Declare a pipeline-level budget/escalation contract (`budget-guard`) on top of
   each phase's. The lifecycle is long; an unbounded pipeline is a runaway.
6. HONEST END STATE. Report what actually shipped, which gates ran, and the open findings — caveated by
   which phases the user chose to skip. Never present a pipeline with a dead gate or a red end-state as
   done.
</EXTREMELY-IMPORTANT>

# Autonomous Pipeline

## Overview

One request in, shipped-quality work out — by running the eight phases as one governed pass. The pipeline
is not magic autonomy; it's *disciplined* autonomy: a single approval, fail-closed gates between phases, a
durable checkpoint, a whole-run budget, and an honest findings register at the end. It removes the human
stepping between phases, not the verification each phase enforces.

## Phase order and gates

```
 auto-spec → auto-plan →[APPROVAL]→ auto-build → auto-simplify → auto-test → auto-review → auto-performance → auto-ship
    │            │                      │             │              │            │              │                │
 testable    acyclic DAG           all tasks     behavior-      green,       verified      measured, no      gates green,
   spec      + self-reviewed       integrated,   preserving     meaningful   findings      correctness       rollback ready,
             covers spec           tests green   cleanups       coverage     (no false +)  regression        human sign-off
```

Each arrow is a fail-closed gate: a phase that misses its bar is recorded `blocked` (never `done`) and its
items surface in the register so `converged` is false and a resume re-enters it — no phase hands a
false-green downstream. (The pass runs forward and collects findings rather than halting mid-run; the
register, not a mid-run stop, is what carries an unmet gate to the user.) The user may configure which
optional phases run (simplify/performance/go-live can be skipped);
build/test are not skippable. (This order follows spec→plan→build first; simplify runs against the
build's test safety net, test then hardens coverage.)

## Runtime backends — canonical deterministic coordinator vs. legacy Workflow

The unattended stretch runs on ONE of two backends. They are NOT peers: one is the canonical runtime, the
other a Claude-only compatibility shim.

- **CANONICAL — the deterministic coordinator CLI (`scripts/pipeline.mjs`).** A zero-dependency Node
  program: `node autonomous-pipeline/scripts/pipeline.mjs approve|start|resume|status|authorize`. This is
  the runtime the **Codex adapter launches** and the one Claude should prefer for a real run. The decisive
  property: **no model prompt owns Git, the checkpoint, the phase gates, or the convergence decision — the
  coordinator library (`scripts/lib/`) does, deterministically.** Model agents (native or Codex) appear
  ONLY as sandboxed, capability-free **per-task engineers**; Git integration (`git-integration.mjs`,
  `git-workspaces.mjs`), the locked checkpoint store, the fail-closed phase engine, the budget ledger, the
  capability-gated authorization, and the convergence conjunction (`pipeline-state.mjs`) are all machinery,
  not prose an LLM can talk its way past. A **BLOCKED required gate HARD-STOPS downstream execution** here
  (fail-closed): the run returns `status:blocked` / `converged:false` and no later phase runs.
  - `approve --plan <canonical.json> --config <run-config.json>` — validates the base is approval-ready,
    inits the durable run + immutable budget, enters the `prepared` window, and mints the ONE-USE,
    hash-bound plan-approval capability. **This IS the recorded human approval.** A human MUST sit between
    `approve` (mint) and `start` (consume) — the coordinator can never auto-chain the gate.
  - `start --run <id>` — runs every preflight refusal (plan/base/config drift, wrong target, dirty tree)
    and **consumes the one-use approval BEFORE a single executor spawns**, then drives build → post-build
    phases and publishes ONLY as a fast-forward after the explicit convergence conjunction + a durable
    finalize `done`. `resume --run <id>` continues from durable state (never erasing spend, never
    re-consuming the approval); `status --run <id>` is a read-only snapshot; `authorize --run <id> --action
    <ship|deploy|publish|remote-merge>` halts a converged run and mints a fresh, action-scoped capability
    for one irreversible step (a plan approval never satisfies an action). See `references/cli-contract.md`
    (grammar + exit codes), `references/budget-contract.md` (the immutable termination set), and
    `references/authorization-contract.md` (capability-gated approval + irreversible actions).
- **LEGACY (Claude-only) — `references/pipeline-workflow.js`.** A compatibility backend invoked via the
  Claude Code `Workflow` tool. The **Codex adapter cannot select it** (a Workflow needs the Claude Code
  runtime). Because a Workflow cannot ask the user or hard-pause mid-run, it does ONE FORWARD PASS
  collecting findings rather than hard-stopping on a blocked gate — an honestly-different shape documented
  in `references/pipeline-state.md`. Prefer the canonical CLI; reach for the Workflow only on a
  Claude-only install where launching the CLI is not an option.

## Phase 0: Intake — request, config, budget, mode

- **Ultracode precheck (parallel-effort mode — WARN, never block; runs on new runs AND resumes).**
  Build → review → verify fan out across many CONCURRENT agents (the `Workflow` backend + the Phase 1
  concurrency caps). That concurrency only materializes at the session's top **runtime effort level,
  `ultracode`** — a harness mode (ultrathink-style), NOT the static `effort: high` in this skill's
  frontmatter. Check it: Claude Code surfaces the state in your session context (a system-reminder noting
  ultracode on/off; the `Workflow` tool being your standing default is the tell). If you cannot confirm
  it is on, tell the user in one line — *"For the fastest run, enable **ultracode**, the max effort level
  for parallel work, so the build fans out across parallel agents: `/effort ultracode`, set the effort
  level to its max, or include `ultracode` in your request. Optional — without it the pipeline still
  completes with the SAME gates, checkpoints and findings register, just sequentially (slower)."* Then
  **proceed either way**; never gate the run on this.
- Detect **new run** vs **resume** (`$request` = "resume" / a pipeline checkpoint id → resume; skip
  intake, load the checkpoint, continue at the recorded phase).
- New run: capture the request; ask the FEW configuration questions (`AskUserQuestion`): which optional
  phases to run (simplify, performance, go-live/ship-deploy), and any budget/scope steer. Keep it light.
- **Codex delegation (D14 — offer ONLY if detected).** Probe for a Codex integration (`command -v codex`,
  or a `codex`-type subagent in your available agents). If — and only if — one is present, offer the user
  a choice to delegate any of three roles to Codex: **build** (the per-task engineer), **review** (the
  slice + dimension reviewers), **verify** (the adversarial finding-verifiers). Pass their choice as
  `delegate: { build|review|verify: 'native'|'codex' }`. If Codex is NOT detected, do not mention it —
  every role runs native. (At run time, a `codex` role with no integration DEGRADES to native and the
  degradation is recorded in the register — never a silent skip.)
- **Note which specialists are actually installed** — the subagent types available to you and the domain
  skills in your available-skills list. `auto-plan` routes each task to the best fit BY DESCRIPTION (a
  Next.js task → whatever React/SSR specialist exists, whatever it's named), and you pass that installed
  set to the Workflow as `availableAgents` so a plan-assigned name that isn't present here degrades to a
  general engineer (recorded in `missingAgents`) instead of hard-failing. Never route on a guessed name.
- Verify a git work tree + working branch; declare the pipeline `budget-guard` contract; create the
  pipeline `checkpoint-resume` file (one unit per build task (phase statuses live in the same file)).

**Success criteria:** run mode determined; ultracode precheck surfaced (or confirmed on); phase config +
budget set; git preflight passed; checkpoint open.

## Phase 1: Run the lifecycle (one approved pass)

The skill owns the human-facing front half (intake, spec, plan, and the single approval); a backend owns
the unattended stretch. Pick the backend by install: **Codex (and any Claude run that prefers determinism)
uses the canonical CLI** — after the approval is RECORDED (`pipeline.mjs approve`, which mints the one-use
capability), a human confirms and the run is launched with `pipeline.mjs start --run <id>`; Git,
checkpoints, gates and convergence are the coordinator's, never a prompt's (see **Runtime backends**
above). The steps below describe the **legacy Claude `Workflow`** path (`references/pipeline-workflow.js`),
which the Codex adapter cannot select:

1. **spec → plan** run first, in-session, by FOLLOWING their contracts (they may ask questions, so they
   stay outside the Workflow). Compose them by CONTRACT, not by a programmatic `Skill()` call: `auto-spec`,
   `auto-plan`, `auto-map` and `auto-learn` are `disable-model-invocation` skills (expensive, explicit-
   invocation only), and the docs are explicit that dmi *blocks programmatic invocation* — so a
   `Skill(auto-spec)` from here would fail. Instead read the installed skill's `SKILL.md` (find it under
   `.claude/skills/`, `.agents/skills/`, or the plugin root) and execute its phases directly; if it isn't
   installed, apply the methodology inline. Then the SINGLE approval gate on the plan (unambiguous
   affirmative).
2. **Create the checkpoint** (`checkpoint-resume`'s `scripts/checkpoint.mjs init`) — the Workflow
   sandbox has no filesystem access, so the skill creates the status file before launch. Pass
   `--launch '{"scriptPath":"<pipeline-workflow.js>","args":{…the full launch args…}}'` so the exact
   relaunch recipe is persisted IN the status file — then `run-status.mjs --resume` can reconstruct the
   resume with no session memory.
3. **Launch `references/pipeline-workflow.js` via the Workflow tool** with full args:
   - **required**: `root`, `workingBranch`, `validate` (the whole-workspace end-state gate), `planPath`
     (the approved DAG plan), `approved: true`, `statusFile`, `checkpointCli` (absolute path to
     `checkpoint-resume/scripts/checkpoint.mjs` — the status-writer agents call it).
   - **routing/quality**: `availableAgents` (the installed specialist set from Phase 0 — each task's
     plan-assigned agent/reviewer is honored when present, degrades to general when not, recorded in
     `missingAgents`), `allowGeneralFallback` (default true — degrade a missing specialist rather than
     crash), and `planValidator` (absolute path to `auto-plan/scripts/validate-plan.mjs` — the
     DETERMINISTIC DAG gate preflight runs; pass it so a cyclic/mis-ordered plan can't pass on model
     judgment. Without it, preflight falls back to an LLM plan check).
   - **budget/config**: the optional-phase `config` (`{simplify, performance, shipPrep}`), `budgetFloor`
     (default 60000 — stop-and-report at a phase boundary once the run dips below it), the concurrency
     caps (`maxBuildParallel`, `maxParallel`, `maxFix` per-task, `maxFixRounds` for the Phase-2 register
     converge-loop), and `delegate` (D14 — the per-role Codex choice).
   It executes
   build → simplify → test → review → performance → ship-prep with fail-closed gates (a phase agent that
   died = a gate failure in the register; skipped ≠ clean), the DAG walk with worktree isolation and
   bounded fix loops (each engineer/reviewer routed to its task's specialist), and per-task checkpoint
   writes. It hard-throws without `approved: true` — the human gate cannot be bypassed.
4. AROUND the workflow (before launch / after it returns), use `watch-and-act` to gate on external signals — e.g. CI green on the pushed branch before offering a fix round. (A Workflow cannot invoke skills mid-run.)
4b. **After EVERY run (even a bumpy one)**, close by following the `auto-learn` contract (again by
   CONTRACT — it's a dmi skill; read its installed `SKILL.md` and execute it, don't `Skill()` it) —
   harvest the checkpoint's register/blocked-units/degradations into verified, routed learnings so the
   next run doesn't repay this run's tuition. Machine defects it finds are surfaced in the final report,
   never self-patched.
4c. **After a real (non-aborted) run**, then follow the `auto-map` contract (same — read its `SKILL.md`,
   don't `Skill()` it) — refresh the disclosure-tiered context map so every future session starts knowing
   the code that just shipped. (Learn first: learnings may update rules the map refresh then verifies.)
5. Any escalation (unfixable/ambiguous/irreversible) surfaces in the returned register and PAUSES the
   pipeline; on resolution, re-invoke — the checkpoint resumes at the exact phase/task.

**Querying a run (any time, from any session):** `node <checkpoint-resume>/scripts/run-status.mjs`
renders the newest run — phases, per-task progress, the open register, and the resume command — READ-
ONLY, so it's safe to run while the pipeline is in flight. `--list` shows all runs; `--resume` emits the
exact Workflow call to continue. This is how the user checks "where's my run at?" without touching it.

**Native /goal framing (Claude Code):** for a fully unattended run, set the session goal to the
pipeline's Output Contract before launching — `/goal` pins the done-condition ("workflow returned
converged:true with an empty register; every gate ran") and the platform's independent verifier model
checks it, so the actor never grades itself. See `converge-loop`'s
`references/native-goal-loop.md` for the full termination-set → /goal compilation.

See `references/pipeline-state.md` for the state machine, per-phase gate conditions, and the handoff
contract.

**Success criteria:** each phase reached its success bar before the next began; the checkpoint reflects
progress; escalations reached the user, not a guessed-through continuation.

## Phase 2: Fix to convergence (bounded auto-loop)

- Collect the phases' findings (review blockers, perf gaps, ship blockers), dedup, and `adversarial-verify`
  the aggregate so only real, confirmed items enter the fix loop.
- Run a BOUNDED fix converge-loop on the confirmed register — do NOT ask permission: fix the findings
  (slice-scoped, each staying inside its task's write scope), regression-test, re-review, and repeat until
  the register clears. The loop's termination set is explicit and declared up front (`converge-loop` +
  `budget-guard`): a max round cap, the whole-run budget floor, and a no-progress/thrash stop.
- STOP the loop and return the STILL-OPEN residual ONLY when a termination condition fires — budget/cap
  exhausted without convergence, no progress across a round, or a fix that needs an irreversible or
  ambiguous human decision (that one escalates and asks). Exhausted ≠ converged: report the residual as
  OPEN with the termination reason, never a fabricated green.

**Success criteria:** the register is driven to clean, OR the honestly-open residual is returned WITH the
termination reason — and no permission question was asked about fixing confirmed findings.

## Phase 3: Report

Read the pipeline checkpoint and report end-to-end (see Output Contract): what each phase produced, which
gates ran vs. were skipped (by user config), what shipped, and the open register. Fail closed — a run with
a dead gate or a red end-state is not "done".

**Success criteria:** an honest, phase-by-phase account; the durable checkpoint reflects the final state.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "It's autonomous, so just return the findings and let the user fix them." | Autonomous means it FIXES what it finds — it never asks permission to fix confirmed blockers. It auto-fixes to convergence. |
| "Auto-fix means loop until everything's perfect." | Auto-fix is BOUNDED: a max round cap + the run budget + a no-progress stop. It converges, or returns the open residual honestly. Unbounded looping is the multi-hour-grind failure mode; the termination set prevents it. |
| "Build came back with blocked tasks but let's just run review anyway." | A phase that didn't meet its bar hands a false-green downstream. Gates fail closed — pause or escalate. |
| "The user approved the plan, so I can deploy too." | Plan approval ≠ deploy approval. Irreversible steps in any phase still need explicit sign-off. |
| "Resume by re-running from spec, it's cleaner." | That redoes finished work and can diverge from what shipped. Resume from the checkpoint at the recorded phase. |
| "Report it as shipped — most of it worked." | Partial is not done. Report what shipped, which gates ran, and the open register honestly. |
| "Skip the budget, the phases have their own." | The lifecycle is long; phase budgets don't bound the whole. Declare a pipeline budget too. |

## Red Flags

- The auto-fix converge-loop running WITHOUT a declared termination set (max rounds + budget + no-progress) — it must be bounded, or it's the multi-hour-grind failure mode.
- Returning confirmed, mechanically-fixable blockers UNFIXED and asking the user whether to fix them — autonomous means fix them.
- A downstream phase started while the upstream phase had unresolved blockers.
- A deploy/irreversible step taken on the strength of the plan approval alone.
- A resume that restarted from spec and redid integrated work.
- "Shipped" reported while a gate didn't run or the end-state validate is red.
- No pipeline-level budget declared for a full lifecycle run.

## Guardrails

- One approval gate (the plan); every irreversible/ambiguous/unfixable situation still escalates.
- Auto-fix the confirmed register to convergence, BOUNDED by a termination set (max rounds + budget + no-progress); return only the residual it can't converge or a fix needing an irreversible/ambiguous decision — never ask permission to fix confirmed findings.
- Phase gates fail closed; never pass a false-green downstream.
- Durable resume from the checkpoint; never restart from spec.
- Declare and enforce a pipeline-level budget.
- Report the honest end state, caveated by which phases were skipped.

## When To Load References

- `scripts/pipeline.mjs` — the **canonical deterministic coordinator CLI** (the Codex runtime):
  `approve|start|resume|status|authorize`. Run it (after a recorded `approve`) instead of the Workflow
  whenever determinism is wanted or Codex is the host; its `scripts/lib/` modules own Git, the checkpoint,
  the gates, and convergence. Read the three contracts below to drive it safely.
- `references/cli-contract.md` — the CLI's five-verb grammar, flags, and pinned exit-code table (the
  human-readable spec; `scripts/lib/cli-contract.mjs` is the enforced one). Load before scripting the CLI.
- `references/budget-contract.md` — the immutable termination set (the whole-run budget/no-progress/
  escalation bound the coordinator enforces). Load when setting or reasoning about a run's budget.
- `references/authorization-contract.md` — the capability-gated plan approval + irreversible-action model
  (`approve`/`authorize`). Load before wiring approval or any ship/deploy/publish/remote-merge step.
- `references/pipeline-workflow.js` — the LEGACY Claude-only Workflow backend for the unattended stretch
  (build → simplify → test → review → performance → ship-prep, forward-pass, checkpointed). The Codex
  adapter cannot select it. Launch via the Workflow tool with full args after the plan approval; edit +
  relaunch (same scriptPath) to iterate.
- `references/pipeline-state.md` — the phase state machine, per-phase gate conditions, the phase-to-phase
  handoff contract, the checkpoint v2 schema, and the canonical-hard-stop vs. legacy-forward-pass
  divergence. Load when wiring or resuming a run.
- The phase skills — `auto-spec`, `auto-plan`, `auto-build`, `auto-simplify`, `auto-test`, `auto-review`,
  `auto-performance`, `auto-ship` — each runs its own phase to its own bar.
- `checkpoint-resume` (skill) — the durable pipeline + per-phase state.
- `budget-guard` (skill) — the whole-run budget + escalation contract.
- `watch-and-act` (skill) — wait on CI/deploy signals between phases.
- `adversarial-verify` (skill) — verify the returned findings register.

## Output Contract

Report:

1. the run config — which phases ran vs. skipped; the working branch; the single approval recorded
2. per phase: outcome + gate status (met its bar / blocked / skipped); which specialists the build
   actually routed to (`specialistsUsed`) and any plan-assigned specialist that was absent here and so
   ran generic (`missingAgents` — surface it so the user can install the missing agent/skill)
3. ship-prep artifacts produced (changelog + PR body draft — OPENING the PR / deploying is the user's explicitly-gated step) and the end-state validate result (honest)
4. the fix-loop outcome — the count of confirmed findings AUTO-FIXED to convergence, and the STILL-OPEN
   residual (if any) with its termination reason (budget/cap exhausted, no-progress, or an escalated
   irreversible/ambiguous fix) — never an unfixed register presented as a menu of choices
5. the pipeline checkpoint path (durable, resumable record) + the one-liner to query it any time
   (`run-status.mjs` for a rendered view, `run-status.mjs --resume` for the relaunch call)
