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

if [ "${AUTO_GUARD_ALWAYS:-0}" != "1" ]; then
  live=$(grep -l '"status"[[:space:]]*:[[:space:]]*"running"' .ulpi/runs/*.json 2>/dev/null | head -1)
  [ -z "$live" ] && exit 0
fi

raw=$(cat 2>/dev/null || true)
[ -z "$raw" ] && exit 0

# Pull file_path and the added text (new_string for Edit, content for Write).
# NB: the JSON travels via env, NOT via stdin — `python3 -` + heredoc would consume stdin for the script.
if command -v python3 >/dev/null 2>&1; then
  parsed=$(RAW="$raw" python3 -c '
import os, json
try:
    d = json.loads(os.environ.get("RAW", "{}"))
except Exception:
    d = {}
ti = d.get("tool_input", {})
print(ti.get("file_path", ""))
print((ti.get("new_string") or ti.get("content") or "").replace("\n", "\\n"))
' 2>/dev/null)
  fp=$(printf '%s\n' "$parsed" | sed -n 1p)
  added=$(printf '%s\n' "$parsed" | sed -n 2p)
elif command -v jq >/dev/null 2>&1; then
  fp=$(printf '%s' "$raw" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
  added=$(printf '%s' "$raw" | jq -r '(.tool_input.new_string // .tool_input.content // "")' 2>/dev/null)
else
  fp=""; added="$raw"
fi
[ -z "$added" ] && exit 0

# Only guard test files.
is_test=0
case "$fp" in
  *test*|*spec*|*__tests__*|*_test.*|*.test.*|*.spec.*) is_test=1 ;;
esac
[ "$is_test" = "0" ] && [ -n "$fp" ] && exit 0

block() { echo "guard-test-integrity: $1 (if this weakening is genuinely intended and user-approved, re-run with AUTO_TEST_ALLOW_WEAKEN=1 and explain why in the reply)" >&2; exit 2; }

# Skip/only/todo — silences or narrows the suite.
if printf '%s' "$added" | grep -qE '\.(only|skip)[[:space:]]*\(|(^|[^a-zA-Z_])(xit|xdescribe|xtest)[[:space:]]*\(|\.(todo)[[:space:]]*\(|@pytest\.mark\.skip|@unittest\.skip|#\[ignore\]'; then
  block "this edit adds a test skip/only/ignore marker to a test file — that silences the suite instead of fixing it (fail-closed contract)"
fi
# Type-error / assert silencing inside tests.
if printf '%s' "$added" | grep -qE '@ts-ignore|@ts-expect-error|eslint-disable(-next-line)?[^\\]*\\n|# type: ignore'; then
  block "this edit adds a suppression directive to a test file — silencing the checker fakes the done-condition"
fi

exit 0
