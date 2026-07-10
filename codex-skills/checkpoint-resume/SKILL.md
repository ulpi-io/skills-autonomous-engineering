---
name: checkpoint-resume
description: |
  Codex adapter for durable, resumable multi-unit runs — a live .ulpi/runs/<id>.json checkpoint that a
  resume reads to SKIP already-done units, session-independent. Delegates to the canonical methodology.
---

# checkpoint-resume — Codex adapter (thin)

This is a **thin Codex adapter**. The full, authoritative methodology — the durable checkpoint contract,
the five resume cases, the v1→v2 migration, and the `<EXTREMELY-IMPORTANT>` guardrails — lives in the
canonical root skill and is the single source of truth you MUST apply:

- **Canonical methodology:** `checkpoint-resume/SKILL.md` (the `delegate` target). Read it and follow it
  verbatim; this adapter adds nothing to the contract, it only maps it onto the Codex runtime.

## Apply the shared Codex runtime map first

Before acting, apply the binding capability contract in **`../.shared/codex-runtime.md`**. It states, per
capability, the exact implemented path and the honest degraded outcome. For this skill:

- **Durability & resume are Codex-native here.** The checkpoint store and its reader are real,
  Codex-runnable Node CLIs — use them directly (paths relative to repo root):
  - `node checkpoint-resume/scripts/checkpoint.mjs init|unit|phase|get|resume|item|finalize|gc …` —
    the atomic, locked store that refuses to clobber a live checkpoint or demote a `done` unit.
  - `node checkpoint-resume/scripts/run-status.mjs [id|--list|--json|--resume]` — the READ-ONLY reader.
  - `node autonomous-pipeline/scripts/pipeline.mjs resume --run <id>` — the deterministic coordinator
    resume that re-reads THIS durable checkpoint and skips done units (runnable when the persisted
    `launch` is the coordinator recipe).
- **Do NOT present any Claude-only mechanic as a Codex operation.** `Workflow(...resumeFromRunId)` is a
  Claude-only agent-result *cache*, never the executable Codex resume path and never a shell command; a
  `launch` descriptor that names a Claude `Workflow()` script is **MIGRATION-ONLY / non-runnable**
  (`run-status.mjs --resume` classifies it and never fabricates a command). See `codex-runtime.md` §11/§4.

## What to do

1. Apply `../.shared/codex-runtime.md` (capabilities → implemented paths / honest degraded outcomes).
2. Follow the canonical `checkpoint-resume/SKILL.md` end to end — decide new-run vs resume FIRST, use the
   bundled `checkpoint.mjs` (never hand-roll the file ops), skip only `done` units on resume, and finalize
   honestly. Status writes are non-fatal observability, never a gate.
