---
name: auto-learn
version: 0.1.0
disable-model-invocation: true
user-invocable: true
description: |
  Close every autonomous run with a learning pass so the machine never repeats a mistake it already
  paid for: harvest the run's STRUCTURED artifacts (checkpoint register, blocked-task reasons, guard
  blocks, fix-loop counts, degradations), verify each candidate lesson adversarially, dedupe against
  what is already known, then WRITE each learning to the Claude Code memory that LOADS AUTOMATICALLY
  next session — a convention or plan-shape rule into CLAUDE.md, an area-specific lesson into a
  path-scoped .claude/rules file, an environment quirk into auto memory. Machine defects are surfaced to
  the user, never self-patched. Because those are native context files Claude Code already loads, the
  next run picks the lessons up with no extra step. Use as the closing phase of every run, or standalone.
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
3. WRITE TO WHERE CLAUDE CODE ACTUALLY LOADS CONTEXT — never a bespoke file nothing reads. A learning
   only changes behavior if it lands in native, auto-loaded memory: **CLAUDE.md** (loaded in full every
   session), a path-scoped **`.claude/rules/<area>.md`** (loaded when the agent touches that area), or
   **auto memory** (`~/.claude/projects/<project>/memory/`, loaded every session). Machine defects (a
   skill/guard/template gap) → surfaced to the user, never self-suppressed. NEVER invent a `.ulpi/`
   learnings file — nothing loads it, so it is a lesson written into the void.
4. DEDUPE AND CURATE — memory is a working set, not an archive: merge with an existing entry instead of
   appending a twin, prune entries a later run superseded or disproved, convert relative dates to
   absolute, and keep CLAUDE.md within its line budget. Cap: at most 5 new learnings per run.
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
deduplicated learnings and writes them into the memory Claude Code already loads every session —
CLAUDE.md, `.claude/rules`, auto memory — so the next run starts with the lessons in context
automatically, without any phase having to remember to read a file. That is what closes the loop.

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

## Phase 2: Route each learning to native, auto-loaded memory

Claude Code loads these every session (or on matching-file access) with no prompting. Put each learning
in the one that will actually reach the next run:

| Learning is about… | Route to (Claude Code auto-loads it) | How |
|---|---|---|
| A project-wide convention, invariant, or plan-shape rule the run kept violating (tasks too fat here, a validate form that lies, a boundary that bit) | **CLAUDE.md** — loaded in full every session | append to a stamped `## Learnings` section, or hand it to `auto-map` (which owns CLAUDE.md) |
| A lesson that only applies to one area (an API rule, a DB/migration gotcha, a test-suite quirk) | **`.claude/rules/<area>.md`** with `paths:` frontmatter — loads when the agent touches those files | create or append the rule; scope its `paths:` glob |
| An environment or tooling quirk the run discovered (build flake, slow suite, a service dependency, a CI oddity) | **auto memory** (`~/.claude/projects/<project>/memory/`) — MEMORY.md loaded every session | a topic file plus one MEMORY.md index line |
| A defect in the machine itself (a skill gap, a guard bypass, a template bug) | **the user** — reported, never self-patched | surface it in the Output Contract |

Dedupe on write: if an existing entry covers it, strengthen that entry (add the new evidence ref)
instead of appending a twin; prune superseded/disproved entries while you are there. Keep CLAUDE.md and
each rules file within budget — they load into every session, so bloat taxes all future work.

**Success criteria:** every survivor landed in exactly one native-loaded location; nothing written to a
file Claude Code does not load; memory deduped and within budget.

## Phase 3: Close the loop — the feed-forward is now AUTOMATIC

Because the learnings live in native, auto-loaded memory, the next run picks them up with no extra step —
with one nuance to state honestly: **CLAUDE.md and auto-memory `MEMORY.md` load in full EVERY session**, so
lessons routed there close the loop unconditionally; a **`.claude/rules/<area>.md` lesson loads only when a
future session touches files matching its `paths:` glob** (path-scoped by design — that is the point of an
area-specific rule). So route a lesson the next run must ALWAYS see to CLAUDE.md / auto-memory, and an
area-specific one to `.claude/rules`. Confirm and report that each learning actually landed in a loaded
location (`/memory` lists what is loaded; check the CLAUDE.md `## Learnings` section and any new
`.claude/rules` file). In pipeline composition this skill runs BEFORE `auto-map`, which then verifies the
CLAUDE.md/rules the learnings touched against the real repo.

**Success criteria:** every lesson is in a location Claude Code confirms it loads; none stranded in a
file nothing reads.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Obvious lesson, no need to verify." | Obvious-feeling lessons from one bad run are how false laws get written. Verify against the evidence or drop it. |
| "Keep every learning — more is better." | CLAUDE.md loads into every session. Bloat taxes every run; 5 curated beats 50 hoarded. |
| "Drop it in a `.ulpi/learnings.md` and have the skills read it." | Claude Code doesn't load that file. It's a lesson written into the void. Use CLAUDE.md, `.claude/rules`, or auto memory — what actually loads. |
| "Just append; dedup later." | Later never comes. Twins drift apart and contradict; merge on write. |
| "That failure was the skill's fault — tweak my own instructions quietly." | Machine defects go to the user. Self-patching hides systemic bugs from the person who owns the system. |
| "Record it in the transcript summary." | Transcripts die with the session. Only routed, durable layers change the next run. |
| "One flake = a rule." | One occurrence is an anecdote. Two with the same evidence shape is a pattern. Generalize only what recurs or is structurally certain. |

## Red Flags

- A learning with no evidence pointer, or one contradicting the artifact it cites.
- A learning written to any file Claude Code does not auto-load (a `.ulpi/` note, a random doc): it will
  never reach the next run.
- CLAUDE.md or a rules file growing past its budget or accumulating near-duplicate entries.
- A machine defect recorded as a repo note instead of surfaced to the user.
- The same mistake appearing in two consecutive runs' registers — the loop is NOT closing; escalate.

## Guardrails

- Never write an unverified or evidence-free learning; never learn from memory alone.
- Never write a learning to a file Claude Code does not load (CLAUDE.md / `.claude/rules` / auto memory
  only); never invent a `.ulpi/learnings.md`.
- Never exceed 5 new learnings per run; keep CLAUDE.md and rules files within budget.
- Never duplicate — merge and strengthen; prune superseded entries on every pass.
- Never store secrets; never touch human-written memory outside stamped sections.
- Never self-patch machine defects silently — they belong to the user.

## When To Load References

- `scripts/harvest-run.mjs` — mechanical candidate extraction from a checkpoint (Phase 0). CI-tested by
  `scripts/test-harvest.sh` (every signal class extracted with evidence citations; unreadable → exit 2).
- `adversarial-verify` (skill) — the TRUE/GENERAL/ACTIONABLE gate (Phase 1).
- `auto-map` (skill) — the routing target for repo-fact learnings (Phase 2).
- `checkpoint-resume` (skill) — the artifact format this skill harvests.

## Output Contract

Report:

1. run harvested (checkpoint path) + candidates found by the harvester vs. added manually
2. verification: survivors vs. rejected (with the rejection reason)
3. routing: which learning landed where (CLAUDE.md / `.claude/rules/<area>.md` / auto memory / user-report)
4. machine defects surfaced to the user (never self-patched)
5. confirmation each lesson is in a location Claude Code auto-loads (entries merged/pruned, within budget)
