---
name: fan-out-work
version: 0.1.0
description: |
  Cover a large work-list in parallel without losing correctness or honesty — scout the items inline,
  then run each through its stages concurrently (map, optionally reduce) via the Workflow tool, with
  concurrency caps, per-item isolation where items mutate files, and an explicit account of anything
  dropped. Use when the task is "do the same thing to N independent things" — audit every module, migrate
  every call site, write tests for every gap, review every changed file — and N is big enough that serial
  is wasteful. It keeps the coordinator in control of the decision to continue while the per-item work
  runs in agents; it never silently truncates (a top-N/sampling cap is logged), and it aggregates results
  faithfully (a failed item becomes a reported null, not a hidden success). Composes with converge-loop
  (per-item loops) and adversarial-verify (gate each item's result).
allowed-tools:
  - Workflow
  - Agent
  - Bash
  - Read
  - Grep
  - Glob
effort: high
argument-hint: "<the work — e.g. 'add tests to every untested module' or a path to a work-list>"
arguments:
  - work
when_to_use: |
  Use when you have (or can cheaply discover) a list of INDEPENDENT items that each need the same
  multi-step treatment, and doing them serially wastes wall-clock — broad audits, sweeping migrations,
  per-file review/test/simplify passes. Do NOT use for a handful of items (just do them inline), for work
  with cross-item dependencies that force ordering (that's a DAG — use auto-build), or when the items
  share write scope and would race (either isolate them or sequence them).
---

<EXTREMELY-IMPORTANT>
Parallelism multiplies throughput AND the ways to lie about coverage. Non-negotiable:
1. NEVER silently truncate. If you cap the work (top-N, sampling, no-retry, a concurrency limit that
   drops overflow), LOG exactly what was covered and what was skipped. A run that quietly did 20 of 200
   items and reported success is the worst failure mode here — it reads as "all done" when it isn't.
2. A failed item is a REPORTED failure, not a hidden one. An agent that dies/returns null becomes a
   tracked null in the results and appears in the report — never dropped so the summary looks clean.
3. ISOLATE writers. If items mutate files in parallel, run them with worktree isolation (or sequence the
   writes). Two agents writing the same file concurrently corrupt each other.
4. PROVE independence before fanning out. If item B needs item A's output, this is not a fan-out — it's a
   dependency graph; ordering it as parallel work produces wrong results built on missing inputs.
5. The COORDINATOR keeps the continue/stop decision and the termination accounting. Delegate the work of
   each item, never the judgment of whether the whole job is done.
</EXTREMELY-IMPORTANT>

# Fan-Out Work

## Overview

Turn "do X to every item in a list" into a controlled parallel run: discover the list, map each item
through its stages concurrently with caps and isolation, optionally reduce to a merged result, and report
faithfully — including what was dropped. The win is wall-clock (the slowest single item's chain, not the
sum), *without* the usual parallel sins: silent truncation, hidden failures, and write races.

## Phase 0: Scout the work-list inline (before any fan-out)

Discover the items in the coordinator FIRST — you usually can't know the fan-out's shape until you've
listed the work:

- enumerate the items (files, modules, call sites, findings) with a real command (`git diff --name-only`,
  `grep -rl`, a glob) — not a guess;
- record each item's identity so results can be attributed and duplicates removed;
- **prove independence**: no item consumes another's output; write scopes are disjoint (or will be
  isolated). If they're not independent, STOP — this is a DAG, not a fan-out.

**Success criteria:** a concrete, de-duplicated item list, each item verified independent (or isolatable).

## Phase 1: Define the per-item pipeline

Specify the stages each item flows through — the SAME stages for every item, run per-item independently:

- e.g. `find gap → write test → mutation-verify` (auto-test), or `review → adversarially verify → fix`
  (auto-review), or `transform → validate` (a migration);
- default to a **pipeline** (no barrier between stages): item A can be at stage 3 while item B is still at
  stage 1 — wall-clock is the slowest single chain, not the slowest stage summed. Only use a **barrier**
  (collect all of stage N before stage N+1) when a stage genuinely needs the whole set — dedup/merge
  across items, or an early-exit on total count.

**Success criteria:** the per-item stage sequence is defined; pipeline-vs-barrier chosen with a reason.

## Phase 2: Set caps, isolation, and the drop policy

Before launching, pin the safety rails:

- **Concurrency cap** — how many items run at once (the runtime caps at ~min(16, cores−2); set a tighter
  cap for heavy/worktree items to avoid rate limits and disk pressure). Excess items queue and still run
  — a cap bounds *simultaneity*, not *total*.
- **Isolation** — writers get `isolation: 'worktree'`; read-only items don't need it.
- **Retry** — decide whether a failed/rate-limited item retries (bounded backoff) or is recorded blocked.
- **Drop policy** — if you are deliberately bounding coverage (top-N by risk, sampling), decide the rule
  NOW and plan to LOG it. If you intend full coverage, there is no drop — every item runs.

**Success criteria:** concurrency, isolation, retry, and (explicit) drop policy are all decided.

## Phase 3: Run the fan-out (Workflow tool)

Author a Workflow that maps the items through the pipeline. The script owns the loop, caps, and
accounting; the agents do the per-item work. Filter dead items with `.filter(Boolean)` and keep their
identities for the report. See `references/fanout-patterns.md` for the pipeline / barrier / loop-until-dry
shapes and the map-reduce recipe.

For a modest list where a full Workflow is overkill, a single-message batch of `Agent(...)` calls
(parallel, backgrounded, isolated for writers) is a lighter equivalent — same rules apply.

**Success criteria:** every item ran (or is a tracked null); the coordinator has a result per item.

## Phase 4: Reduce and report faithfully

Aggregate the per-item results, then report the WHOLE truth:

- **covered**: items that completed, with their outcomes;
- **failed/blocked**: items that returned null / errored — named, with the reason;
- **dropped** (if a cap was intentional): the exact items not attempted and the rule that excluded them —
  never omitted so the run looks complete.

If a reduce stage merges results (dedup findings, combine a report), do it over the full covered set.

**Success criteria:** the report accounts for every item — covered, failed, or dropped — with no silent
gaps between N discovered and N reported.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I did the first 20, that's representative — call it done." | A sample is not full coverage. If you capped, say "20 of 200, by risk"; don't report success. |
| "That item errored, I'll leave it out of the summary." | A dropped failure is a hidden failure. It belongs in the report as blocked, with the reason. |
| "They probably don't conflict, just run them in parallel." | "Probably" is how two writers corrupt a file. Prove independence or isolate; don't hope. |
| "A barrier is cleaner to code." | A barrier makes fast items wait for the slowest at every stage. Use a pipeline unless a stage needs the whole set. |
| "One big rewrite across all files is simpler than N items." | It also fails atomically and hides which item broke. Per-item is debuggable and partially recoverable. |

## Red Flags

- The count of items reported is smaller than the count discovered, with no "dropped/blocked" note.
- Parallel agents writing overlapping paths without worktree isolation.
- A summary that says "all done" after a run that hit a concurrency/no-retry cap.
- Fanning out items where one clearly needs another's output (should be a DAG).
- `.filter(Boolean)` results used without noting how many were filtered.

## Guardrails

- Never silently truncate — log every intentional cap and every dropped/blocked item.
- Never hide a failed item to keep the summary clean.
- Never fan out writers without isolation, or dependent items as if independent.
- Never move the continue/stop decision into the agents — the coordinator owns termination.
- Prefer pipeline over barrier; reach for a barrier only when a stage needs the full set.

## When To Load References

- `references/fanout-patterns.md`
  The Workflow-tool shapes — pipeline (no barrier), barrier (dedup/early-exit), map-reduce, per-item
  loop-until-dry, and the single-message Agent-batch equivalent — plus the concurrency-cap and
  faithful-aggregation recipes. Load when authoring the fan-out.

## Output Contract

Report:

1. items discovered (count + how enumerated) and independence basis
2. per-item pipeline + pipeline/barrier choice; concurrency, isolation, retry, drop policy
3. covered (outcomes), failed/blocked (named + reason), dropped (named + rule) — accounting for every item
4. any reduced/merged result
