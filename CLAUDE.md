# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

**Read `AGENTS.md` first.** It is the shared, provider-neutral contributor guide and the single source of
truth for the repository architecture: the deterministic coordinator
(`autonomous-pipeline/scripts/pipeline.mjs` + `scripts/lib/`), the dual Claude + Codex provider adapters
(`codex-skills/` + `catalog.json`; the Claude root skill dirs), the Codex packager
(`scripts/package-codex-plugin.mjs`), and the **full validation command list** (skill/hook validation,
the `node --test` suites, the shell suites, the Codex packager test, and the `--live` smoke). This file
does NOT duplicate that — it adds only what is specific to running and authoring the collection **on
Claude Code**.

## The collection in one line

**@ulpi/skills-autonomous-engineering** turns the software delivery lifecycle into **autonomous, loop- and
workflow-driven** phases (`auto-spec → auto-ship`) on top of durable loop / adversarial-verify /
checkpoint / fan-out / budget-guard primitives. It ships to **both Claude Code and Codex** from one source
and is distributed via [skills.sh](https://skills.sh).

Install all: `npx skills add https://github.com/ulpi-io/skills-autonomous-engineering`
Install one: `npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill <name>`

## Core contracts (hold on every platform)

These are non-negotiable here, whichever agent runs — the difference between "autonomous" and "runaway":

- **Bounded, never infinite.** Every loop declares a **termination set** — a done-condition, a
  max-iteration cap, a token budget, a no-progress/anti-thrash stop, plus escalation triggers. When any
  fires the loop STOPS and reports; it never spins. See `converge-loop`, `budget-guard`.
- **Fail-closed gates.** A gate that did not run is NEVER reported clean; exhausted ≠ converged. A loop
  that spent its budget without converging returns the open items — no fabricated green.
- **Verify before acting.** Findings/claims that drive mutations are adversarially refuted (N skeptics,
  majority-refute) before they are acted on. See `adversarial-verify`.
- **Durable + resumable.** Long runs checkpoint to `.ulpi/runs/<id>.json`; resume skips done units and
  never restarts integrated work — session-independent, not cache-dependent. See `checkpoint-resume`.
- **Escalate, don't guess.** Irreversible or ambiguous decisions that are the human's stop and surface.
- **Measure, don't assume.** `auto-performance` accepts an optimization only when a benchmark proves it
  faster with no correctness regression.

## Claude-Code-first: the autonomy primitives this collection targets

The skills degrade to descriptive guidance on other agents, but they are built to **exploit Claude Code's
real autonomy primitives** — this is why the collection is Claude-first:

- the **`Agent`** tool (background execution + worktree isolation + fork),
- the **`Workflow`** tool (deterministic multi-agent JS orchestration),
- **`ScheduleWakeup`** / **`/loop`** (self-paced loops),
- the **`/schedule`** skill + **`RemoteTrigger`** (durable recurring cloud Routines),
- **`CronCreate`** (session-only, in-process cron).

On a native goal loop, compile a skill's termination set into **`/goal` + `/loop`** — see
`converge-loop/references/native-goal-loop.md`. (Codex offers `/goal`; the provider-neutral path is the
deterministic coordinator in `AGENTS.md`.)

## Workflow-tool backend compatibility (Claude-specific)

- `autonomous-pipeline/references/pipeline-workflow.js` and `auto-review/references/review-workflow.js`
  are **Workflow-tool templates** and must stay inside the Workflow JS sandbox: **no**
  `Date.now` / `Math.random` / arg-less `new Date` / `require` / ESM `import`.
  `scripts/validate-skills.mjs` enforces these banned constructs.
- `review-workflow.js` is **legacy and Claude-only** — the Codex artifact deliberately excludes it
  (asserted by `scripts/test-review-workflow-claude-only.sh`). The provider-neutral review path is the
  coordinator's `review-panel.mjs`.

## Claude plugin + hook wiring (Claude-specific)

- `.claude-plugin/plugin.json` (`skills: "./"`, `hooks: "./hooks/hooks.claude.json"`) + `marketplace.json`.
- **`hooks/hooks.claude.json`** wires the Claude hook events, each enforcing ONE guarantee (a hook exists
  for a guarantee, not for coverage — the rest of Claude Code's events stay deliberately unused):
  - **PreToolUse** guards — test-integrity, git-hygiene, ship-irreversibility (same guards as the
    SKILL-scoped `<skill>/scripts/guard-*.sh` frontmatter hooks; the plugin manifest self-scopes them to
    live `.ulpi/runs/*`).
  - **Stop** → `hooks/honest-stop.sh` — surfaces a run left `status:running` so the turn reconciles the
    checkpoint with reality (NO-OP outside a live run; non-blocking reminder, `ULPI_STOP_STRICT=1`
    hard-blocks).
  - **SessionStart** → `hooks/session-start-announce.sh` — injects any resumable run into the opening
    context so a fresh session never blindly re-inits or redoes integrated work (read-only, bounded).
  - **SessionEnd** → `hooks/session-end-gc.sh` — archives terminal runs via `checkpoint.mjs gc`.
    **SessionEnd is Claude-only** (unsupported on Codex); `validate-skills.mjs --hooks` enforces the
    provider split between `hooks.claude.json` and the Codex `hooks/hooks.json`.
- Guards are real scripts owned by their skill; the SKILL.md hook frontmatter carries only the thin
  resolver line (finds the script across install layouts, fail-OPEN if absent — a guard must never brick
  a session).

## Authoring a skill (house format)

A skill is a self-contained directory: `SKILL.md` (contract) + optional `references/` (loaded on demand)
+ optional `scripts/` (executable helpers/guards — `bash -n` / `node --check` clean, `chmod +x`).

```yaml
---
name: skill-name
version: X.Y.Z
description: |
  What the skill does and precisely when to invoke it (trigger-rich — the model routes on this).
allowed-tools: [Agent, Workflow, Bash, Read, Write]   # declare the MINIMUM; add Write/Edit only if it mutates files
effort: high            # optional
argument-hint: "<...>"  # optional
when_to_use: |          # optional but recommended: explicit use-when / do-NOT-use-when
---
```

Body follows the house structure: an `<EXTREMELY-IMPORTANT>` guardrail block (termination, budget,
honesty) → numbered **phases** with explicit **success criteria** → `## Guardrails` (the "never" rules) →
`## When To Load References` → `## Output Contract`.

Conventions:

- **Versioning**: semver in frontmatter. Commit: `<Skill Name> v<X.Y.Z> — <changelog summary>`.
- **Self-contained and best-in-class**: every skill is complete and superior ON ITS OWN; it never depends
  on another skill pack for core value and our docs never point a reader at an external pack. It MAY
  orchestrate other installed skills/agents/tools when present, but its quality never hinges on them.
- **State under `.ulpi/`**: specs in `.ulpi/spec/`, plans in `.ulpi/plans/`, run status in
  `.ulpi/runs/<id>.json`.
- When editing a skill, read the full `SKILL.md` first — the `<EXTREMELY-IMPORTANT>` block and phase
  success criteria define its contract. Compose the primitives instead of re-deriving
  loop/verify/checkpoint logic.

Every change must pass the validation in `AGENTS.md` (run `node scripts/validate-skills.mjs --surface all
--hooks` at minimum); CI runs the full suite on pushes to main and every pull request.
