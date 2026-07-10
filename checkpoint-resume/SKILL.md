---
name: checkpoint-resume
version: 0.1.2
description: |
  Make long autonomous work durable and resumable: a live .ulpi/runs/<id>.json status file (per-unit + per-phase state, atomic locked writes via the bundled scripts/checkpoint.mjs CLI) that a resume reads to SKIP everything already done — session-independent. Status writes are non-fatal observability. Use for any multi-unit run worth resuming after a stop or crash.
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
2. Durability is on DISK — the status file is the SOLE authority. Resume must work in a brand-new session
   with no runtime memory of the prior run. The portable, session-independent resume is the Codex-native
   coordinator path: `node autonomous-pipeline/scripts/pipeline.mjs resume --run <id>` (surfaced by
   `run-status.mjs --resume`), which reads THIS durable checkpoint and skips done units. Claude Code's
   `Workflow(...resumeFromRunId)` is an agent-result CACHE optimization layered on top — never the source
   of truth, and NOT a shell command; never present it as the executable Codex resume path.
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

## Step 0.5: Use the bundled CLI — don't hand-roll the file operations

This skill ships `scripts/checkpoint.mjs` (zero-dependency Node). It implements the whole contract —
atomic writes, refusal to clobber a live checkpoint, refusal to demote a `done` unit, fail-closed
finalize, and the resume-set computation — so USE IT instead of hand-rolling jq:

```bash
node <skill-dir>/scripts/checkpoint.mjs init  <file> --task "<desc>" [--units "a,b,c"] [--id <id>] [--launch '<json>']
node <skill-dir>/scripts/checkpoint.mjs unit  <file> <unit> <pending|in_progress|done|blocked|dep_blocked> [--note "…"] [--deps "x,y"]
node <skill-dir>/scripts/checkpoint.mjs phase <file> <phase> <pending|running|done|blocked|skipped>
node <skill-dir>/scripts/checkpoint.mjs get   <file> --summary
node <skill-dir>/scripts/checkpoint.mjs resume <file>     # → { skip, eligible, dep_blocked }
node <skill-dir>/scripts/checkpoint.mjs item  <file> --json '<object-or-array>'   # append durable openItems
node <skill-dir>/scripts/checkpoint.mjs finalize <file> <done|needs_attention|aborted> [--result "…"]
node <skill-dir>/scripts/checkpoint.mjs gc    <runs-dir> [--keep-days 7]  # archive old TERMINAL runs
```

Append `|| true` at call sites — status writes are non-fatal. The CLI exits 2 (refuses) on the
contract-violating operations: re-`init` over a live checkpoint, demoting a `done` unit, and
`finalize done` while units are open. Those refusals are the guardrails, enforced in code.

**Everything is timestamped** (ISO-8601 UTC): the doc (`createdAt`/`updatedAt`/`finishedAt`), each unit
(`createdAt`/`updatedAt` + `startedAt`/`finishedAt`), each phase (`startedAt`/`updatedAt`/`finishedAt`),
and each register item (`at`) — so a reader can show real durations and "updated 3m ago", not guesses.

**The typed launch descriptor.** Pass `init --launch '<json>'` to persist the exact relaunch recipe in
the file, so the run can be resumed from the status file alone (session-independent). It is a typed
object `{ scriptPath, args? }` — `init` validates it before touching disk (`scriptPath` must be a
non-empty string; `args`, when present, a JSON object) and refuses an array/string/missing-scriptPath
descriptor. To make a run RUNNABLE under the Codex coordinator, persist the coordinator recipe — a
`scriptPath` whose basename is `pipeline.mjs` and `args:{ command:"resume", run:"<id>" }`:

```bash
node <skill-dir>/scripts/checkpoint.mjs init <file> --task "…" --units "a,b,c" --id my-run \
  --launch '{"scriptPath":"autonomous-pipeline/scripts/pipeline.mjs","args":{"command":"resume","run":"my-run"}}'
```

The pipeline coordinator's own `approve` stamps exactly this descriptor for you, so its runs are runnable
out of the box. Any other descriptor (a Claude `Workflow()` script such as `pipeline-workflow.js`, or an
absent/malformed one) is treated as MIGRATION-ONLY / non-runnable — see Step 0.6.

## Step 0.6: Query a run the easy way — `run-status.mjs` (READ-ONLY)

To SEE where a run is (yours or one a pipeline left behind), use the bundled legible reader — it never
writes, so it can't disturb a run in flight:

```bash
node <skill-dir>/scripts/run-status.mjs                 # newest run for this project, rendered
node <skill-dir>/scripts/run-status.mjs <id>            # a specific run (id prefix is enough)
node <skill-dir>/scripts/run-status.mjs --list          # every run, one line each, newest first
node <skill-dir>/scripts/run-status.mjs --json [id]     # the raw durable doc
node <skill-dir>/scripts/run-status.mjs --resume [id]   # print the Codex resume command for this run
node <skill-dir>/scripts/run-status.mjs --resume --json  # emit ONLY the typed resume descriptor (argv, no shell)
```

It auto-discovers `.ulpi/runs/` by walking up from the cwd, renders phases + a per-task progress bar +
the open findings register + a resume affordance, and `--resume` classifies the persisted `launch`
descriptor into exactly one of three resume recipes (it never fabricates a command):

- **Runnable (`codex-cli`)** — the persisted launch is the coordinator recipe (basename `pipeline.mjs`,
  `args.command==="resume"`). `--resume` prints the shell-safe Codex command
  `node pipeline.mjs resume --run <id>` (the id is a discrete, quoted argv token — never string-
  interpolated into a shell); `--resume --json` adds the typed `{ runnable:true, kind:"codex-cli",
  argv:[…], shell, resumeSet }` descriptor.
- **Legacy Workflow (`legacy-workflow`)** — the launch is a Claude `Workflow()` script (e.g.
  `pipeline-workflow.js`). It is labeled **MIGRATION-ONLY / non-runnable** and is NEVER printed as a
  runnable shell command; the reader echoes the persisted `{scriptPath,args}` (with `statusFile`
  re-pinned to this run) for migration reference only. `--resume --json` →
  `{ runnable:false, migrationOnly:true, kind:"legacy-workflow" }`.
- **No / malformed launch (`no-launch`)** — nothing runnable was persisted (pre-coordinator, hand-rolled,
  or a malformed descriptor): non-runnable, with the computed skip/eligible `resumeSet` so a human can
  relaunch via `pipeline.mjs approve` → `pipeline.mjs start --run <id>`.

## Step 1: Initialize the status file (new run only)

Prefer `checkpoint.mjs init`. If you must write it by hand, pick a stable `id`:
`<label>-<UTC-timestamp>` (get the timestamp from `date -u +%Y%m%dT%H%M%SZ` — never invent one).
Write `.ulpi/runs/<id>.json`:

```json
{
  "schemaVersion": 1,
  "id": "<id>",
  "task": "<one-line description>",
  "status": "running",
  "createdAt": "<UTC now>",
  "updatedAt": "<UTC now>",
  "units": {
    "<unit-id>": { "status": "pending", "dependsOn": [], "note": "", "createdAt": "<UTC now>", "updatedAt": "<UTC now>" }
  },
  "openItems": [],
  "result": null
}
```

(The CLI stamps `createdAt`/`updatedAt` on every unit and phase automatically — the fields above are
what `init` writes; you never hand-maintain them.)

Enumerate the units up front when they're known (DAG tasks, files to migrate); for a discovery-driven
run, start with `units: {}` and add them as they're found. Each unit's `status` moves
`pending → in_progress → done` (or `blocked` / `dep_blocked`).

If the orchestrator that runs the work has no filesystem access (e.g. a sandboxed Workflow), the
CALLER creates and updates this file — pass the absolute `statusFile` path in.

**Success criteria**: the file exists before any work starts, so a watcher sees the run immediately.

## Step 2: Update as work lands (running)

After each unit reaches a terminal state, patch the file with the CLI (Step 0.5):
`node <skill-dir>/scripts/checkpoint.mjs unit <file> <unit> done || true` — it owns locking,
atomicity, and the refusals. The `jq` recipe below is the FALLBACK for environments without Node
only; never prefer it when the CLI is available:

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
2. ANY unit not `done` — **pending / in_progress / blocked / dep_blocked** — whose `dependsOn` are all
   `done` → it's eligible; rebuild it. (`in_progress` was interrupted mid-flight — redo it. A
   `dep_blocked` unit whose dependency has since landed is eligible again — `done` is the ONLY state
   that skips.)
3. A unit whose dependency is NOT done → `dep_blocked`, pointing at the missing root; do not build it on
   a partial base.

Then run only the eligible set through the same machinery as the original run, writing back to the SAME
file (same `id`/path). The durable skip-done makes this independent of any runtime cache — a template
edit or a fresh session doesn't force a full rebuild.

For a coordinator-owned run you don't recompute this by hand — the Codex-native path drives it for you:

```bash
node autonomous-pipeline/scripts/pipeline.mjs resume --run <id>   # reads the checkpoint, skips done units
```

`run-status.mjs --resume <id>` prints exactly this command when the run's persisted launch is the
coordinator recipe; the coordinator re-reads the durable checkpoint and re-runs only the eligible set.

### Resume behavior — the five cases (make these explicit)

| Situation | State in the file | What resume does |
|---|---|---|
| **Fresh session** — no runtime memory of the prior run | any live checkpoint on disk | Drive off the FILE, not a cache. `node pipeline.mjs resume --run <id>` (or read the file + compute the resume set) — the durable checkpoint is the sole authority; `Workflow(...resumeFromRunId)` is a Claude-only cache, never the resume you rely on. |
| **Interrupted unit** — died mid-flight | a unit left `in_progress` | Re-run it. `in_progress` is NOT done — only `done` skips. The at-most-one in-flight unit is redone; everything `done` before it is skipped. |
| **Dependency-blocked** | a unit whose `dependsOn` are not all `done` | Mark it `dep_blocked` pointing at the missing root and do NOT build it — never build on a partial base. When the prerequisite later lands, it becomes eligible again automatically. |
| **Malformed / absent recipe** | `launch` missing, an array/string, or not the coordinator shape | `run-status.mjs` classifies it `no-launch` → **non-runnable**; it emits the computed `resumeSet` and points at `pipeline.mjs approve`/`start`. It NEVER fabricates a runnable command. |
| **Legacy record** | a v1 doc, or a `launch` that is a Claude `Workflow()` script | A **v1 doc** loads, resumes and finalizes UNCHANGED (see below). A **Workflow launch** is classified `legacy-workflow` → **MIGRATION-ONLY / non-runnable**: echoed for reference, never printed as a runnable Codex command. |

### v1 → v2 migration (add-only, non-breaking)

New runs are written at `schemaVersion: 2` (stable-id findings + durable `resolvedItems` + the typed
`launch`). A `schemaVersion: 1` run is fully supported: it loads, resumes and finalizes byte-for-byte
unchanged on a READ. The ONLY change ever applied is on a mutating write, where the store does an
idempotent, ADD-ONLY in-place upgrade — it adds the missing `resolvedItems: []` and bumps
`schemaVersion` — and NEVER rewrites existing `units`/`phases`/`openItems`/`launch`. An in-flight v1
run is therefore never broken by an upgrade; its finished units stay skipped and its open work stays
open. A v1 run with no persisted `launch` simply resumes via the `no-launch` path above.

**Success criteria**: finished units are provably not redone; only the remaining/eligible set runs; a
legacy/v1 record resumes without loss and without being shown a fabricated command.

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

- `scripts/checkpoint.mjs`
  The runnable implementation of this contract — init/unit/phase/get/resume/finalize with atomic writes,
  timestamped mutations, and code-enforced refusals. Prefer it over hand-rolled file operations, always.
- `scripts/run-status.mjs`
  The READ-ONLY legible reader (Step 0.6): renders the newest run (or `<id>`/`--list`/`--json`), and
  `--resume` classifies the persisted launch and prints the Codex-native coordinator resume command
  (`node pipeline.mjs resume --run <id>`) for a runnable run, or a migration-only/non-runnable pointer
  otherwise — never a fabricated command. Never writes — safe to run against a live run.
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
