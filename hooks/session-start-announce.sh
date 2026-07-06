#!/bin/bash
# session-start-announce — SessionStart hook.
# If the project has a resumable autonomous run (a .ulpi/runs/*.json checkpoint whose status is
# running or needs_attention), announce it so the session starts with the durable state in
# context instead of rediscovering (or worse, redoing) the work. Read-only; never blocks.
set -u

dir=".ulpi/runs"
[ -d "$dir" ] || exit 0

found=0
for f in "$dir"/*.json; do
  [ -f "$f" ] || continue
  if grep -qE '"status"[[:space:]]*:[[:space:]]*"(running|needs_attention)"' "$f" 2>/dev/null; then
    if command -v python3 >/dev/null 2>&1; then
      python3 - "$f" <<'PY' 2>/dev/null
import sys, json
try:
    d = json.load(open(sys.argv[1]))
    units = d.get("units", {})
    done = sum(1 for u in units.values() if u.get("status") == "done")
    cur = d.get("currentPhase", "")
    extra = f", phase: {cur}" if cur else ""
    print(f"Resumable autonomous run: {d.get('id','?')} [{d.get('status','?')}] — {done}/{len(units)} units done{extra} — task: {d.get('task','')[:100]} (checkpoint: {sys.argv[1]}; resume skips done units — do NOT restart from scratch or overwrite this file)")
except Exception:
    pass
PY
    else
      echo "Resumable autonomous run checkpoint: $f (status running/needs_attention — resume skips done units; do NOT overwrite it)"
    fi
    found=1
  fi
done

exit 0
