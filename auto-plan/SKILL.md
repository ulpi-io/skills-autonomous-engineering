---
name: auto-plan
version: 0.1.0
description: |
  Turn a spec into a self-reviewed DAG of atomic build tasks: each task gets acceptance criteria, a disjoint write scope (≤3 files), and a slice-scoped validate; dependencies are wired and layered topologically so nothing builds on a missing base. Adversarial critics then attack the graph (cycles, phantom paths, coverage vs spec, task independence) until it is clean. Writes .ulpi/plans/<name>.json. Use when a spec needs an implementable, ordered breakdown before building.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
  - Workflow
effort: high
argument-hint: "<spec path, or the feature to plan (will look for .ulpi/spec/*)>"
arguments:
  - spec
when_to_use: |
  Use when you have a spec (from auto-spec or supplied) and need an implementable, ordered task breakdown
  before building. Do NOT use to define WHAT to build (that's auto-spec) or to write code (auto-build);
  and do NOT plan from a vague, untestable spec — send it back to auto-spec first, since a plan can only
  be as grounded as the spec it decomposes.
---

<EXTREMELY-IMPORTANT>
A plan's job is to make the build safe and parallelizable; a bad graph makes the build fail on a broken
base. Non-negotiable:
1. GROUND EVERY TASK IN THE REAL REPO. File paths, modules, and validate commands must reference things
   that exist (or that an earlier task creates). No phantom paths — the build will try to touch them.
2. TASKS ARE ATOMIC AND INDEPENDENTLY VERIFIABLE. Each task has ONE coherent change, a DISJOINT write
   scope, and a validate command that can go green once that slice + its dependencies integrate. If two
   pieces cannot each validate on their own, they are ONE task — not two.
3. THE GRAPH IS ACYCLIC AND TOPOLOGICALLY LAYERED. Every task lists its `dependsOn`; `layers` must be a
   topological order (each task strictly after everything it depends on). A cycle or a mis-order is a
   PLAN defect to fix, never something the build should paper over with a retry.
4. DEPENDENCY MEANS "NEEDS ITS OUTPUT". If task B needs A's migration/route/exported symbol/registry row,
   B `dependsOn` A. Getting this wrong makes the build construct on a missing base.
5. FAIL CLOSED. The self-review loop exits only when the graph is clean OR it stalls — a stalled review
   reports the remaining defects; it never signs off a graph it couldn't validate.
</EXTREMELY-IMPORTANT>

# Auto Plan

## Overview

Decompose a spec into the smallest set of build tasks that can each be implemented, tested, and committed
on their own, wired into a dependency DAG and layered so the build walks it safely and parallelizes where
the graph allows. The plan is self-reviewed to catch the defects (cycles, mis-ordering, fat tasks,
phantom paths) that would otherwise surface as build failures.

## Phase 0: Require and read the spec; ground in the repo

- Resolve the spec (`$spec` path, or the newest `.ulpi/spec/*`). If none, or if it's vague/untestable,
  STOP and route back to `auto-spec` — a plan inherits the spec's groundedness.
- Read the repo to ground the plan: existing structure, modules, build/test commands, the workspace
  validate, and the load-bearing invariants.
- **Honor the prior-run lessons already in your loaded context** — `auto-learn` writes plan-shape
  lessons into CLAUDE.md and `.claude/rules` (which Claude Code loads automatically), so a task pattern
  that blocked last run is a BINDING input here: decompose it differently, don't re-attempt it verbatim.
- Open a `checkpoint-resume` run.

**Success criteria:** a testable spec is loaded; the repo's structure + validate commands are known.

## Phase 1: Decompose into atomic tasks

Break the spec's acceptance criteria into tasks. Each task carries:

- `id` + a one-line title;
- **acceptance criteria** — from the spec, the subset this task satisfies (testable);
- **write scope** — the files/dirs it may modify (disjoint from sibling tasks in the same layer);
- **validate** — the slice-scoped command that proves it (greenable once this slice + deps integrate;
  never a whole-suite e2e that only passes at end-state);
- **agent/stack hint** — the kind of work (so the build can route a specialist);
- notes / patterns to follow.

Keep tasks thin: a task should be a single vertical slice touching **at most 3 files** — split anything
bigger; MERGE two that can't validate independently. Four planning failure modes to design out per task:

- **Capability providers** — a task claiming a side effect (persistence, network I/O, registration,
  queueing) must STATE where that capability comes from (an existing module, or the task that provides
  it as a dependency). A capability from nowhere is a phantom.
- **Export/registration ownership** — every NEW file needs a named owner for its export/barrel/registry/
  router wiring: this task or a specific dependent. Unowned wiring is how "done" tasks ship dead code.
- **Semantic-hardening splits** — if a task could be "completed" with placeholders or dead wiring, split
  the semantic hardening into an explicit follow-up task; never let structure-only pass as behavior.
- **No vague contract language** — "graceful degradation", "eventually consistent", "internal update"
  are banned unless the task defines owner, concrete behavior, and recovery path.

And make each `validate` genuinely slice-scoped in COMMAND FORM, not just intent: scope it to the task's
own test files (e.g. `pnpm --filter <pkg> exec vitest run <file>` — NOT `pnpm --filter <pkg> test --
<file>`, where the `--` makes vitest ignore the positional and run the whole package, leaking unrelated
failures into this task's gate). Every test file the command runs must be in this task's writeScope or
guaranteed green by an integrated dependency.

**Success criteria:** a set of atomic tasks, each with criteria, disjoint write scope, and a slice-scoped
validate.

## Phase 2: Wire the DAG and layer it

- For each task, set `dependsOn` = the tasks whose OUTPUT it needs (a migration it reads, a route it
  extends, a symbol it imports, a test another task grows).
- Compute `layers`: a topological order where every task appears strictly after all it depends on. Tasks
  within a layer must be independent (disjoint write scope) so the build can run them in parallel.
- Verify the graph is acyclic.

Write ONE canonical artifact: `.ulpi/plans/<name>.json`. There is deliberately NO stored markdown
twin — a second artifact is a drift class (the copies diverge and the validator only gates one). The
human view is DERIVED on demand: `node <skill-dir>/scripts/validate-plan.mjs <plan.json> --render`
prints the layered, checklisted markdown — use its OUTPUT in-conversation when presenting the plan
(e.g. the approval gate); it can never disagree with what the build will execute. NEVER write the
rendering to a file unless the user explicitly asks for one — an unrequested .md on disk is exactly
the drift-prone twin this design deletes.

**Success criteria:** a complete `{tasks[], layers[][]}` graph — acyclic, topologically ordered,
intra-layer independent.

## Phase 2.5: Run the structural gate — it is CODE

```bash
node <skill-dir>/scripts/validate-plan.mjs .ulpi/plans/<name>.json
```

The DAG's safety properties are deterministic, so they are enforced by script, not prose: acyclicity,
topological layer order (nothing builds on a missing base), intra-layer write-scope disjointness
(prefix-aware), the ≤3-file atomicity cap, ≥2 acceptance criteria per task, and slice-validate command
form (it catches the vitest `test -- <file>` footgun and whole-suite e2e validates). Exit 1 = fix the
graph and re-run until 0. The critics below argue SEMANTICS; this script owns STRUCTURE.

## Phase 3: Adversarial self-review (converge until clean)

Run `converge-loop` with `adversarial-verify` critics attacking the plan each round:

- **acyclicity + topological order** — any task ordered before a dependency? any cycle?
- **phantom paths** — any write scope / validate referencing something that doesn't (and won't) exist?
- **task independence** — do two same-layer tasks share write scope (a race)? does a task secretly need
  another's output without a `dependsOn`?
- **atomicity** — is a task actually two changes? Can each task's validate really go green at its slice?
  If two can't validate independently, MERGE them.
- **coverage** — does the union of task acceptance criteria cover the whole spec? Anything dropped?

Fix findings in the JSON (the only artifact); re-review; exit clean or report the remaining defects.

**Success criteria:** the graph passes every check, or the loop reports the specific unresolved defects.

## Phase 4: Finalize

Close the checkpoint; report the plan location, task count, layer count, and the parallelism the graph
allows (widest layer). This plan is the input to `auto-build`.

**Success criteria:** a clean, self-reviewed plan is written and ready to build.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "This task is a bit big but splitting is annoying." | A fat task can't be verified or rolled back cleanly. Split it, or the build inherits the mess. |
| "These two touch the same file but should be fine in parallel." | Same write scope in one layer is a race. Separate layers or merge them — don't hope. |
| "I'll let the build figure out the order at runtime." | Order is a plan property. A runtime retry building on a missing base is not ordering. |
| "The validate can be the full e2e suite." | A whole-suite validate only greens at end-state, so every slice looks broken. Make validate slice-scoped. |
| "The self-review found nothing, one pass is enough." | Cycles and phantom paths hide. Loop until a review pass is genuinely clean. |
| "Two tasks that can't validate alone is fine, they're logically separate." | If neither is independently greenable, they are one unit of work. Merge them. |

## Red Flags

- A task's write scope or validate points at a path nothing creates.
- Two tasks in the same layer writing the same file.
- A task ordered before something it depends on (or a cycle).
- A validate command that's the full test suite rather than a slice.
- Spec acceptance criteria with no task covering them.
- The self-review loop ran once.

## Guardrails

- Never emit phantom paths or ungrounded validate commands.
- Never create a task touching more than 3 files, claiming an unsourced capability, leaving a new file's
  export/registration unowned, or hiding placeholder-completable work without a hardening follow-up.
- Never put dependent or write-scope-overlapping tasks in the same layer.
- Never order a task before its dependencies; never ship a cyclic graph.
- Never leave a spec criterion uncovered by some task.
- Never sign off a plan the self-review couldn't make clean — report the defects.

## When To Load References

- `scripts/validate-plan.mjs` — the deterministic structural gate (Phase 2.5). CI-tested (13 contract
  cases). auto-build's preflight runs it too — a plan that fails it never builds.
- `adversarial-verify` (skill) — the plan critics in Phase 3.
- `converge-loop` (skill) — the until-clean review loop.
- `checkpoint-resume` (skill) — durable plan-run state.

## Output Contract

Report:

1. plan path (`.ulpi/plans/<name>.json` — single canonical artifact), task count, layer count
2. the DAG shape — dependency edges and the widest parallel layer
3. spec-coverage confirmation (every criterion mapped to a task)
4. self-review outcome (rounds to clean, or the remaining defects)
