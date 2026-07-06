---
name: auto-learn
version: 0.1.0
description: |
  Close every autonomous run with a learning pass so the machine never repeats a mistake it already
  paid for: harvest the run's STRUCTURED artifacts (checkpoint register, blocked-task reasons, guard
  blocks, fix-loop counts, degradations), verify each candidate lesson adversarially, dedupe against
  what is already known, then route each learning to the memory layer that will actually change future
  behavior — repo facts into the stamped context map, environment quirks into auto memory, plan-shape
  lessons into .ulpi/learnings.md which auto-spec/auto-plan/auto-build READ BEFORE their next run.
  Use as the closing phase of every pipeline/loop run, or standalone after any bumpy session.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
user-invocable: true
effort: high
argument-hint: "[checkpoint path or run id to harvest] (default: the most recent .ulpi/runs/*.json)"
arguments:
  - run
when_to_use: |
  Use at the END of an autonomous run (the pipeline composes it automatically before auto-map), or
  standalone after a session that hit blocks, thrash, or surprises worth keeping. Do NOT use mid-run
  (learn from complete evidence, not half-finished state), and do NOT use it to record what the repo
  already documents — it captures only what would otherwise be re-discovered the hard way.
---

<EXTREMELY-IMPORTANT>
A wrong or bloated learning poisons every future run — this skill's failure mode is worse than
learning nothing. Non-negotiable:
1. LEARN FROM ARTIFACTS, NOT VIBES. Candidates come from the run's structured evidence — the
   checkpoint's register/openItems, blocked units with their notes, guard-block reasons, fix-loop
   iteration counts, delegation degradations, verifier rejection ledgers — each candidate carries its
   evidence reference. No evidence, no learning.
2. VERIFY BEFORE WRITING. Every candidate passes `adversarial-verify`: is it TRUE (matches the
   evidence), GENERAL (a pattern, not a one-off flake), and ACTIONABLE (changes a future decision)?
   One flaky run does not make a law. Rejected candidates are dropped, not hoarded.
3. ROUTE TO THE LAYER THAT CHANGES BEHAVIOR — never dump everything in one file:
   repo facts → the stamped context map (via a scoped `auto-map` refresh); environment/process quirks
   → auto memory; plan-shape and process lessons → `.ulpi/learnings.md` (the feed-forward file);
   machine defects (a skill/guard/template gap) → surfaced to the user, never self-suppressed.
4. DEDUPE AND CURATE — the learnings file is a ≤100-line working set, not an archive: merge with an
   existing entry instead of appending a twin, prune entries a later run superseded or disproved,
   convert relative dates to absolute. Cap: at most 5 new learnings per run — the highest-value ones.
5. NEVER learn secrets/tokens/URLs-with-credentials, and never rewrite human-written memory — the
   same stamps-and-preservation rules as auto-map.
</EXTREMELY-IMPORTANT>

# Auto Learn

## Inputs

- `$run`: a checkpoint path or run id to harvest; defaults to the most recent `.ulpi/runs/*.json`.

## Overview

The difference between an autonomous machine and a self-improving one is whether run N+1 knows what
run N paid to find out. Every blocked task, guard block, thrash loop, and rejected finding is evidence
about how THIS repo and THIS process actually behave. This skill turns that evidence into verified,
routed, deduplicated learnings — and the front of the pipeline (`auto-spec` recon, `auto-plan` Phase 0,
`auto-build` preflight) reads them back, so the loop actually closes.

## Phase 0: Harvest the run's evidence — it is CODE

```bash
node <skill-dir>/scripts/harvest-run.mjs <checkpoint.json> --json
```

The harvester extracts candidates mechanically from the checkpoint: blocked/dep_blocked units with
their notes, gate failures from the register, delegation degradations, units that needed many fix
iterations, and openItems by phase. Supplement with what the checkpoint can't hold: guard-block
messages you observed, verifier rejection patterns (repeated false-positive shapes), and anything the
user corrected mid-run. Every candidate keeps its evidence pointer.

**Success criteria:** a candidate list where each entry cites its evidence; nothing from memory alone.

## Phase 1: Verify and generalize (the anti-poison gate)

For each candidate, `adversarial-verify` with three questions — TRUE (does the evidence actually
support it — reread the artifact, don't trust the summary)? GENERAL (would it recur — or was it a
one-off flake/typo)? ACTIONABLE (what future decision changes)? Then rewrite survivors into the
canonical learning shape:

```
- <the rule> — WHY: <one line, from evidence> — APPLY: <what to do differently> (evidence: <ref>, <date>)
```

**Success criteria:** ≤5 survivors, each true, general, actionable, and evidence-linked.

## Phase 2: Route each learning to the layer that changes behavior

| Learning is about… | Route to | Mechanism |
|---|---|---|
| THIS repo's code reality (an invariant tasks kept violating, a module boundary that bit) | the context map | scoped `auto-map` refresh — stamped sections only |
| Environment/process quirks (build flake, service dependency, slow suite, CI oddity) | auto memory | topic file + one MEMORY.md index line |
| Plan shape & process (tasks too fat here, a dependency class that keeps getting missed, a validate form that lies) | `.ulpi/learnings.md` | the FEED-FORWARD file — read at the front of the next run |
| The machine itself (a skill gap, a guard bypass, a template defect) | the user | reported in the Output Contract — never silently self-patched, never suppressed |

Dedupe on write: if an existing entry covers it, strengthen that entry (add the new evidence ref)
instead of appending a twin. Prune superseded/disproved entries while there. Keep `.ulpi/learnings.md`
under 100 lines — it loads into planning context; bloat there taxes every future run.

**Success criteria:** every survivor landed in exactly one layer; the learnings file is deduped,
curated, and within budget.

## Phase 3: Close the loop — confirm feed-forward wiring

The learnings only matter if the next run reads them. Confirm (and report) that the consumers exist:
`auto-spec` reads `.ulpi/learnings.md` during recon; `auto-plan` reads it in Phase 0 and encodes
plan-shape lessons into the DAG; `auto-build`'s preflight surfaces relevant entries into engineer
briefs. In pipeline composition this skill runs BEFORE `auto-map` (learnings may update rules the map
refresh then verifies).

**Success criteria:** the run's lessons are on disk where the next run's front door reads them.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Obvious lesson, no need to verify." | Obvious-feeling lessons from one bad run are how false laws get written. Verify against the evidence or drop it. |
| "Keep every learning — more is better." | The learnings file loads into planning context. Bloat taxes every run; 5 curated beats 50 hoarded. |
| "Just append; dedup later." | Later never comes. Twins drift apart and contradict; merge on write. |
| "That failure was the skill's fault — tweak my own instructions quietly." | Machine defects go to the user. Self-patching hides systemic bugs from the person who owns the system. |
| "Record it in the transcript summary." | Transcripts die with the session. Only routed, durable layers change the next run. |
| "One flake = a rule." | One occurrence is an anecdote. Two with the same evidence shape is a pattern. Generalize only what recurs or is structurally certain. |

## Red Flags

- A learning with no evidence pointer, or one contradicting the artifact it cites.
- `.ulpi/learnings.md` growing past ~100 lines or accumulating near-duplicate entries.
- Repo facts written to the learnings file instead of the context map (wrong layer = never seen again).
- A machine defect recorded as a repo note instead of surfaced to the user.
- The same mistake appearing in two consecutive runs' registers — the loop is NOT closing; escalate.

## Guardrails

- Never write an unverified or evidence-free learning; never learn from memory alone.
- Never exceed 5 new learnings per run or 100 lines in the feed-forward file.
- Never duplicate — merge and strengthen; prune superseded entries on every pass.
- Never store secrets; never touch human-written memory outside stamped sections.
- Never self-patch machine defects silently — they belong to the user.

## When To Load References

- `scripts/harvest-run.mjs` — mechanical candidate extraction from a checkpoint (Phase 0). CI-tested.
- `adversarial-verify` (skill) — the TRUE/GENERAL/ACTIONABLE gate (Phase 1).
- `auto-map` (skill) — the routing target for repo-fact learnings (Phase 2).
- `checkpoint-resume` (skill) — the artifact format this skill harvests.

## Output Contract

Report:

1. run harvested (checkpoint path) + candidates found by the harvester vs. added manually
2. verification: survivors vs. rejected (with the rejection reason)
3. routing: which learning landed in which layer (map / memory / learnings.md / user-report)
4. machine defects surfaced to the user (never self-patched)
5. feed-forward state: learnings-file line count, entries merged/pruned, consumers confirmed
