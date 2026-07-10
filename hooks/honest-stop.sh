#!/bin/bash
# honest-stop — Stop hook (DUAL: Claude hooks.claude.json + Codex hooks.json). Enforces the collection's
# #1 principle (HONEST, FAIL-CLOSED TERMINATION): if an autonomous run's checkpoint is still
# `status: running` when the agent goes to stop, surface it so the turn RECONCILES the checkpoint with
# reality (finalize done/needs_attention/aborted) instead of ending while a run silently claims to still be
# in flight. Complements `checkpoint.mjs finalize` (which refuses a lying `done`) by catching the case where
# the agent just stops WITHOUT finalizing at all.
#
# SURFACE + OUTPUT SCHEMA:
#   · Claude sets CLAUDE_PROJECT_DIR → runs live under it; the nonblocking notice uses the Claude shape
#     {"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":…}}.
#   · Codex sets no CLAUDE_PROJECT_DIR → the payload's `cwd` (stdin) resolves the git root; the nonblocking
#     notice uses the documented Codex field {"systemMessage":…} (NOT the Claude hookSpecificOutput key).
#   · STRICT mode (ULPI_STOP_STRICT=1) hard-blocks on BOTH surfaces with the real Codex Stop-hook block
#     schema {"decision":"block","reason":…} (also valid on Claude) — the deterministic gate synchronous
#     runs opt into. The pipeline legitimately yields with a `running` checkpoint while its background
#     Workflow runs, which is exactly why blocking is opt-in and the DEFAULT is a nonblocking notice.
#
# SAFE BY DESIGN — fails open, never bricks a session, never archives anything:
#   · NO-OP unless a `running` checkpoint that is not ancient (>4h = abandoned; gc archives it) exists.
#   · LOOP/RECURSION-SAFE: a stop that is itself a Stop-hook continuation (`stop_hook_active`) is allowed.
#   · Malformed input, no python3, absent runs dir, no resolvable cwd, and stale/absent running runs all
#     fail open (exit 0, no output). A tracked background run yields the nonblocking notice, not a block.
set -u
command -v python3 >/dev/null 2>&1 || exit 0                # absent runtime → fail open
raw=$(cat 2>/dev/null || true)

surface="claude"
[ -z "${CLAUDE_PROJECT_DIR:-}" ] && surface="codex"
# Claude fast-path preserved: with an env project root and no runs dir, exit before spawning python.
if [ "$surface" = "claude" ]; then
  [ -d "${CLAUDE_PROJECT_DIR}/.ulpi/runs" ] || exit 0
fi

printf '%s' "$raw" \
  | ULPI_STRICT="${ULPI_STOP_STRICT:-0}" ULPI_SURFACE="$surface" ULPI_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}" python3 -c '
import sys, json, os, time, glob
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)                       # malformed input → fail open (never block on garbage)
if not isinstance(d, dict):
    sys.exit(0)
# recursion/loop guard: never re-block a stop that is already a Stop-hook continuation
if d.get("stop_hook_active"):
    sys.exit(0)
# Resolve the project root: Claude via env, Codex via the payload cwd (walk up to the git root).
proj = os.environ.get("ULPI_PROJECT_DIR", "")
if not proj:
    cwd = d.get("cwd")
    if not isinstance(cwd, str) or not cwd:
        sys.exit(0)                   # no cwd → cannot locate runs → fail open
    p = os.path.abspath(cwd)
    proj = p
    while True:
        if os.path.exists(os.path.join(p, ".git")):
            proj = p
            break
        parent = os.path.dirname(p)
        if parent == p:
            break
        p = parent
runs = os.path.join(proj, ".ulpi", "runs")
if not os.path.isdir(runs):
    sys.exit(0)                       # absent checkpoint dir → fail open
now = time.time()
STALE_MAX = 4 * 3600
live = []
for fp in glob.glob(os.path.join(runs, "*.json")):
    try:
        r = json.load(open(fp))
    except Exception:
        continue
    if not isinstance(r, dict) or r.get("status") != "running":
        continue
    if now - os.path.getmtime(fp) > STALE_MAX:   # >4h = abandoned (gc archives it); fresher is surfaced
        continue
    units = r.get("units", {}) or {}
    openu = [k for k, u in units.items() if isinstance(u, dict) and u.get("status") != "done"]
    live.append((r.get("id", os.path.basename(fp)), len(openu), len(units)))
if not live:
    sys.exit(0)
ids = "; ".join("%s (%d/%d units still open)" % (i, o, t) for i, o, t in live)
reason = ("Honest-termination check: %d autonomous run(s) are still status=running — %s. "
          "Before ending this turn, reconcile each checkpoint with reality: finalize it to its TRUE terminal "
          "state (checkpoint.mjs finalize <file> done|needs_attention|aborted). Never leave a run marked "
          "running while reporting it done, and never report a clean verdict for a gate that did not run. If "
          "work is genuinely still in flight in a tracked background task, this is just a reminder to say so."
          % (len(live), ids))
if os.environ.get("ULPI_STRICT") == "1":
    # Deterministic gate — real Codex Stop-hook block schema (also valid on Claude).
    print(json.dumps({"decision": "block", "reason": reason}))
elif os.environ.get("ULPI_SURFACE") == "codex":
    # Codex nonblocking notice — documented Codex field, NOT the Claude hookSpecificOutput key.
    print(json.dumps({"systemMessage": reason}))
else:
    # Claude nonblocking notice — preserved shape.
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": reason}}))
sys.exit(0)
'
exit 0
