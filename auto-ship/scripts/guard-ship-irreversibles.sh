#!/bin/bash
# guard-ship-irreversibles — PreToolUse[Bash] hook for the auto-ship skill.
# Blocks the irreversible git operations a ship run must never take unilaterally:
# plain force-push (rewrites shared history) and push --delete (removes remote refs).
# These are exactly auto-ship's "human sign-off on irreversible steps" contract,
# enforced deterministically.
#
# Input:  hook JSON on stdin ({ tool_name, tool_input: { command }, ... })
# Output: exit 0 = allow; exit 2 = BLOCK (stderr is shown to Claude as the reason)
# Scope:  enforced when AUTO_GUARD_ALWAYS=1 (skill-scoped use), or when a .ulpi/runs/*.json
#         checkpoint with "status": "running" exists (plugin/global use — only guards live runs).
set -u

raw=$(cat 2>/dev/null || true)
[ -z "$raw" ] && exit 0

if [ "${AUTO_GUARD_ALWAYS:-0}" != "1" ]; then
  live=$(grep -l '"status"[[:space:]]*:[[:space:]]*"running"' .ulpi/runs/*.json 2>/dev/null | head -1)
  [ -z "$live" ] && exit 0
fi

if command -v python3 >/dev/null 2>&1; then
  RAW="$raw" python3 -c '
import os, sys, json, re
try:
    d = json.loads(os.environ.get("RAW", "{}"))
except Exception:
    sys.exit(0)
c = d.get("tool_input", {}).get("command", "")
def toks(sub):  # flag/arg tokens of each "git <sub> ..." segment, up to a shell separator
    out = []
    for m in re.finditer(r"(?:^|[;&|])\s*(?:[A-Za-z0-9_=]+\s+)*git\s+" + sub + r"\b([^|;&]*)", c):
        out.append(m.group(1).split())
    return out
def block(msg):
    print("guard-ship-irreversibles: " + msg, file=sys.stderr); sys.exit(2)
for t in toks("push"):
    if ("--force" in t or any(re.fullmatch(r"-[a-zA-Z]*f[a-zA-Z]*", x) for x in t)) and "--force-with-lease" not in t:
        block("plain git push --force rewrites shared history — an irreversible step. Use --force-with-lease, or stop and get explicit user sign-off.")
    if "--delete" in t or "-d" in t:
        block("git push --delete removes a remote ref (branch/tag) — irreversible for consumers. Get explicit user sign-off first.")
'
  exit $?
fi

# Fallback (no python3): conservative grep.
if printf '%s' "$raw" | grep -qE 'git[[:space:]]+push[^|;&]*--force([[:space:]]|\\|")' \
   && ! printf '%s' "$raw" | grep -q -- '--force-with-lease'; then
  echo "guard-ship-irreversibles: plain git push --force is irreversible — use --force-with-lease or get user sign-off." >&2
  exit 2
fi
exit 0
