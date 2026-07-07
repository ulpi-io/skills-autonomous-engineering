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
