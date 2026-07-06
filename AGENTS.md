# AGENTS.md — Autonomous Engineering Skills

This repository is a collection of **agent skills for autonomous software delivery**: the lifecycle as
bounded, self-correcting, checkpoint-resumable phases with deterministic enforcement. If you are an AI
agent working in or with this repo, this file orients you.

## What lives here

- **Phase skills** (`auto-*/SKILL.md`) — one per delivery step:
  `auto-spec → auto-plan → auto-build → auto-simplify → auto-test → auto-review → auto-performance → auto-ship`
- **Primitives** — `converge-loop` (bounded until-green/until-dry loops), `adversarial-verify`
  (majority-refute skeptic panels), `checkpoint-resume` (durable skip-done state), `fan-out-work`
  (capped parallel map), `budget-guard` (the five stop conditions every unattended run declares).
- **Autonomy layer** — `autonomous-pipeline` (chains the phases; single human approval; runnable
  Workflow template), `watch-and-act` (bounded external polling), `schedule-recurring-agent`
  (idempotent cron routines).
- **Enforcement** — `<skill>/scripts/guard-*.sh` hooks that mechanically block the cardinal sins
  (gaming tests green, bulk git staging, unauthorized force-push) while a skill is active.
- **Runnable machinery** — `checkpoint-resume/scripts/checkpoint.mjs` (state CLI with fail-closed
  refusals), `autonomous-pipeline/references/pipeline-workflow.js` and
  `auto-review/references/review-workflow.js` (Workflow-tool templates).

## The contract every skill honors

1. **Bounded** — no loop without a declared termination set (done-condition, cap, budget, no-progress
   rule, escalation triggers).
2. **Fail-closed** — a gate that did not run is never reported clean; exhausted ≠ converged.
3. **Verify before acting** — findings are adversarially refuted before they drive edits.
4. **Durable** — long runs checkpoint to `.ulpi/runs/<id>.json`; resume skips done units, never
   restarts.
5. **Escalate, don't guess** — irreversible or ambiguous decisions go to the human.

## Using the skills (any agent)

Each skill is a directory with a `SKILL.md` (frontmatter `name` + `description` for routing; the body
is the operating procedure) plus optional `references/` (loaded on demand) and `scripts/` (executable
helpers — run them rather than re-implementing their logic). Install via
`npx skills add https://github.com/ulpi-io/skills-autonomous-engineering` or, on Claude Code, as a
plugin from the marketplace manifest in `.claude-plugin/`.

On platforms with a native goal loop (Claude Code `/goal` + `/loop`; Codex `/goal`), compile the
skill's termination set into it — see `converge-loop/references/native-goal-loop.md`. Codex-focused
routing is phase 2 of this collection; the structural compatibility (name+description routing,
`scripts/` anatomy) is already in place.

## Working ON this repo

- Read `CLAUDE.md` for conventions and the architecture rationale.
- Every change must pass `node scripts/validate-skills.mjs` (frontmatter shape, 1536-char routing
  budget, reference/script integrity, self-containment). CI runs it on every push.
- Skills are self-contained: never reference other skill packs or the local `examples/` folder.
- Guards are real scripts owned by their skill; hook frontmatter carries only the resolver line.
