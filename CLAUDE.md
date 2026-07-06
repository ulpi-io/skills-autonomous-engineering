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

## Architecture

A flat monorepo of independent skills — one self-contained directory per skill at the repo root. No
shared build system, no package.json, no test framework. Skills are documentation + orchestration
contracts, not executable libraries (a few carry small `helpers/` scripts).

The collection has three layers:

1. **Phase skills** (`auto-*`) — one per delivery step. Each is autonomous: self-correcting, budget-
   guarded, checkpoint-resumable, and honest about termination. Each works standalone AND chains to the
   next.
   - `auto-spec` → `auto-plan` → `auto-build` → `auto-simplify` → `auto-test` → `auto-review` →
     `auto-performance` → `auto-ship`
2. **Primitives** — the shared machinery every phase composes: `converge-loop`, `adversarial-verify`,
   `checkpoint-resume`, `fan-out-work`, `budget-guard`.
3. **Autonomy layer** — `autonomous-pipeline` (chains all 8 phases unattended with checkpoints + CI
   watching) and the scheduling/watching skills `watch-and-act`, `schedule-recurring-agent`.

### Skill Directory Structure

```
<skill-name>/
├── SKILL.md              # Frontmatter (name, version, description, allowed-tools, …) + phased guide
├── references/           # Optional: patterns/contracts loaded on demand
└── helpers/              # Optional: utility scripts (Node/Python)
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
