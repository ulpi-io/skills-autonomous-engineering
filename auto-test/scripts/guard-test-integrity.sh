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
  parsed=$(printf '%s' "$raw" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
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
# Skip/only/todo — silences or narrows the suite.
if printf '%s' "$added_lines" | grep -qE '\.(only|skip)[[:space:]]*\(|(^|[^a-zA-Z_])(xit|xdescribe|xtest)[[:space:]]*\(|\.(todo)[[:space:]]*\(|@pytest\.mark\.skip|@unittest\.skip|#\[ignore\]'; then
  block "this edit adds a test skip/only/ignore marker to a test file — that silences the suite instead of fixing it (fail-closed contract)"
fi
# Type-error / assert silencing inside tests.
if printf '%s' "$added_lines" | grep -qE '@ts-ignore|@ts-expect-error|eslint-disable(-next-line)?\b|# type: ignore'; then
  block "this edit adds a suppression directive to a test file — silencing the checker fakes the done-condition"
fi

exit 0
