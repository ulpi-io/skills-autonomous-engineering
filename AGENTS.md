# AGENTS.md — Autonomous Engineering Skills

This repository is a collection of **agent skills for autonomous software delivery**: the lifecycle as
bounded, self-correcting, checkpoint-resumable phases with deterministic enforcement. It ships as a native
**Claude Code** plugin and installs into other agents via **skills.sh** from one source of truth. This is
the **shared contributor guide** — read it first no matter which agent you run; it is provider-neutral and
self-sufficient. Claude-specific routing and Workflow-backend notes live in `CLAUDE.md`, and nothing here
depends on reading that file. (The Codex-native plugin — thin adapters, a manifest, and a reproducible
marketplace packager — is developed on the `codex-native-plugin` branch, not on `main`.)

## What lives here

- **Phase skills** (`auto-*/SKILL.md`) — one per delivery step:
  `auto-spec → auto-plan → auto-build → auto-simplify → auto-test → auto-review → auto-performance → auto-ship`
- **Primitives** — `converge-loop` (bounded until-green/until-dry loops), `adversarial-verify`
  (majority-refute skeptic panels), `checkpoint-resume` (durable skip-done state), `fan-out-work`
  (capped parallel map — on Claude Code its concurrency needs the `ultracode` effort level, else it runs
  sequentially with identical results; the deterministic CLI coordinator parallelizes via its own config),
  `budget-guard` (the five stop conditions every unattended run declares).
- **Autonomy layer** — `autonomous-pipeline` (chains the phases; single human approval; runnable
  deterministic coordinator), `watch-and-act` (bounded external polling), `schedule-recurring-agent`
  (idempotent recurring routines), `auto-map` (verified disclosure-tiered context maps), `auto-learn`
  (harvests every run's artifacts into verified, routed learnings — the self-improvement loop).
- **Enforcement** — `<skill>/scripts/guard-*.sh` hooks that mechanically block the cardinal sins
  (gaming tests green, bulk git staging, unauthorized force-push) while a skill is active, plus the
  lifecycle hooks under `hooks/` (honest-stop, session-start resume announce, session-end gc).

## The deterministic coordinator

The autonomy is not prose — `autonomous-pipeline` is backed by a real, testable coordinator:

- **`autonomous-pipeline/scripts/pipeline.mjs`** — the public CLI entrypoint. It owns only the grammar
  + pinned exit-code table, one-JSON-object-on-stdout in `--json` mode, and run-file location
  (`<runsDir>/<id>.json`, `ULPI_RUNS_DIR` or `<cwd>/.ulpi/runs`). Node 22+, zero external deps.
- **`autonomous-pipeline/scripts/lib/`** — the engine, split by responsibility and unit-tested in
  isolation: `cli-contract.mjs` (argv/flags/exit codes), `pipeline-engine.mjs` + `pipeline-state.mjs`
  (the state machine and legal/illegal transitions), `phase-engine.mjs` (fail-closed phase gates),
  `build-engine.mjs` (slice-scoped build DAG), `review-panel.mjs` (adversarial verify / majority-refute),
  `budget-ledger.mjs` (token/iteration accounting + caps), `authorization.mjs` (permission boundaries),
  `git-workspaces.mjs` + `git-integration.mjs` (worktree isolation + merge safety), `codex-executor.mjs`
  + `process-runner.mjs` (the agent executor seam). Heavyweight execution is injected as `seams` so the
  coordinator runs hermetically under tests with a fake runtime.

## The skills (authoring source + discovery)

The 18 canonical skills live in the **root skill dirs** (`auto-spec/`, `converge-loop/`, …). Each is a
directory with a `SKILL.md` (frontmatter `name` + `description` for routing; the body is the operating
procedure) plus optional `references/` (loaded on demand) and `scripts/` (executable helpers — run them
rather than re-implementing their logic). The Claude plugin manifest (`.claude-plugin/plugin.json`,
`skills: "./"`) discovers these directly; **skills.sh** adapts the same source into other agents.

The Codex-native discovery surface — thin `codex-skills/` adapters that `delegate` to these root skills, a
sealed `catalog.json`, the `.codex-plugin/` manifest, and the reproducible `package-codex-plugin.mjs`
marketplace packager — is developed on the `codex-native-plugin` branch, not on `main`.

## The contract every skill honors

Stated plainly, provider-independent — these are what separate "autonomous" from "runaway":

1. **Bounded — never infinite.** No loop without a declared **termination set**: a done-condition, a
   max-iteration cap, a token budget, and a no-progress/anti-thrash stop, plus escalation triggers. When
   any fires the loop STOPS and reports — it never spins. See `converge-loop` and `budget-guard`.
2. **Fail-closed gates.** A gate that did not run is NEVER reported clean; exhausted ≠ converged. A loop
   that spent its budget without converging says so and returns the open items — no fabricated green.
3. **Verify before acting.** Findings/claims that drive mutations are adversarially refuted (N skeptics,
   majority-refute) before they are acted on. See `adversarial-verify`.
4. **Durable + resumable.** Long runs checkpoint to `.ulpi/runs/<id>.json`; git-integrating coordinator
   and legacy Workflow runs reconcile resume from reachable `Task-Id` trailers, so a lost status write
   never restarts integrated work. Status is durable-primary with a best-effort live overlay; the session
   journal is never a dependency. See `checkpoint-resume`.
5. **Escalate, don't guess.** Irreversible or ambiguous decisions that are the human's to make stop and
   surface rather than looping or picking silently.
6. **Bind intake scope.** A named user selection is itemized as `selectedScope[]` before spec. The spec
   cannot demote an id to non-goals; every id maps to a task or a separately user-acknowledged drop.
   Approval renders per-id coverage, and uncovered scope blocks convergence.
7. **Close every run.** "Fix all" means the complete actionable register across all phases and severities.
   A successful convergence also requires durable `auto_learn` then `auto_map` receipts; a green build or
   plan approval cannot substitute for either closing phase.

## Using the skills (any agent)

Install via `npx skills add https://github.com/ulpi-io/skills-autonomous-engineering`, or as a native
Claude Code plugin from the marketplace manifest in `.claude-plugin/`. On platforms with a native goal
loop (Claude Code `/goal` + `/loop`; Codex `/goal`), compile the skill's termination set into it — see
`converge-loop/references/native-goal-loop.md`.

## Working ON this repo

- Skills are **self-contained**: never reference other skill packs or the local `site/` fixtures.
- Guards are real scripts owned by their skill; hook frontmatter carries only the resolver line.
- **State** lives under `.ulpi/`: specs in `.ulpi/spec/`, plans in `.ulpi/plans/`, run status in
  `.ulpi/runs/<id>.json`.

### Validation (run before every change — this is exactly what CI runs)

**Cross-surface skill / manifest / hook validation**

```
node scripts/validate-skills.mjs --surface all --hooks
```

Validates the skill surface: frontmatter shape, the routing-budget cap, reference/script integrity,
self-containment, the doc-honesty guard (no banned over-claims in README.md / any SKILL.md), and — with
`--hooks` — the Claude hook manifest. (The validator also checks the Codex adapter surface and its sealed
`catalog.json` when that tree is present — e.g. on the `codex-native-plugin` branch.)

**Shell suites (guards + gate contracts)**

```
bash scripts/test-guards.sh                 # guard block/allow/escape-hatch contract
bash scripts/test-checkpoint.sh             # checkpoint store lifecycle + fail-closed refusals
bash scripts/test-run-status.sh             # read-only run-status render/list/json/resume
bash scripts/test-map-verify.sh             # auto-map anti-lie gate
bash scripts/test-plan-validate.sh          # plan DAG structural judge
bash scripts/test-harvest.sh                # auto-learn harvest evidence
bash scripts/test-validate-skills.sh        # dual-surface flags + doc-honesty behavior
bash scripts/test-watch-state.sh            # durable cross-turn watch bounds
bash scripts/test-scheduled-job.sh          # scheduled-job schema/dedup/capability/teardown
```

**Node unit / E2E suites (`node:test`, mock/fake runtimes — no live agents, no network)**

```
node --test scripts/test-workflow-journal.mjs       # captured-format best-effort live overlay
node --test scripts/test-event-log.mjs              # opt-in append log + atomic snapshot recovery
node --test scripts/test-pipeline-state.mjs        # state machine transitions + convergence
node --test scripts/test-cli-contract.mjs          # argv/flag parsing + fail-closed refusals
node --test scripts/test-git-workspaces.mjs        # worktree isolation lifecycle
node --test scripts/test-git-integration.mjs       # merge/integration safety
node --test scripts/test-codex-executor.mjs        # buildCodexArgv + schema-output gate + runner
node --test scripts/test-budget-ledger.mjs         # token/iteration accounting + caps
node --test scripts/test-authorization.mjs         # permission/authority boundaries
node --test scripts/test-review-panel.mjs          # adversarial verify + majority-refute
node --test scripts/test-build-engine.mjs          # slice-scoped build DAG
node --test scripts/test-phase-engine.mjs          # fail-closed phase gates
node --test scripts/test-pipeline-cli.mjs          # coordinator command surface
node --test scripts/test-pipeline-e2e.mjs          # zero-network coordinator over temp repos + fake codex
node --test scripts/test-pipeline-security.mjs     # isolation + redaction under adversarial input
node --test scripts/test-ci-workflow.mjs           # every CI suite is a named, unmaskable, hermetic gate
node --test scripts/test-site.mjs                  # static-site routes/links/metadata/drift
node scripts/test-pipeline-workflow.mjs            # legacy workflow transitions under a mock runtime
```
