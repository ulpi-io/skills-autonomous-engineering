# Status File Schema & Lifecycle

Load when defining a run's status schema, writing resume logic, or recovering a crashed run. The file
lives at `.ulpi/runs/<id>.json`. It is BOTH the live progress view and the durable checkpoint.

## Full schema

```json
{
  "schemaVersion": 1,
  "id": "migrate-auth-20260706T081500Z",
  "task": "Migrate auth module from sessions to JWT",
  "status": "running",                       // initializing | running | done | needs_attention | aborted
  "createdAt": "2026-07-06T08:15:00Z",
  "updatedAt": "2026-07-06T08:41:22Z",
  "phases": {                                 // optional — for phased runs (like a pipeline)
    "discover": { "status": "done" },
    "migrate":  { "status": "running" },
    "verify":   { "status": "pending" }
  },
  "units": {
    "src/auth/session.ts": {
      "status": "done",                       // pending | in_progress | done | blocked | dep_blocked
      "dependsOn": [],
      "note": "replaced session store with jwt verify",
      "startedAt": "2026-07-06T08:20:01Z",
      "finishedAt": "2026-07-06T08:24:10Z"
    },
    "src/auth/middleware.ts": {
      "status": "dep_blocked",
      "dependsOn": ["src/auth/session.ts"],
      "note": ""
    }
  },
  "openItems": [                              // carried forward: blocked units, findings, decisions
    { "unit": "src/db/pool.ts", "kind": "decision", "detail": "nullable vs default — needs user call" }
  ],
  "result": null                             // filled at finalize: summary + counts
}
```

Minimum viable version: `schemaVersion`, `id`, `status`, `units{status,dependsOn}`, `updatedAt`. Add
`phases`, timestamps, and `openItems` as the run warrants.

### v2 additions (schemaVersion 2)

A v2 run (the shape `checkpoint.mjs init` writes today, and what the pipeline coordinator's `approve`
produces) carries four more durable facts. A v1 run keeps working unchanged; these are add-only.

```json
{
  "schemaVersion": 2,
  "resolvedItems": [                          // findings MOVED out of openItems, with resolvedAt — the audit trail
    { "id": "f-ab12…", "phase": "test", "kind": "flake", "resolvedAt": "2026-07-06T08:40:10Z" }
  ],
  "finalValidation": { "status": "green", "at": "…", "note": "all slices green" },  // green|red — the terminal verdict
  "launch": {                                 // the typed resume recipe (see below) — how to relaunch from this file alone
    "scriptPath": "autonomous-pipeline/scripts/pipeline.mjs",
    "args": { "command": "resume", "run": "add-oauth-…" }
  },
  "pipeline": {                               // coordinator metadata (stamped by `approve`)
    "integrationRef": "refs/heads/ulpi-int-<run>",   // the serialized integration branch
    "targetRef": "refs/heads/main"                   // the eventual publish target
  }
}
```

- **openItems vs resolvedItems** — `openItems` are the UNRESOLVED findings that gate `finalize done`;
  `resolve` MOVES a finding into `resolvedItems` (stamped `resolvedAt`). Both are durable, so a converged
  run still shows what was cleared.
- **finalValidation** — the run's terminal workspace verdict. `finalize done` (with `requireValidation`)
  refuses unless it is present and `green`. `red`/absent is reported honestly, never masked.
- **integrationRef** — the branch per-task changes are serialized onto before they reach `targetRef`.

## Per-unit state machine

```
pending ──▶ in_progress ──▶ done
   │             │
   │             └──▶ blocked        (tried, couldn't complete — see note)
   └──▶ dep_blocked                  (a dependency isn't done — points at the root)
```

- **done** is the ONLY state that causes a skip on resume. Everything else is re-eligible (subject to
  deps). An `in_progress` unit found on resume was interrupted → redo it.
- **blocked** vs **dep_blocked**: `blocked` = this unit itself failed its attempts; `dep_blocked` = it
  never got to run because an upstream unit isn't `done`. Keep them distinct so triage points at the real
  root, not the symptom.

## The three verbs

- **status** → `cat .ulpi/runs/<id>.json` (or `jq '{status, done: [.units|to_entries[]|select(.value.status=="done")|.key]|length, total: (.units|length)}'`).
  At-a-glance: overall status, done/total, which units are open.
- **stop** → stop the run (TaskStop / Ctrl-C / close the Workflow). Nothing is lost — every `done` unit
  is on disk.
- **resume** → re-invoke the run pointing at the existing id/file. Read `units`, skip `done`, rebuild the
  eligible rest, write back to the SAME file.

## Atomic, incremental writes (and the lost-update caveat)

Two independent failure modes arise when writers touch the file:

1. **Torn reads** — a reader sees a half-written file. Fixed by an **atomic swap**: write `<file>.tmp`,
   then `mv` over the original (`mv` is atomic on the same filesystem).
2. **Lost updates** — two writers each read the same snapshot, each writes its own version, and the
   second `mv` silently drops the first's change. An atomic swap does NOT fix this: `jq` (like any
   read-modify-write) reads the WHOLE document, so a patch built from a stale snapshot loses a
   concurrently-finished unit. **Genuine concurrent-writer safety requires serialization** — which is
   exactly why `checkpoint.mjs` takes a `mkdir` lock around every mutation (its own header says atomic
   rename "prevents torn FILES but still LOSES updates"). Prefer `checkpoint.mjs` whenever parallel
   agents write the same status file.

The bash `jq` recipe below is the lightweight SINGLE-writer form (atomic swap, no lock): correct when the
writes are effectively serialized (one coordinator patching between phases), NOT when many agents patch at
once — use `checkpoint.mjs` for that.

```bash
patch() {  # patch <file> <unit> <status> [note]
  local f=$1 u=$2 s=$3 n=${4:-}
  jq --arg u "$u" --arg s "$s" --arg n "$n" --arg t "$(date -u +%Y%m%dT%H%M%SZ)" \
     '.units[$u].status=$s | (if $n!="" then .units[$u].note=$n else . end) | .updatedAt=$t' \
     "$f" > "$f.tmp" 2>/dev/null && mv "$f.tmp" "$f" || true   # NON-FATAL: swallow failure
}
```

The trailing `|| true` is load-bearing: a status-write failure must never take down the work.

## The `run-status` reader: render + resume recipe

`checkpoint-resume/scripts/run-status.mjs` is the READ-ONLY counterpart to `checkpoint.mjs`'s writes.
Point it at nothing and it walks up to this project's `.ulpi/runs/`, picks the newest run, and renders
it. It NEVER writes — running it can never disturb a run in flight (a contract test snapshots the runs
dir with `cksum` before/after every read path and asserts byte-identity).

**What the default render surfaces** — from the durable doc, in order:

- **badge** — the honest terminal/live state (`◐ running`, `● done`, `▲ needs attention`, `✗ aborted`).
- **branch** — `pipeline.integrationRef → pipeline.targetRef` when present (`integration → target`).
- **phases** — each phase glyph in canonical order; the current phase bolded while `running`.
- **build** — a `done/total` unit bar plus chips for in-progress / blocked / dep-blocked / pending, with a
  detail line (note + duration) for anything not moving forward.
- **open / resolved** — the count of UNRESOLVED findings (with up to ten one-liners) and a one-line count
  of the durable `resolvedItems` audit trail.
- **final** — the `finalValidation` verdict: `✓ validation green` or an honest `✗ validation red/…`.
- **result** — the finalize result summary, when set.
- **footer** — the honest close: `done` says done; `aborted` says aborted and is NOT offered as resumable;
  a live run gets a real resume affordance (see below).

**The resume recipe (`--resume`)** — Codex-native and **argv-safe**. The reader classifies the run's
persisted `launch`:

- **Runnable (`codex-cli`)** — `launch` is the coordinator recipe (`scriptPath` basename `pipeline.mjs`,
  `args.command === "resume"`, string `args.run`). `--resume` prints the exact shell-safe command:

  ```
  node pipeline.mjs resume --run <id>
  ```

  The `<id>` is a discrete argv token — never string-interpolated into a shell — and is defensively
  single-quoted if it is not a bare `[A-Za-z0-9._/@:=+-]` token. `--resume --json` emits ONLY the typed
  descriptor: `{ runnable:true, kind:"codex-cli", run, command:"node", argv:[…], shell, resumeSet }`.
- **Legacy Workflow (`legacy-workflow`)** — `launch` is a Claude `Workflow()` script (e.g.
  `pipeline-workflow.js`). It is labeled **MIGRATION ONLY / non-runnable** and is NEVER printed as a
  runnable shell command; the reader still echoes the persisted descriptor (with `statusFile` re-pinned to
  this run) for migration reference. `--resume --json` → `{ runnable:false, migrationOnly:true,
  kind:"legacy-workflow", reason, legacyLaunch, resumeSet }`.
- **No launch (`no-launch`)** — nothing runnable was persisted (pre-coordinator or hand-rolled run):
  non-runnable, with the computed `resumeSet` so a human can relaunch via `pipeline.mjs approve`/`start`.

`resumeSet` is the skip-done contract computed READ-ONLY: `{ skip:[done], eligible:[re-runnable],
dep_blocked:{unit→root} }`.

## Recovering a crashed run (no final write)

A run killed mid-flight leaves `status: "running"` and maybe an `in_progress` unit — do NOT trust that
as the end state. Reconstruct from artifacts:

- For a git-integrating run: `git log`/`git branch` shows which units actually merged → those are `done`
  regardless of what the file says.
- For a file migration: check each target file's actual content/marker.
- For a converge-loop: re-run the validate; the real signal beats the recorded one.

Rebuild the `units` map from that ground truth, then resume normally. This is why the checkpoint is
"skip what's *actually* done", not "trust the last write blindly".

## Relationship to the runtime's resume

Claude Code's Workflow tool has its own `resumeFromRunId` (agent-result cache). That's an *optimization*
layered on top — it makes a same-session resume instant. This file is the *source of truth*: it works
across sessions, survives cache invalidation (any template edit busts the agent cache), and is what makes
resume durable rather than best-effort. Use both when available; rely on the file.
