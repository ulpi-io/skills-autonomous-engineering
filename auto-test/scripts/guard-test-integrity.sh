#!/bin/bash
# guard-test-integrity — PreToolUse[Edit|Write] hook.
# Blocks edits that WEAKEN the test signal (skip/only/vacuous silencing) in test files —
# the cardinal sin of auto-test's fail-closed contract ("never game the suite green"),
# enforced deterministically instead of by prompt exhortation.
#
# Input:  hook JSON on stdin ({ tool_name, tool_input: { file_path, new_string|content }, ... })
# Output: exit 0 = allow; exit 2 = BLOCK (stderr shown to Claude as the reason)
# Escape: AUTO_TEST_ALLOW_WEAKEN=1 skips the guard (for a user-approved, explained change).
# Scope:  enforced when AUTO_GUARD_ALWAYS=1 (skill-scoped use), or when a .ulpi/runs/*.json
#         checkpoint with "status": "running" exists (plugin/global use — only guards live runs).
set -u

[ "${AUTO_TEST_ALLOW_WEAKEN:-0}" = "1" ] && exit 0
# File-based escape hatch — actionable MID-SESSION (an env var is not: the hook env is fixed at launch).
# `touch <project>/.ulpi/allow-test-weaken` approves weakening edits for a 2-MINUTE WINDOW, then expires.
# Window (not one-shot-delete) because the same edit can hit MULTIPLE registered guard instances
# (plugin hooks.json + skill frontmatter) — a consumed-on-first-sight flag would pass one and block the
# other. Expired flags are lazily removed.
FLAG="${CLAUDE_PROJECT_DIR:-.}/.ulpi/allow-test-weaken"
if [ -f "$FLAG" ]; then
  if [ -n "$(find "$FLAG" -mmin -2 2>/dev/null)" ]; then exit 0; fi
  rm -f "$FLAG"
fi

command -v python3 >/dev/null 2>&1 || { echo "guard-test-integrity: python3 not found — guard skipped (fail-open)" >&2; exit 0; }

raw=$(cat 2>/dev/null || true)
[ -z "$raw" ] && exit 0

# ONE python pass does BOTH live-run scoping and payload extraction. Scoping JSON-parses the TOP-LEVEL
# status (a phase/unit that is "running", or a task description containing that word, must NOT arm the
# guard — the old grep-anywhere did, keeping guards armed for hours after a run finalized). When not
# live it prints nothing → bash allows. The escape flag/env are handled in bash above.
parsed=$(printf '%s' "$raw" | ULPI_RUNS="${CLAUDE_PROJECT_DIR:-.}/.ulpi/runs" ULPI_ALWAYS="${AUTO_GUARD_ALWAYS:-0}" python3 -c '
import sys, os, json, glob, time, fnmatch
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
        sys.exit(0)   # not live → print nothing → bash allows
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
ti = d.get("tool_input", {})
if not isinstance(ti, dict):
    ti = {}
name = d.get("tool_name", "") or ""

def is_test_path(p):
    p = (p or "").strip()
    b = os.path.basename(p)
    parent = os.path.basename(os.path.dirname(p))
    for pat in ("*.test.*", "*.spec.*", "*_test.*", "test_*", "*Test.*", "*Spec.*"):
        if fnmatch.fnmatchcase(b, pat):
            return True
    return parent in ("test", "tests", "__tests__", "spec", "specs", "testing")

def as_text(v):
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return "\n".join(x for x in v if isinstance(x, str))
    return ""

# Codex delivers edits as an apply_patch payload (NOT Edit/Write new_string/content). Parse the patch
# across Add/Update/Move sections; collect ONLY the ADDED (+) lines that land in a TEST file. Production
# adds, deleted (-) lines, context ( ) lines, and diff/hunk headers are excluded — so identical weakening
# text outside a test-file addition stays allowed, and a multi-file patch cannot smuggle a weakening test
# edit behind a safe non-test edit. The collected added lines feed the SAME token matcher as Edit/Write.
patch_text = as_text(ti.get("input")) or as_text(ti.get("patch"))
if not patch_text and name == "apply_patch":
    patch_text = as_text(ti.get("content")) or as_text(ti.get("command"))
markers = ("*** Begin Patch", "*** Add File:", "*** Update File:", "*** Delete File:")
if patch_text and any(m in patch_text for m in markers):
    collected, is_test, active = [], False, False
    for line in patch_text.split("\n"):
        if line.startswith("*** Add File: "):
            is_test = is_test_path(line[len("*** Add File: "):]); active = True; continue
        if line.startswith("*** Update File: "):
            is_test = is_test_path(line[len("*** Update File: "):]); active = True; continue
        if line.startswith("*** Delete File: "):
            is_test = False; active = False; continue
        if line.startswith("*** Move to: "):
            is_test = is_test or is_test_path(line[len("*** Move to: "):]); continue
        if line.startswith("*** Begin Patch") or line.startswith("*** End Patch"):
            active = False; continue
        if line.startswith("@@"):
            continue
        if active and is_test and line.startswith("+") and not line.startswith("+++"):
            collected.append(line[1:])
    print("")
    print("\n".join(collected).replace("\n", "\\n"))
    sys.exit(0)

print(ti.get("file_path", ""))
print((ti.get("new_string") or ti.get("content") or "").replace("\n", "\\n"))
' 2>/dev/null)
fp=$(printf '%s\n' "$parsed" | sed -n 1p)
added=$(printf '%s\n' "$parsed" | sed -n 2p)
[ -z "$added" ] && exit 0

# Only guard test files.
is_test=0
base=$(basename "$fp" 2>/dev/null || echo "$fp")
parent=$(basename "$(dirname "$fp")" 2>/dev/null || echo "")
case "$base" in
  *.test.*|*.spec.*|*_test.*|test_*|*Test.*|*Spec.*) is_test=1 ;;
esac
case "$parent" in
  test|tests|__tests__|spec|specs|testing) is_test=1 ;;
esac
[ "$is_test" = "0" ] && [ -n "$fp" ] && exit 0

block() { echo "guard-test-integrity: $1 (if this weakening is genuinely intended and user-approved: run 'touch <project-root>/.ulpi/allow-test-weaken' then retry — the flag approves weakening edits for 2 minutes, then expires — and state the reason in your reply)" >&2; exit 2; }

# The payload arrived with real newlines escaped to the literal chars backslash+n (so the added text
# stays on ONE line for the two-line extraction above). Restore real newlines before matching, or the
# ^ / boundary anchors below (xit/xdescribe/xtest at a line start) silently never fire on multi-line edits.
added_lines=${added//\\n/$'\n'}
# Skip/only/todo — silences or narrows the suite. Anchored to test-framework keywords so a genuine
# test-runner marker (it.skip, describe.only, test.todo, xit(...)) is caught while unrelated APIs that
# happen to have .skip()/.only() — Stream.skip(1), a DB cursor.skip(10), RxJS — are NOT (blocking those
# taught agents to reach for the bypass on legitimate edits).
if printf '%s' "$added_lines" | grep -qE '(^|[^A-Za-z0-9_])(describe|context|suite|it|test|bench)\.(only|skip|todo)([^A-Za-z0-9_]|$)|(^|[^a-zA-Z_])(xit|xdescribe|xtest|fdescribe)[[:space:]]*\(|@pytest\.mark\.skip|@unittest\.skip|#\[ignore\]'; then
  block "this edit adds a test-runner skip/only/ignore marker (it.skip/describe.only/xit/@pytest.mark.skip/…) to a test file — that silences the suite instead of fixing it (fail-closed contract)"
fi
# Type-error / assert silencing inside tests.
if printf '%s' "$added_lines" | grep -qE '@ts-ignore|@ts-expect-error|eslint-disable(-next-line)?\b|# type: ignore'; then
  block "this edit adds a suppression directive to a test file — silencing the checker fakes the done-condition"
fi

exit 0
