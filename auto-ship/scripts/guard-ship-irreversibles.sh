#!/bin/bash
# guard-ship-irreversibles - PreToolUse[Bash] hook. Blocks: plain force-push and push --delete during ship runs
# Quote-aware + newline-aware parsing (shlex): flags inside quoted strings never leak into
# parsing; every line and ;|& segment is analyzed separately. Anchored to CLAUDE_PROJECT_DIR.
# exit 0 = allow; exit 2 = BLOCK (stderr shown to Claude). Fail-open without python3.
set -u
raw=$(cat 2>/dev/null || true)
[ -z "$raw" ] && exit 0

if [ "${AUTO_GUARD_ALWAYS:-0}" != "1" ]; then
  # Live-run scoping, anchored to the PROJECT ROOT (hooks run in an arbitrary cwd - worktrees,
  # monorepo subdirs; CLAUDE_PROJECT_DIR exists exactly for this) with a 4h staleness window.
  live=""
  runs="${CLAUDE_PROJECT_DIR:-.}/.ulpi/runs"
  if [ -d "$runs" ]; then
    while IFS= read -r f; do
      grep -q '"status"[[:space:]]*:[[:space:]]*"running"' "$f" 2>/dev/null && { live=1; break; }
    done < <(find "$runs" -maxdepth 1 -name '*.json' -mmin -240 2>/dev/null)
  fi
  [ -z "$live" ] && exit 0
fi

command -v python3 >/dev/null 2>&1 || { echo "guard-ship-irreversibles: python3 not found - guard skipped (fail-open)" >&2; exit 0; }
RAW="$raw" python3 -c '
import os, sys, json, re, shlex
try:
    d = json.loads(os.environ.get("RAW", "{}"))
except Exception:
    sys.exit(0)
c = d.get("tool_input", {}).get("command", "")
def segments(cmd):
    # newline is a command separator; quoting is respected (shlex posix), so a flag or
    # separator INSIDE a quoted string (a commit message) can never leak into parsing.
    for line in cmd.split("\n"):
        lex = shlex.shlex(line, posix=True, punctuation_chars=";|&()")
        lex.whitespace_split = True
        try:
            toks = list(lex)
        except ValueError:
            toks = line.split()   # unbalanced quotes: fall back to coarse split (still per-line)
        seg = []
        for t in toks:
            if t and all(ch in ";|&()" for ch in t):
                if seg: yield seg
                seg = []
            else:
                seg.append(t)
        if seg:
            yield seg
def git_args(seg, sub):
    i = 0
    while i < len(seg) and re.fullmatch(r"[A-Za-z0-9_]+=.*", seg[i]):
        i += 1   # same-line env prefixes only
    if i + 1 < len(seg) and seg[i] == "git" and seg[i + 1] == sub:
        return seg[i + 2:]
    return None
def block(msg):
    print(PREFIX + msg, file=sys.stderr); sys.exit(2)

PREFIX = "guard-ship-irreversibles: "
for seg in segments(c):
    t = git_args(seg, "push")
    if t is None: continue
    if ("--force" in t or any(re.fullmatch(r"-[a-zA-Z]*f[a-zA-Z]*", x) for x in t)) and "--force-with-lease" not in t:
        block("plain git push --force rewrites shared history - an irreversible step. Use --force-with-lease, or stop and get explicit user sign-off.")
    if "--delete" in t or "-d" in t:
        block("git push --delete removes a remote ref (branch/tag) - irreversible for consumers. Get explicit user sign-off first.")
'
exit $?
