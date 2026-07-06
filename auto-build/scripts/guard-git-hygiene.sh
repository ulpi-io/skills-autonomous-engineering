#!/bin/bash
# guard-git-hygiene — PreToolUse[Bash] hook.
# Blocks bulk staging and history-destroying git during an active autonomous build run,
# enforcing auto-build's "stage only the task's files / clean rollback per task" contract
# deterministically instead of by prompt exhortation.
#
# Input:  hook JSON on stdin ({ tool_name, tool_input: { command }, cwd, ... })
# Output: exit 0 = allow; exit 2 = BLOCK (stderr is shown to Claude as the reason)
# Scope:  enforced when AUTO_GUARD_ALWAYS=1 (skill-scoped use), or when a .ulpi/runs/*.json
#         checkpoint with "status": "running" exists (plugin/global use — only guards live runs).
set -u

raw=$(cat 2>/dev/null || true)
[ -z "$raw" ] && exit 0

# Scoping: skill-scoped installs export AUTO_GUARD_ALWAYS=1; otherwise only guard live runs.
if [ "${AUTO_GUARD_ALWAYS:-0}" != "1" ]; then
  # Live-run scoping with a STALENESS window: a real autonomous run touches its checkpoint constantly
  # (status writes), so only a running checkpoint modified in the last 4h arms the guard. A crashed
  # run from last week can never lock a user out of normal git usage (see also: checkpoint.mjs gc).
  live=""
  if [ -d .ulpi/runs ]; then
    for f in $(find .ulpi/runs -maxdepth 1 -name '*.json' -mmin -240 2>/dev/null); do
      grep -q '"status"[[:space:]]*:[[:space:]]*"running"' "$f" 2>/dev/null && { live=1; break; }
    done
  fi
  [ -z "$live" ] && exit 0
fi

# Preferred path: token-accurate parse via python3 (no regex-on-flags false positives:
# --amend stays allowed, a commit message containing "-a" stays allowed).
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
    print("guard-git-hygiene: " + msg, file=sys.stderr); sys.exit(2)
for t in toks("add"):
    if any(x in ("-A", "--all", "-a", ".") for x in t):
        block("bulk staging (git add -A/./--all) is banned during an autonomous run — stage ONLY the current task files by explicit path (per-task clean-rollback contract).")
for t in toks("commit"):
    if any(x == "--all" or (re.fullmatch(r"-[a-zA-Z]+", x) and "a" in x[1:]) for x in t):
        block("git commit -a/--all stages everything implicitly — add the task files explicitly, then commit.")
for t in toks("push"):
    if ("--force" in t or any(re.fullmatch(r"-[a-zA-Z]*f[a-zA-Z]*", x) for x in t)) and "--force-with-lease" not in t:
        block("plain git push --force is banned during an autonomous run — use --force-with-lease, or stop and ask the user (irreversible-step escalation).")
for t in toks("reset"):
    if "--hard" in t:
        block("git reset --hard destroys in-flight task work — checkpoint or escalate instead.")
for t in toks("clean"):
    if any(x == "--force" or (re.fullmatch(r"-[a-zA-Z]+", x) and "f" in x[1:]) for x in t):
        block("git clean -f destroys in-flight task work — checkpoint or escalate instead.")
'
  exit $?
fi

# No python3 → honest fail-open (a half-strength lookalike guard is worse than a declared no-op;
# the prompt-level contract still applies and the resolver already fails open when the script is absent).
echo "guard-git-hygiene: python3 not found — guard skipped (fail-open)" >&2
exit 0
