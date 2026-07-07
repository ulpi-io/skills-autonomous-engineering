#!/bin/bash
# session-start-announce — SessionStart hook.
# Announce RESUMABLE autonomous runs so a session starts with the durable state in context —
# bounded, recency-aware, and silence-able:
#   · running runs are always announced; those untouched >4h are flagged [STALE] (guards no longer armed by them)
#   · needs_attention runs are announced only if updated in the last 7 days
#   · at most the 3 most recent runs are announced; the rest collapse into one summary line
#   · `node <checkpoint-resume>/scripts/checkpoint.mjs gc .ulpi/runs` archives old terminal runs
# Read-only; never blocks; silent without python3.
set -u

dir="${CLAUDE_PROJECT_DIR:-.}/.ulpi/runs"
[ -d "$dir" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

python3 - "$dir"/*.json <<'PY' 2>/dev/null
import sys, json, os, time

now = time.time()
DAY = 86400
runs = []
for fp in sys.argv[1:]:
    if not os.path.isfile(fp):
        continue
    try:
        d = json.load(open(fp))
    except Exception:
        continue
    status = d.get("status")
    if status not in ("running", "needs_attention"):
        continue
    age = now - os.path.getmtime(fp)
    if status == "needs_attention" and age > 7 * DAY:
        continue                     # old open-items runs stop nagging after a week (gc archives them)
    runs.append((age, status, fp, d))

runs.sort(key=lambda r: (r[1] != "running", r[0]))   # running FIRST (the header's promise), then freshest —
                                     # so a live/interrupted run is never crowded out of the top-3 by
                                     # fresher needs_attention runs (the case a re-init must be warned about)
for age, status, fp, d in runs[:3]:
    units = d.get("units", {})
    done = sum(1 for u in units.values() if u.get("status") == "done")
    cur = d.get("currentPhase", "")
    stale = " [STALE — untouched >4h; guards no longer armed by it]" if status == "running" and age > 4 * 3600 else ""
    extra = f", phase: {cur}" if cur else ""
    print(f"Resumable autonomous run: {d.get('id','?')} [{status}]{stale} — {done}/{len(units)} units done{extra} — "
          f"task: {str(d.get('task',''))[:80]} (checkpoint: {fp}; resume skips done units — do NOT re-init or overwrite)")
if len(runs) > 3:
    print(f"...and {len(runs) - 3} older resumable run(s) in .ulpi/runs — archive finished ones with: "
          f"node <checkpoint-resume skill>/scripts/checkpoint.mjs gc .ulpi/runs")
PY

exit 0
