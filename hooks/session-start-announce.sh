#!/bin/bash
# session-start-announce — SessionStart hook (DUAL: Claude hooks.claude.json + Codex hooks.json).
# Announce RESUMABLE autonomous runs so a session starts with the durable state in context —
# bounded, recency-aware, and silence-able:
#   · running runs are always announced; those untouched >4h are flagged [STALE] (guards no longer armed by them)
#   · needs_attention runs are announced only if updated in the last 7 days
#   · at most the 3 most recent runs are announced; the rest collapse into one summary line
#   · each announced run carries the EXACT coordinator resume command: node pipeline.mjs resume --run <id>
#
# SURFACE RESOLUTION (preserves Claude behavior exactly):
#   · Claude sets CLAUDE_PROJECT_DIR → project root is that dir; stdin is NOT read (no blocking).
#   · Codex sets no CLAUDE_PROJECT_DIR → the hook payload arrives on stdin as JSON with a `cwd`; we resolve
#     the git root by walking up from that cwd (falling back to cwd itself when there is no .git).
#   · Codex has NO SessionEnd event, so this session-start path also folds in checkpoint.mjs gc — archiving
#     TERMINAL runs into .ulpi/runs/archive (checkpoint.mjs gc NEVER touches a running/initializing run).
#     (Claude keeps its own SessionEnd gc; we do not double-run it here.)
# Read-only announcement; never blocks; fails open silently (no python3 / malformed cwd / absent runs).
set -u

if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  # ── Claude surface: env-provided project root, no stdin, no session-start gc (SessionEnd owns it). ──
  root="$CLAUDE_PROJECT_DIR"
  surface="claude"
else
  # ── Codex surface: derive the git root from the payload `cwd` on stdin. ──
  command -v python3 >/dev/null 2>&1 || exit 0
  raw=$(cat 2>/dev/null || true)
  root="$(printf '%s' "$raw" | python3 -c '
import sys, json, os
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)                       # malformed payload → fail open (announce nothing)
if not isinstance(d, dict):
    sys.exit(0)
cwd = d.get("cwd")
if not isinstance(cwd, str) or not cwd:
    sys.exit(0)                       # no cwd → cannot locate the repo → fail open
p = os.path.abspath(cwd)
root = p
while True:                           # walk up to the git root; fall back to cwd when no .git exists
    if os.path.exists(os.path.join(p, ".git")):
        root = p
        break
    parent = os.path.dirname(p)
    if parent == p:
        break
    p = parent
print(root)
' 2>/dev/null)"
  [ -n "$root" ] || exit 0
  surface="codex"
fi

runs="$root/.ulpi/runs"
[ -d "$runs" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

# Codex-only: archive TERMINAL runs on session-start (no SessionEnd exists). checkpoint.mjs gc skips
# running/initializing runs, so a live run is NEVER archived. Best-effort; fail open without node/script.
if [ "$surface" = "codex" ] && command -v node >/dev/null 2>&1; then
  for p in "${CODEX_PLUGIN_ROOT:-/nonexistent}/checkpoint-resume/scripts/checkpoint.mjs" \
           "${CLAUDE_PLUGIN_ROOT:-/nonexistent}/checkpoint-resume/scripts/checkpoint.mjs" \
           "$root/.claude/skills/checkpoint-resume/scripts/checkpoint.mjs" \
           "$root/.agents/skills/checkpoint-resume/scripts/checkpoint.mjs" \
           "$HOME/.claude/skills/checkpoint-resume/scripts/checkpoint.mjs" \
           "$HOME/.agents/skills/checkpoint-resume/scripts/checkpoint.mjs"; do
    [ -f "$p" ] && { node "$p" gc "$runs" --keep-days "${ULPI_GC_KEEP_DAYS:-7}" >/dev/null 2>&1 || true; break; }
  done
fi

python3 - "$runs"/*.json <<'PY' 2>/dev/null
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
    if not isinstance(d, dict):
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
    units = d.get("units", {}) or {}
    done = sum(1 for u in units.values() if isinstance(u, dict) and u.get("status") == "done")
    cur = d.get("currentPhase", "")
    rid = d.get("id", "?")
    stale = " [STALE — untouched >4h; guards no longer armed by it]" if status == "running" and age > 4 * 3600 else ""
    extra = f", phase: {cur}" if cur else ""
    print(f"Resumable autonomous run: {rid} [{status}]{stale} — {done}/{len(units)} units done{extra} — "
          f"task: {str(d.get('task',''))[:80]}")
    print(f"  → resume (coordinator): node pipeline.mjs resume --run {rid}   "
          f"(checkpoint: {fp}; resume skips done units — do NOT re-init or overwrite)")
if len(runs) > 3:
    print(f"...and {len(runs) - 3} older resumable run(s) in .ulpi/runs — archive finished ones with: "
          f"node <checkpoint-resume skill>/scripts/checkpoint.mjs gc .ulpi/runs")
PY

exit 0
