#!/bin/bash
# test-codex-hooks.sh — dual Claude+Codex contract tests for the resume/honest-termination lifecycle hooks
# (hooks/session-start-announce.sh + hooks/honest-stop.sh). These hooks are wired from BOTH the Codex
# hooks/hooks.json (${CODEX_PLUGIN_ROOT}) and the Claude hooks/hooks.claude.json (${CLAUDE_PLUGIN_ROOT}).
#
# Proves, on the CODEX surface (no CLAUDE_PROJECT_DIR; payload arrives on stdin):
#   · session-start resolves the git root from the payload `cwd` (walking UP from a subdir),
#   · session-start archives TERMINAL runs into .ulpi/runs/archive (folding in checkpoint.mjs gc, since
#     Codex has no SessionEnd) but NEVER a running run,
#   · session-start announces the running run with the EXACT coordinator resume command,
#   · Stop emits a nonblocking notice by default via the documented Codex field {"systemMessage":…}
#     (NOT the Claude hookSpecificOutput key) and decision:block ONLY in strict mode using the real
#     Codex Stop-hook schema {"decision":"block","reason":…}.
# And that every fail-open case (malformed input, recursion, absent checkpoint/cwd/runs, stale run) exits
# clean with no output and never archives a running run — WITHOUT regressing the Claude surface.
# Zero-dep: POSIX bash + Node 22 + python3 only.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSA="$ROOT/hooks/session-start-announce.sh"
HS="$ROOT/hooks/honest-stop.sh"
fails=0
pass(){ echo "PASS $1"; }
fail(){ echo "FAIL $1"; fails=$((fails+1)); }
has(){ printf '%s' "$1" | grep -q -- "$2"; }
nohas(){ ! printf '%s' "$1" | grep -q -- "$2"; }

command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 unavailable"; exit 0; }
command -v node    >/dev/null 2>&1 || { echo "SKIP: node unavailable"; exit 0; }

# a Codex "repo": a git root (.git present) with a .ulpi/runs dir. Prints the repo path.
mkrepo(){ local r; r="$(mktemp -d)"; mkdir -p "$r/.git" "$r/.ulpi/runs"; printf '%s' "$r"; }
STALE4H="$(date -v-5H +%Y%m%d%H%M 2>/dev/null || date -d '5 hours ago' +%Y%m%d%H%M)"

echo "── session-start-announce: Codex surface (cwd→git-root, gc, resume command) ──"
REPO="$(mkrepo)"; mkdir -p "$REPO/sub/deep"
printf '{"id":"LIVE","status":"running","units":{"a":{"status":"done"},"b":{"status":"in_progress"}}}'  > "$REPO/.ulpi/runs/live.json"
printf '{"id":"DONE1","status":"done","units":{"a":{"status":"done"}}}'                                 > "$REPO/.ulpi/runs/done.json"
printf '{"id":"ABORT1","status":"aborted","units":{}}'                                                  > "$REPO/.ulpi/runs/abort.json"
# cwd points at a DEEP SUBDIR → proves upward git-root resolution finds .ulpi/runs at the root.
OUT="$(printf '{"cwd":"%s"}' "$REPO/sub/deep" | env -u CLAUDE_PROJECT_DIR CODEX_PLUGIN_ROOT="$ROOT" bash "$SSA" 2>/dev/null)"
[ -f "$REPO/.ulpi/runs/archive/done.json" ]  && pass "archives a terminal (done) run"    || fail "terminal done run not archived"
[ -f "$REPO/.ulpi/runs/archive/abort.json" ] && pass "archives a terminal (aborted) run" || fail "terminal aborted run not archived"
{ [ -f "$REPO/.ulpi/runs/live.json" ] && [ ! -f "$REPO/.ulpi/runs/archive/live.json" ]; } \
  && pass "NEVER archives a running run" || fail "running run was archived (must never happen)"
has "$OUT" "LIVE" && pass "announces the running run (git root resolved from a subdir cwd)" || fail "running run not announced :: $OUT"
has "$OUT" "node pipeline.mjs resume --run LIVE" && pass "emits the EXACT coordinator resume command" || fail "resume command missing :: $OUT"
rm -rf "$REPO"

echo "── session-start-announce: running-only repo never loses the live run to gc ──"
REPO="$(mkrepo)"
printf '{"id":"ONLYLIVE","status":"running","units":{}}' > "$REPO/.ulpi/runs/live.json"
OUT="$(printf '{"cwd":"%s"}' "$REPO" | env -u CLAUDE_PROJECT_DIR CODEX_PLUGIN_ROOT="$ROOT" bash "$SSA" 2>/dev/null)"
{ [ -f "$REPO/.ulpi/runs/live.json" ] && [ ! -f "$REPO/.ulpi/runs/archive/live.json" ]; } \
  && pass "running-only repo: live run stays put" || fail "running-only repo: live run moved"
has "$OUT" "node pipeline.mjs resume --run ONLYLIVE" && pass "running-only repo still announces resume command" || fail "resume command missing :: $OUT"
rm -rf "$REPO"

echo "── session-start-announce: Claude surface preserved (env root, no stdin, no session-start gc) ──"
CD="$(mktemp -d)"; mkdir -p "$CD/.ulpi/runs"
printf '{"id":"CLR","status":"running","units":{"a":{"status":"done"}}}' > "$CD/.ulpi/runs/r.json"
printf '{"id":"CLD","status":"done","units":{}}'                         > "$CD/.ulpi/runs/d.json"
OUT="$(CLAUDE_PROJECT_DIR="$CD" bash "$SSA" </dev/null 2>/dev/null)"
has "$OUT" "CLR" && pass "announces from CLAUDE_PROJECT_DIR" || fail "claude announce missing run :: $OUT"
has "$OUT" "node pipeline.mjs resume --run CLR" && pass "claude announce carries resume command" || fail "claude resume command missing :: $OUT"
{ [ -f "$CD/.ulpi/runs/d.json" ] && [ ! -d "$CD/.ulpi/runs/archive" ]; } \
  && pass "claude session-start does NOT archive (SessionEnd owns gc)" || fail "claude session-start archived a run"
rm -rf "$CD"

echo "── honest-stop: Codex Stop schema (systemMessage default / decision:block strict) ──"
REPO="$(mkrepo)"
printf '{"id":"R","status":"running","units":{"a":{"status":"blocked"},"b":{"status":"done"}}}' > "$REPO/.ulpi/runs/r.json"
OUT="$(printf '{"hook_event_name":"Stop","cwd":"%s"}' "$REPO" | env -u CLAUDE_PROJECT_DIR CODEX_PLUGIN_ROOT="$ROOT" bash "$HS" 2>/dev/null)"
has   "$OUT" '"systemMessage"'   && pass "Codex Stop nonblocking uses systemMessage (documented Codex field)" || fail "codex nonblocking missing systemMessage :: $OUT"
nohas "$OUT" 'hookSpecificOutput' && pass "Codex Stop nonblocking does NOT use the Claude hookSpecificOutput key" || fail "codex nonblocking leaked Claude key :: $OUT"
nohas "$OUT" '"decision"'         && pass "Codex Stop default does not block" || fail "codex default blocked :: $OUT"
OUT="$(printf '{"hook_event_name":"Stop","cwd":"%s"}' "$REPO" | env -u CLAUDE_PROJECT_DIR CODEX_PLUGIN_ROOT="$ROOT" ULPI_STOP_STRICT=1 bash "$HS" 2>/dev/null)"
has "$OUT" '"decision": "block"' && pass "Codex Stop strict emits real Codex block schema {decision:block}" || fail "codex strict not blocking :: $OUT"
has "$OUT" '"reason"'            && pass "Codex Stop strict block carries a reason" || fail "codex strict block missing reason :: $OUT"
rm -rf "$REPO"

echo "── honest-stop: Claude surface preserved (additionalContext default / decision:block strict) ──"
CD="$(mktemp -d)"; mkdir -p "$CD/.ulpi/runs"
printf '{"status":"running","units":{"a":{"status":"blocked"}}}' > "$CD/.ulpi/runs/r.json"
OUT="$(printf '{"hook_event_name":"Stop"}' | CLAUDE_PROJECT_DIR="$CD" bash "$HS" 2>/dev/null)"
has   "$OUT" 'additionalContext' && pass "Claude Stop nonblocking preserved (additionalContext)" || fail "claude nonblocking regressed :: $OUT"
nohas "$OUT" 'systemMessage'     && pass "Claude Stop nonblocking does not switch to the Codex field" || fail "claude nonblocking used codex field :: $OUT"
OUT="$(printf '{"hook_event_name":"Stop"}' | CLAUDE_PROJECT_DIR="$CD" ULPI_STOP_STRICT=1 bash "$HS" 2>/dev/null)"
has "$OUT" '"decision": "block"' && pass "Claude Stop strict block preserved" || fail "claude strict regressed :: $OUT"
rm -rf "$CD"

echo "── fail-open: honest-stop never blocks / never crashes on bad or edge input ──"
REPO="$(mkrepo)"
printf '{"id":"R","status":"running","units":{"a":{"status":"blocked"}}}' > "$REPO/.ulpi/runs/r.json"
OUT="$(printf 'not-json{' | env -u CLAUDE_PROJECT_DIR CODEX_PLUGIN_ROOT="$ROOT" ULPI_STOP_STRICT=1 bash "$HS" 2>/dev/null)"
[ -z "$OUT" ] && pass "malformed Stop input → fail open (no block)" || fail "malformed input produced output :: $OUT"
OUT="$(printf '{"hook_event_name":"Stop","stop_hook_active":true,"cwd":"%s"}' "$REPO" | env -u CLAUDE_PROJECT_DIR CODEX_PLUGIN_ROOT="$ROOT" ULPI_STOP_STRICT=1 bash "$HS" 2>/dev/null)"
[ -z "$OUT" ] && pass "stop_hook_active (recursion) → fail open" || fail "recursion not allowed through :: $OUT"
OUT="$(printf '{"hook_event_name":"Stop"}' | env -u CLAUDE_PROJECT_DIR CODEX_PLUGIN_ROOT="$ROOT" ULPI_STOP_STRICT=1 bash "$HS" 2>/dev/null)"
[ -z "$OUT" ] && pass "Codex Stop with no cwd → fail open (cannot locate runs)" || fail "no-cwd produced output :: $OUT"
touch -t "$STALE4H" "$REPO/.ulpi/runs/r.json"
OUT="$(printf '{"hook_event_name":"Stop","cwd":"%s"}' "$REPO" | env -u CLAUDE_PROJECT_DIR CODEX_PLUGIN_ROOT="$ROOT" ULPI_STOP_STRICT=1 bash "$HS" 2>/dev/null)"
[ -z "$OUT" ] && pass "stale >4h running run → fail open (abandoned)" || fail "stale run surfaced :: $OUT"
rm -rf "$REPO"
NR="$(mktemp -d)"; mkdir -p "$NR/.git"
OUT="$(printf '{"hook_event_name":"Stop","cwd":"%s"}' "$NR" | env -u CLAUDE_PROJECT_DIR CODEX_PLUGIN_ROOT="$ROOT" ULPI_STOP_STRICT=1 bash "$HS" 2>/dev/null)"
[ -z "$OUT" ] && pass "Codex Stop with absent runs dir → fail open" || fail "absent runs dir produced output :: $OUT"
rm -rf "$NR"

echo "── fail-open: session-start on malformed payload announces nothing and archives nothing ──"
REPO="$(mkrepo)"
printf '{"id":"D","status":"done","units":{}}' > "$REPO/.ulpi/runs/d.json"
OUT="$(printf 'garbage{' | env -u CLAUDE_PROJECT_DIR CODEX_PLUGIN_ROOT="$ROOT" bash "$SSA" 2>/dev/null)"
{ [ -z "$OUT" ] && [ ! -d "$REPO/.ulpi/runs/archive" ]; } \
  && pass "malformed session-start stdin → fail open (no announce, no archive)" || fail "malformed session-start acted :: $OUT"
rm -rf "$REPO"

echo ""
if [ "$fails" -gt 0 ]; then echo "✗ $fails codex-hook test(s) failed"; exit 1; fi
echo "✓ all codex-hook contract tests pass"
