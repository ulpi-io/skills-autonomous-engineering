#!/bin/bash
# guard-git-hygiene - PreToolUse[Bash] hook. Blocks: bulk staging, commit -a, forced/mirror push,
# reset --hard, clean -f during autonomous runs.
# Quote-aware + newline-aware parsing (shlex): flags inside quoted strings never leak into
# parsing; every line and ;|& segment is analyzed separately. Anchored to CLAUDE_PROJECT_DIR.
# Live-run scoping and rule matching happen in ONE python pass (top-level status is JSON-parsed,
# never grepped - a phase/unit or a task-description string saying "running" must not arm the guard).
# exit 0 = allow; exit 2 = BLOCK (stderr shown to Claude). Fail-open without python3.
set -u
raw=$(cat 2>/dev/null || true)
[ -z "$raw" ] && exit 0
command -v python3 >/dev/null 2>&1 || { echo "guard-git-hygiene: python3 not found - guard skipped (fail-open)" >&2; exit 0; }
printf '%s' "$raw" | ULPI_RUNS="${CLAUDE_PROJECT_DIR:-.}/.ulpi/runs" ULPI_ALWAYS="${AUTO_GUARD_ALWAYS:-0}" python3 -c '
import sys, os, json, re, shlex, glob, time
# ── live-run scoping: enforce always under AUTO_GUARD_ALWAYS, else only while a run is genuinely
#    live (TOP-LEVEL status == running, JSON-parsed, within a 4h staleness window). ──
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
def _cmd_str(v):
    # Claude: tool_input.command is a STRING. Codex`s shell tool delivers an argv LIST (e.g.
    # ["bash","-lc","git add -A"]); shlex.quote each token so element boundaries survive
    # re-tokenization (the whole "git add -A" element stays one token for the nested-shell re-scan)
    # instead of word-splitting into a broken parse. Any other type → "" (fail-open on malformed).
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return " ".join(shlex.quote(x) for x in v if isinstance(x, str))
    return ""
ti = d.get("tool_input", {})
if not isinstance(ti, dict):
    ti = {}
# Extract from every payload shape so a Codex Bash call parses IDENTICALLY to Claude`s: the argv may sit
# at tool_input.command (Codex list or Claude string) OR at the TOP LEVEL beside cwd/env (a Codex payload
# shape on a different JSON path). First non-empty wins.
c = _cmd_str(ti.get("command")) or _cmd_str(d.get("command"))
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
PREFIX = "guard-git-hygiene: "
def is_bulk_add(x):
    # whole-index / whole-tree staging in any spelling: -A/--all, -u/--update (all tracked mods),
    # . or * (whole cwd - `*` is the LITERAL token the hook sees pre-shell-expansion), root pathspecs,
    # and short clusters carrying A or u (e.g. -au, -uA).
    if x in ("-A", "--all", "-u", "--update", ".", "*", ":/", ":(top)"):
        return True
    if x.rstrip("/") == ".":            # `.` `./` `.//` — whole-cwd staging in any trailing-slash spelling
        return True
    if x.startswith(":/") or x.startswith(":(top)"):
        return True
    if re.fullmatch(r"-[A-Za-z]+", x) and any(c in x[1:] for c in ("A", "u")):
        return True
    return False
SHELLS = {"bash", "sh", "zsh", "dash", "ksh", "ash"}
def shell_payloads(seg):
    # A nested "bash -c <cmd>" / "sh -c <cmd>" hides its git op from the top-level parse (the outer
    # segment starts with the shell name, not "git"). Yield each -c payload so the SAME rules re-scan it,
    # closing the "bash -c git add -A" wrapper bypass. A payload that merely MENTIONS git inside a quoted
    # string still parses inertly (the token is not "git"), so this adds no false positives.
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
        for _sub in ("add", "stage"):
            t = git_args(seg, _sub)
            if t is not None and any(is_bulk_add(x) for x in t):
                block("bulk staging (git add/stage -A/-u/./*/--all or a whole-repo pathspec) is banned during an autonomous run - stage ONLY the current task files by explicit path (per-task clean-rollback contract).")
        t = git_args(seg, "commit")
        if t is not None and any(x == "--all" or (re.fullmatch(r"-[a-zA-Z]+", x) and "a" in x[1:]) for x in t):
            block("git commit -a/--all stages everything implicitly - add the task files explicitly, then commit.")
        t = git_args(seg, "push")
        if t is not None:
            # A forced push in ANY form is blocked, even alongside --force-with-lease (git gives --force
            # precedence, so `push --force-with-lease --force` silently disables the lease check). Only a
            # LONE --force-with-lease (no --force/-f cluster/--mirror/+refspec) is allowed.
            forced = ("--force" in t or "--mirror" in t
                      or any(re.fullmatch(r"-[A-Za-z]*f[A-Za-z]*", x) for x in t)
                      or any(x.startswith("+") and len(x) > 1 and not x.startswith("--") for x in t))
            if forced:
                block("forced push (git push --force / -f / --mirror / +refspec) rewrites shared history - use a LONE --force-with-lease, or stop and ask the user (irreversible-step escalation).")
        t = git_args(seg, "reset")
        if t is not None and "--hard" in t:
            block("git reset --hard destroys in-flight task work - checkpoint or escalate instead.")
        t = git_args(seg, "clean")
        if t is not None and any(x == "--force" or (re.fullmatch(r"-[a-zA-Z]+", x) and "f" in x[1:]) for x in t):
            block("git clean -f destroys in-flight task work - checkpoint or escalate instead.")
        # Recurse into nested shell payloads (bounded depth) so a wrapper shell cannot smuggle a banned op.
        if depth < 4:
            for payload in shell_payloads(seg):
                check_cmd(payload, depth + 1)
check_cmd(c)
'
exit $?
