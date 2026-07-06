---
name: checkpoint-resume
version: 0.1.0
description: |
  Make any long-running autonomous task durable and resumable by writing a live JSON status file and, on
  resume, SKIPPING every unit already done — session-independent, not dependent on an agent/runtime cache.
  Write `.ulpi/runs/<id>.json` with overall status + per-unit state as work lands; a stopped, crashed, or
  handed-off run reads it back and rebuilds only what's left. Use this to wrap multi-unit work (a DAG
  build, a file-by-file migration, a long fix/clean loop, a fan-out over many items) so a run is
  stoppable and restartable without losing or redoing work. Status writes are OBSERVABILITY and are
  NON-FATAL — a failed write is logged and ignored, never blocking the work.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
argument-hint: "<run label, or a path/id to resume>"
arguments:
  - target
when_to_use: |
  Use for any task that (a) has more than a handful of independently-completable units and (b) could be
  interrupted or is worth resuming — DAG builds, migrations, broad audits, long converge-loops, fan-outs.
  Do NOT use for a single-shot task, or for work whose units aren't independently identifiable (there's
  nothing to skip on resume). It is a companion to converge-loop and fan-out-work, not a standalone action.
---

<EXTREMELY-IMPORTANT>
The status file is the durable record — but it is OBSERVABILITY, never a gate. Non-negotiable:
1. RESUME MEANS SKIP-DONE. On resume you MUST read the existing status file and rebuild only units NOT
   marked done. NEVER overwrite an existing run's status file with a fresh all-`pending` document — that
   erases the checkpoint and redoes everything.
2. Durability is on DISK, not in a cache. Resume must work in a brand-new session with no runtime memory
   of the prior run — drive it off the file, not off `resumeFromRunId`/agent caches (those are an
   optimization on top, not the source of truth).
3. Status writes are NON-FATAL. A failed/racing write is logged and ignored — it MUST NOT block or fail
   the underlying work. Never gate delivery on a status write; never report a run failed solely because
   its status file is stale — reconstruct state from the actual artifacts instead.
4. Mark a unit done ONLY when it is actually complete and verified (its own check passed / it integrated)
   — never optimistically. A wrongly-`done` unit is silently skipped forever on resume.
5. A unit is eligible only when its dependencies are actually done. Never skip a unit as "done" whose
   prerequisite never landed — that builds on a missing base.
</EXTREMELY-IMPORTANT>

# Checkpoint Resume

## Inputs

- `$target`: For a NEW run, a short label (used to build the run id). For a RESUME, the run id or the
  path to an existing `.ulpi/runs/<id>.json`.

## Goal

Turn a long, multi-unit task into one that can be stopped and restarted at will — from any session,
after any interruption — without losing finished work or redoing it. The status file is simultaneously
the live progress view (status / stop / resume) and the durable checkpoint.

## Step 0: New run or resume? (decide FIRST)

- **Resume** if `$target` names an existing run id/file, or the user says "resume / continue". Do NOT
  re-initialize. Read the file, honor its per-unit state, and proceed to Step 3.
- **New run** otherwise. Create a fresh status file (Step 1) and proceed.

Getting this wrong is the whole failure mode: a "resume" that writes a fresh `pending` document throws
away the checkpoint. When in doubt, check for the file first.

**Success criteria**: mode determined; on resume, the existing file is loaded, not clobbered.

## Step 1: Initialize the status file (new run only)

Pick a stable `id`: `<label>-<UTC-timestamp>` (get the timestamp from `date -u +%Y%m%dT%H%M%SZ` — never
invent one). Write `.ulpi/runs/<id>.json`:

```json
{
  "schemaVersion": 1,
  "id": "<id>",
  "task": "<one-line description>",
  "status": "running",
  "createdAt": "<UTC now>",
  "updatedAt": "<UTC now>",
  "units": {
    "<unit-id>": { "status": "pending", "dependsOn": [], "note": "" }
  },
  "openItems": [],
  "result": null
}
```

Enumerate the units up front when they're known (DAG tasks, files to migrate); for a discovery-driven
run, start with `units: {}` and add them as they're found. Each unit's `status` moves
`pending → in_progress → done` (or `blocked` / `dep_blocked`).

If the orchestrator that runs the work has no filesystem access (e.g. a sandboxed Workflow), the
CALLER creates and updates this file — pass the absolute `statusFile` path in.

**Success criteria**: the file exists before any work starts, so a watcher sees the run immediately.

## Step 2: Update as work lands (running)

After each unit reaches a terminal state, patch the file — do NOT rewrite it wholesale (concurrent
writers race). Prefer a read-modify-write with `jq`:

```bash
jq --arg u "<unit-id>" --arg s "done" --arg t "$(date -u +%Y%m%dT%H%M%SZ)" \
   '.units[$u].status=$s | .updatedAt=$t' .ulpi/runs/<id>.json > .ulpi/runs/<id>.json.tmp \
   && mv .ulpi/runs/<id>.json.tmp .ulpi/runs/<id>.json
```

Wrap writes so a failure is swallowed (`|| true`) — a status write must never abort the work. Update
`openItems` with anything the run should carry forward (blocked units, findings), and `status` at the
top level as phases progress.

**Success criteria**: at any instant, `cat`-ing the file shows the true current state; a crash here
loses at most the in-flight unit.

## Step 3: Resume — skip done, rebuild the rest

On resume, read the file and compute the work set:

1. Load `units`. A unit is **done** → skip it entirely.
2. A unit is **pending / in_progress / blocked** and all its `dependsOn` are `done` → it's eligible;
   rebuild it. (An `in_progress` unit was interrupted mid-flight — redo it; it never reached `done`.)
3. A unit whose dependency is NOT done → `dep_blocked`, pointing at the missing root; do not build it on
   a partial base.

Then run only the eligible set through the same machinery as the original run, writing back to the SAME
file (same `id`/path). The durable skip-done makes this independent of any runtime cache — a template
edit or a fresh session doesn't force a full rebuild.

**Success criteria**: finished units are provably not redone; only the remaining/eligible set runs.

## Step 4: Finalize

When the work set is exhausted, write the terminal state: `status` = `done` (all units done) /
`needs_attention` (some blocked/open) / `aborted`; populate `result` and the final `openItems`. This
file is the run's durable record — tell the user where it lives.

If a run died without a final write, reconstruct the terminal state from the artifacts (git log, the
units' own checks) rather than trusting a stale `running` — see `references/status-schema.md`.

**Success criteria**: the file reflects the real end state and enumerates anything still open.

## Guardrails

- Never overwrite an existing run's file with a fresh `pending` document on resume.
- Never mark a unit `done` before it is complete AND verified.
- Never skip a unit whose dependency didn't actually land.
- Never let a status-write failure block, abort, or fail the underlying work.
- Never fabricate a timestamp — read the clock (`date -u`).
- Never treat a stale/`running` file as ground truth after a crash — reconstruct from artifacts.
- Keep writes atomic (`tmp` + `mv`) and incremental (`jq` patch, not full rewrite) to survive races.

## When To Load References

- `references/status-schema.md`
  The full status-file schema (per-unit states, `dependsOn`, `openItems`, phase blocks), the three verbs
  (status / stop / resume), atomic-write recipes, and how to rebuild the file from artifacts after a
  crash. Load when defining a run's schema or writing the resume logic.

## Output Contract

Report:

1. run id + status-file path
2. new run vs resume; on resume, how many units were skipped-done vs rebuilt
3. final status (done / needs_attention / aborted) and where the durable record lives
4. any open/blocked units carried in `openItems`
