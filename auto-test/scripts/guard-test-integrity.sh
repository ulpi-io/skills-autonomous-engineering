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
# `touch .ulpi/allow-test-weaken` approves exactly ONE weakening edit: the guard consumes the flag.
if [ -f .ulpi/allow-test-weaken ]; then rm -f .ulpi/allow-test-weaken; exit 0; fi

if [ "${AUTO_GUARD_ALWAYS:-0}" != "1" ]; then
  # Live-run scoping with a STALENESS window: a real autonomous run touches its checkpoint constantly
  # (status writes), so only a running checkpoint modified in the last 4h arms the guard. A crashed
  # run from last week can never lock a user out of normal git usage (see also: checkpoint.mjs gc).
  live=""
  runs="${CLAUDE_PROJECT_DIR:-.}/.ulpi/runs"
  if [ -d "$runs" ]; then
    while IFS= read -r f; do
      grep -q '"status"[[:space:]]*:[[:space:]]*"running"' "$f" 2>/dev/null && { live=1; break; }
    done < <(find "$runs" -maxdepth 1 -name '*.json' -mmin -240 2>/dev/null)
  fi
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
else
  echo "guard-test-integrity: python3 not found — guard skipped (fail-open)" >&2
  exit 0
fi
[ -z "$added" ] && exit 0

# Only guard test files.
is_test=0
case "$fp" in
  *test*|*spec*|*__tests__*|*_test.*|*.test.*|*.spec.*) is_test=1 ;;
esac
[ "$is_test" = "0" ] && [ -n "$fp" ] && exit 0

block() { echo "guard-test-integrity: $1 (if this weakening is genuinely intended and user-approved: run 'touch .ulpi/allow-test-weaken' then retry the edit — the flag approves ONE edit and is consumed — and state the reason in your reply)" >&2; exit 2; }

# Skip/only/todo — silences or narrows the suite.
if printf '%s' "$added" | grep -qE '\.(only|skip)[[:space:]]*\(|(^|[^a-zA-Z_])(xit|xdescribe|xtest)[[:space:]]*\(|\.(todo)[[:space:]]*\(|@pytest\.mark\.skip|@unittest\.skip|#\[ignore\]'; then
  block "this edit adds a test skip/only/ignore marker to a test file — that silences the suite instead of fixing it (fail-closed contract)"
fi
# Type-error / assert silencing inside tests.
if printf '%s' "$added" | grep -qE '@ts-ignore|@ts-expect-error|eslint-disable(-next-line)?\b|# type: ignore'; then
  block "this edit adds a suppression directive to a test file — silencing the checker fakes the done-condition"
fi

exit 0
