#!/bin/bash
# guard-ship-irreversibles - PreToolUse[Bash] hook. Blocks history-rewriting/ref-removing pushes during ship runs:
#   force (--force, -f clusters, a `+refspec`, --mirror) and ref-delete (--delete/-d, a `:refspec`, --prune, --mirror).
# Quote-aware + newline-aware parsing (shlex). Live-run scoping and rules run in ONE python pass
# (top-level status is JSON-parsed, never grepped). Anchored to CLAUDE_PROJECT_DIR.
# exit 0 = allow; exit 2 = BLOCK (stderr shown to Claude). Fail-open without python3.
set -u
raw=$(cat 2>/dev/null || true)
[ -z "$raw" ] && exit 0
command -v python3 >/dev/null 2>&1 || { echo "guard-ship-irreversibles: python3 not found - guard skipped (fail-open)" >&2; exit 0; }
printf '%s' "$raw" | ULPI_RUNS="${CLAUDE_PROJECT_DIR:-.}/.ulpi/runs" ULPI_ALWAYS="${AUTO_GUARD_ALWAYS:-0}" python3 -c '
import sys, os, json, re, shlex, glob, time
if os.environ.get("ULPI_ALWAYS") != "1":
    runs = os.environ.get("ULPI_RUNS", "")
    now, live = time.time(), False
    for f in glob.glob(os.path.join(runs, "*.json")):
        try:
            if now - os.path.getmtime(f) > 240 * 60:
                continue
            with open(f) as fh:
                doc = json.load(fh)
            if isinstance(doc, dict) and doc.get("status") == "running":
                live = True
                break
        except Exception:
            continue
    if not live:
        sys.exit(0)
try:
    d = json.load(open(0))
except Exception:
    sys.exit(0)
c = d.get("tool_input", {}).get("command", "")
def segments(cmd):
    for line in cmd.split("\n"):
        lex = shlex.shlex(line, posix=True, punctuation_chars=";|&()")
        lex.whitespace_split = True
        try:
            toks = list(lex)
        except ValueError:
            toks = line.split()
        seg = []
        for t in toks:
            if t and all(ch in ";|&()" for ch in t):
                if seg: yield seg
                seg = []
            else:
                seg.append(t)
        if seg:
            yield seg
GIT_GLOBAL_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"}
def git_args(seg, sub):
    i = 0
    while i < len(seg) and re.fullmatch(r"[A-Za-z0-9_]+=.*", seg[i]):
        i += 1
    if i >= len(seg) or seg[i] != "git":
        return None
    i += 1
    while i < len(seg) and seg[i].startswith("-"):
        i += 2 if seg[i] in GIT_GLOBAL_WITH_VALUE else 1
    if i < len(seg) and seg[i] == sub:
        return seg[i + 1:]
    return None
def block(msg):
    print(PREFIX + msg, file=sys.stderr); sys.exit(2)
PREFIX = "guard-ship-irreversibles: "
SHELLS = {"bash", "sh", "zsh", "dash", "ksh", "ash"}
def shell_payloads(seg):
    # A nested `bash -c "git push --force"` hides the push from the top-level parse; yield each -c
    # payload so the same rules re-scan it (closes the wrapper-shell bypass).
    i = 0
    while i < len(seg) and re.fullmatch(r"[A-Za-z0-9_]+=.*", seg[i]):
        i += 1
    if i >= len(seg) or seg[i].rsplit("/", 1)[-1] not in SHELLS:
        return
    i += 1
    while i < len(seg):
        if seg[i] == "-c" or re.fullmatch(r"-[a-z]*c", seg[i]):
            if i + 1 < len(seg):
                yield seg[i + 1]
            i += 2
        else:
            i += 1
def check_cmd(cmd, depth=0):
    for seg in segments(cmd):
        t = git_args(seg, "push")
        if t is not None:
            positionals = [x for x in t if not x.startswith("-")]
            forced_refspec = any(x.startswith("+") for x in positionals)   # `+main` / `+refs/...` force a rewrite WITHOUT --force
            # A forced push in ANY form is irreversible, INCLUDING when combined with --force-with-lease (git
            # gives --force precedence, silently disabling the lease). Only a LONE --force-with-lease is allowed.
            forces = ("--force" in t or any(re.fullmatch(r"-[a-zA-Z]*f[a-zA-Z]*", x) for x in t)
                      or forced_refspec or "--mirror" in t)
            if forces:
                block("a forced push (--force, a -f cluster, a +refspec like `+main`, or --mirror - even alongside --force-with-lease) rewrites shared history, an irreversible step. Use a LONE --force-with-lease, or stop and get explicit user sign-off.")
            delete_refspec = any(x.startswith(":") for x in positionals)   # `:main` (empty source) deletes the remote ref
            if "--delete" in t or "-d" in t or delete_refspec or "--prune" in t or "--mirror" in t:
                block("removing a remote ref (git push --delete/-d, a `:refspec`, --prune, or --mirror) is irreversible for consumers. Get explicit user sign-off first.")
        if depth < 4:
            for payload in shell_payloads(seg):
                check_cmd(payload, depth + 1)
check_cmd(c)
'
exit $?
