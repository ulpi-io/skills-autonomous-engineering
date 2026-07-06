# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**@ulpi/skills-autonomous-engineering** — A collection of AI coding agent skills that turn the software
delivery lifecycle into a set of **autonomous, loop- and workflow-driven** phases. Distributed via
[skills.sh](https://skills.sh).

Install all skills: `npx skills add https://github.com/ulpi-io/skills-autonomous-engineering`
Install one skill: `npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill <name>`

This collection is **Claude-Code-first**: it leans on Claude Code's real autonomy primitives — the
`Agent` tool (background + worktree isolation + fork), the `Workflow` tool (deterministic multi-agent
JS orchestration), `ScheduleWakeup`/`/loop` (self-paced loops), and `CronCreate`/`/schedule` (recurring
cloud agents). The skills degrade to descriptive guidance on other agents but are built to exploit these.

## Architecture — four layers

A flat monorepo of independent skills — one self-contained directory per skill at the repo root.
Every artifact belongs to exactly one layer (a guardrail that is mechanically checkable must NOT ship
as prose-only):

1. **Knowledge** — the 16 `SKILL.md` contracts (termination sets, fail-closed gates, slice-scoped
   builds, rationalization tables). Skill families:
   - Phases: `auto-spec` → `auto-plan` → `auto-build` → `auto-simplify` → `auto-test` → `auto-review`
     → `auto-performance` → `auto-ship`
   - Primitives: `converge-loop`, `adversarial-verify`, `checkpoint-resume`, `fan-out-work`,
     `budget-guard`
   - Autonomy: `autonomous-pipeline`, `watch-and-act`, `schedule-recurring-agent`
2. **Enforcement** — deterministic guards for rules a model can't self-police under pressure:
   `<skill>/scripts/guard-*.sh` wired as SKILL-SCOPED frontmatter hooks (a thin resolver line finds the
   script across all five install layouts and `exec`s it; fail-OPEN if absent — guards must never brick
   a session) + the plugin's `hooks/hooks.json` (same scripts, self-scoped to live `.ulpi/runs/*` runs)
   + `checkpoint.mjs`'s exit-2 refusals.
3. **Execution** — runnable machinery: `checkpoint-resume/scripts/checkpoint.mjs` (locked, atomic state
   CLI), `autonomous-pipeline/references/pipeline-workflow.js` and
   `auto-review/references/review-workflow.js` (Workflow-tool templates), and the termination-set →
   native `/goal`+`/loop` compilation (`converge-loop/references/native-goal-loop.md`).
4. **Distribution** — skills.sh (universal, incl. Codex), the Claude Code plugin
   (`.claude-plugin/plugin.json` + `marketplace.json`, `skills: "./"`), `AGENTS.md`, and CI
   (`scripts/validate-skills.mjs` + `scripts/test-guards.sh` + `scripts/test-checkpoint.sh`).

Platform priority: **Claude Code is the MUST; Codex is phase 2** (structural compatibility already in
place). The local decision log lives at `docs/DECISIONS.md` (gitignored — working notes, not published).

### Skill Directory Structure

```
<skill-name>/
├── SKILL.md              # Frontmatter (name, version, description, allowed-tools, hooks?, …) + phased guide
├── references/           # Optional: patterns/contracts/workflow templates loaded on demand
└── scripts/              # Optional: EXECUTABLE helpers + guards (bash -n / node --check clean, chmod +x)
```

### SKILL.md Format

```yaml
---
name: skill-name
version: X.Y.Z
description: |
  What the skill does and precisely when to invoke it (trigger-rich — the model routes on this).
allowed-tools:
  - Agent
  - Workflow
  - Bash
  - Read
  - Write
effort: high            # optional
argument-hint: "<...>"  # optional
when_to_use: |          # optional but recommended
  Explicit "use when / do NOT use when" guidance.
---
```

The markdown body follows the house structure:
- `<EXTREMELY-IMPORTANT>` block — non-negotiable guardrails (termination, budget, honesty).
- Numbered **phases** with explicit **success criteria** between them.
- `## Guardrails` — the "never" rules.
- `## When To Load References` — which reference file to load and when.
- `## Output Contract` — exactly what the skill reports back.

## Autonomy conventions (the reason this collection exists)

Every autonomous skill here MUST honor these — they are what separate "autonomous" from "runaway":

- **Bounded, never infinite.** Every loop declares a termination set: a done-condition, a max-iteration
  cap, a token budget, and a no-progress/anti-thrash stop. When any fires, the loop STOPS and reports —
  it never spins. See `converge-loop` and `budget-guard`.
- **Honest termination — fail closed.** A gate that did not actually run is NEVER reported clean. A
  loop that exhausted its budget without converging says so and returns the open items. Never fabricate
  a green verdict to exit. See `adversarial-verify`.
- **Verify before acting.** Findings/claims that drive mutations are adversarially verified (N skeptics,
  majority-refute) before they are acted on. See `adversarial-verify`.
- **Durable + resumable.** Long-running work writes a live status file and skips already-done units on
  resume — session-independent, not cache-dependent. See `checkpoint-resume`.
- **Escalate, don't guess.** When blocked on a decision that is the user's to make, stop and surface it
  rather than looping or picking silently.
- **Measure, don't assume.** `auto-performance` accepts an optimization only when a benchmark proves it
  faster with no correctness regression.

## Conventions

- **Versioning**: semver in frontmatter. Commit messages: `<Skill Name> v<X.Y.Z> — <changelog summary>`.
- **allowed-tools**: declare the minimum. Autonomy skills typically need `Agent`, `Workflow`, `Bash`,
  `Read`; add `Write`/`Edit` only when the skill mutates files.
- **Self-contained and best-in-class**: every skill is complete and superior ON ITS OWN — it carries its
  own quality bar (its own reference material) and never depends on another skill pack for core value. We
  write our own content, better and autonomous-first; we do not copy from or reference other collections.
  A skill MAY orchestrate other installed skills/agents/tools as building blocks when present, but its
  quality never hinges on them, and our docs never point a reader at an external pack.
- **State lives under `.ulpi/`**: specs in `.ulpi/spec/`, plans in `.ulpi/plans/`, run status in
  `.ulpi/runs/<id>.json` (mirrors ship-playbook's `.ulpi/workflows/`).

## Working with Skills

When editing a skill, read the full `SKILL.md` first — the `<EXTREMELY-IMPORTANT>` block and phase
success criteria define its contract. When creating one, follow the frontmatter format and the
autonomy conventions above; compose the primitives instead of re-deriving loop/verify/checkpoint logic.
