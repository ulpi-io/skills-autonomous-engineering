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
  live=$(grep -l '"status"[[:space:]]*:[[:space:]]*"running"' .ulpi/runs/*.json 2>/dev/null | head -1)
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

# Fallback (no python3): conservative grep. Accepts rare false positives; still fails safe.
cmd=""
if command -v jq >/dev/null 2>&1; then
  cmd=$(printf '%s' "$raw" | jq -r '.tool_input.command // empty' 2>/dev/null)
else
  cmd="$raw"
fi
[ -z "$cmd" ] && exit 0
block() { echo "guard-git-hygiene: $1" >&2; exit 2; }
if printf '%s' "$cmd" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+add[[:space:]]+(-A|--all|-a|\.)([[:space:]]|$)'; then
  block "bulk 'git add' is banned during an autonomous run — stage the task files explicitly."
fi
if printf '%s' "$cmd" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+push[[:space:]][^|;&]*--force([[:space:]]|$)' \
   && ! printf '%s' "$cmd" | grep -q -- '--force-with-lease'; then
  block "plain 'git push --force' is banned during an autonomous run — use --force-with-lease or escalate."
fi
if printf '%s' "$cmd" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+reset[[:space:]]+--hard'; then
  block "'git reset --hard' destroys in-flight task work — checkpoint or escalate instead."
fi
exit 0
