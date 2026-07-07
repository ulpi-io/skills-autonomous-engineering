#!/bin/bash
# honest-stop — Stop hook. Enforces the collection's #1 principle (HONEST, FAIL-CLOSED TERMINATION):
# if an autonomous run's checkpoint is still `status: running` when the agent goes to stop, surface it so
# the turn RECONCILES the checkpoint with reality (finalize done/needs_attention/aborted) instead of ending
# while a run silently claims to still be in flight. This complements `checkpoint.mjs finalize` (which
# refuses a lying `done`) by catching the case where the agent just stops WITHOUT finalizing at all.
#
# SAFE BY DESIGN — mirrors this collection's guard philosophy ("a guard must never brick a session"):
#   · NO-OP unless a `running` checkpoint under $CLAUDE_PROJECT_DIR/.ulpi/runs has gone QUIET (untouched
#     10min–4h). A live pipeline writes status constantly, so an actively-progressing run (fresh mtime) is
#     never flagged — only a run left `running` while nothing is advancing. Ordinary sessions (no
#     .ulpi/runs) are untouched entirely.
#   · LOOP-SAFE: a stop that is itself a Stop-hook continuation (`stop_hook_active`) is always allowed.
#   · NON-BLOCKING by default (injects an honesty reminder via additionalContext). `ULPI_STOP_STRICT=1`
#     upgrades it to a hard block ({"decision":"block"}) for synchronous runs that want the deterministic
#     gate. (The pipeline legitimately yields with a `running` checkpoint while its background Workflow
#     runs — which is exactly why blocking is opt-in, not the default.)
#   · Fail-open without python3; read-only.
set -u
runs="${CLAUDE_PROJECT_DIR:-.}/.ulpi/runs"
[ -d "$runs" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0
raw=$(cat 2>/dev/null || true)

printf '%s' "$raw" | ULPI_STRICT="${ULPI_STOP_STRICT:-0}" ULPI_RUNS="$runs" python3 -c '
import sys, json, os, time, glob
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
# loop guard: never re-block a stop that is already a Stop-hook continuation
if d.get("stop_hook_active"):
    sys.exit(0)
runs = os.environ["ULPI_RUNS"]
now = time.time()
QUIET_MIN, STALE_MAX = 10 * 60, 4 * 3600
live = []
for fp in glob.glob(os.path.join(runs, "*.json")):
    try:
        r = json.load(open(fp))
    except Exception:
        continue
    if r.get("status") != "running":
        continue
    age = now - os.path.getmtime(fp)
    if age < QUIET_MIN or age > STALE_MAX:      # fresh = actively progressing (skip); >4h = abandoned (gc handles it)
        continue
    units = r.get("units", {})
    openu = [k for k, u in units.items() if u.get("status") != "done"]
    live.append((r.get("id", os.path.basename(fp)), len(openu), len(units)))
if not live:
    sys.exit(0)
ids = "; ".join("%s (%d/%d units still open)" % (i, o, t) for i, o, t in live)
reason = ("Honest-termination check: %d autonomous run(s) are still status=running and have gone quiet — %s. "
          "Before ending this turn, reconcile each checkpoint with reality: finalize it to its TRUE terminal "
          "state (checkpoint.mjs finalize <file> done|needs_attention|aborted). Never leave a run 'running' "
          "while reporting it done, and never report a clean verdict for a gate that did not run. If work is "
          "genuinely still in flight in a tracked background task, this is just a reminder to say so."
          % (len(live), ids))
if os.environ.get("ULPI_STRICT") == "1":
    print(json.dumps({"decision": "block", "reason": reason}))
else:
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": reason}}))
sys.exit(0)
'
exit 0
