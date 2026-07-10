#!/bin/bash
# test-watch-state.sh — behavior contract for watch-and-act's durable cross-turn watch state (CI-run).
# Proves the three acceptance guarantees of watch-state.mjs:
#   1. init REQUIRES an external target + absolute future deadline + poll cap + valid interval, and REFUSES
#      harness-tracked work (exit 2);
#   2. every real `observe` ATOMICALLY bumps the count + records evidence, and a terminal outcome
#      (success/failure/deadline/exhaustion) CANNOT silently restart (exit 2);
#   3. a FRESH process preserves the ORIGINAL bound (each observe reads the count/deadline from disk), and
#      with NO wake capability `next` returns a resumable PENDING report instead of blocking.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WS="$ROOT/watch-and-act/scripts/watch-state.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
fails=0

pass() { echo "PASS $1"; }
bad()  { echo "FAIL $1"; fails=$((fails+1)); }
# want <expected-rc> <desc> -- <argv...>
want() {
  local rc=$1 desc=$2; shift 3   # drop rc, desc, and the literal "--"
  node "$WS" "$@" >/dev/null 2>&1
  local got=$?
  [ "$got" = "$rc" ] && pass "($got) $desc" || bad "(got $got want $rc) $desc"
}
# grepj <desc> <pattern> -- <argv...>  (assert stdout of a SUCCEEDING call matches)
grepj() {
  local desc=$1 pat=$2; shift 3
  if node "$WS" "$@" 2>/dev/null | grep -q "$pat"; then pass "$desc"; else bad "$desc (pattern '$pat' absent)"; fi
}

FUTURE="2099-01-01T00:00:00Z"

# ══ Acceptance 1: init requirements + harness-tracked refusal ══
want 2 "init REFUSES harness-tracked work" -- init w.json --target "CI" --deadline "$FUTURE" --max-polls 5 --interval 120 --harness-tracked
want 1 "init requires --target" -- init w.json --deadline "$FUTURE" --max-polls 5 --interval 120
want 1 "init requires --deadline" -- init w.json --target "CI" --max-polls 5 --interval 120
want 1 "init rejects a relative (non-absolute) deadline" -- init w.json --target "CI" --deadline "+30m" --max-polls 5 --interval 120
want 1 "init rejects a past deadline" -- init w.json --target "CI" --deadline "2000-01-01T00:00:00Z" --max-polls 5 --interval 120
want 1 "init requires --max-polls" -- init w.json --target "CI" --deadline "$FUTURE" --interval 120
want 1 "init rejects a non-positive poll cap" -- init w.json --target "CI" --deadline "$FUTURE" --max-polls 0 --interval 120
want 1 "init requires --interval" -- init w.json --target "CI" --deadline "$FUTURE" --max-polls 5
want 1 "init rejects the ~300s cache dead-zone interval" -- init w.json --target "CI" --deadline "$FUTURE" --max-polls 5 --interval 300
want 1 "init rejects a mid-band (600s) dead-zone interval" -- init w.json --target "CI" --deadline "$FUTURE" --max-polls 5 --interval 600
want 0 "init accepts an in-cache interval (<=270s)" -- init ok-active.json --target "CI on feat-x" --deadline "$FUTURE" --max-polls 5 --interval 120
want 0 "init accepts a long idle interval (>=1200s)" -- init ok-idle.json --target "queue drain" --deadline "$FUTURE" --max-polls 5 --interval 1800
# no state file is created by a refused init
[ ! -f w.json ] && pass "a refused init writes no state file" || bad "a refused init leaked a state file"
grepj "init records status=watching + the bound on disk" '"status": "watching"' -- status ok-active.json
grepj "init persists the poll cap" '"maxPolls": 5' -- status ok-active.json

# ══ Acceptance 2: atomic observation + terminal-no-restart ══
node "$WS" init obs.json --target "deploy" --deadline "$FUTURE" --max-polls 5 --interval 120 >/dev/null 2>&1
grepj "observe bumps the count to 1" '"pollCount": 1' -- observe obs.json --state pending --evidence "queued"
grepj "observe records the evidence atomically" '"evidence": "queued"' -- status obs.json
grepj "second observe bumps the count to 2" '"pollCount": 2' -- observe obs.json --state pending --evidence "running"
# terminal success closes the watch...
grepj "a success observation is terminal" '"status": "success"' -- observe obs.json --state success --evidence "green"
# ...and CANNOT be silently restarted
want 2 "observe REFUSES to restart a terminal (success) watch" -- observe obs.json --state pending
grepj "the terminal watch stayed success (no silent restart)" '"status": "success"' -- status obs.json

# a failure observation is likewise terminal and frozen
node "$WS" init fail.json --target "healthcheck" --deadline "$FUTURE" --max-polls 5 --interval 120 >/dev/null 2>&1
node "$WS" observe fail.json --state failure --evidence "500s" >/dev/null 2>&1
want 2 "observe REFUSES to restart a terminal (failure) watch" -- observe fail.json --state pending

# ══ Acceptance 3a: a FRESH process preserves the ORIGINAL bound ══
# maxPolls=2: three SEPARATE node processes; the 3rd only reaches 'exhausted' if the count persisted on disk.
node "$WS" init cap.json --target "CI" --deadline "$FUTURE" --max-polls 2 --interval 120 >/dev/null 2>&1
grepj "fresh process #1: still watching under the cap" '"status": "watching"' -- observe cap.json --state pending
grepj "fresh process #2: cap reached -> exhausted" '"status": "exhausted"' -- observe cap.json --state pending
want 2 "fresh process #3: exhausted watch cannot restart" -- observe cap.json --state pending

# deadline bound is also read from disk: a deadline 2s out, then a pending observe AFTER it passes -> deadline
DL="$(node -e 'console.log(new Date(Date.now()+2000).toISOString().replace(/\.\d{3}Z$/,"Z"))')"
node "$WS" init dl.json --target "slow deploy" --deadline "$DL" --max-polls 50 --interval 120 >/dev/null 2>&1
sleep 3
grepj "a pending observe past the absolute deadline -> deadline (bound from disk)" '"status": "deadline"' -- observe dl.json --state pending
want 2 "the timed-out watch cannot restart" -- observe dl.json --state pending

# ══ Acceptance 3b: no wake capability -> resumable PENDING report, never blocks ══
node "$WS" init pend.json --target "CI on feat-x" --deadline "$FUTURE" --max-polls 5 --interval 120 >/dev/null 2>&1
node "$WS" observe pend.json --state pending --evidence "queued" >/dev/null 2>&1
# default (no --wake) == no wake capability: PENDING + resumable + resume-when-woken, and it RETURNS (exit 0).
want 0 "next with no wake capability returns (does not block)" -- next pend.json
grepj "no-wake next is a PENDING report" '"status": "pending"' -- next pend.json
grepj "no-wake next is marked resumable" '"resumable": true' -- next pend.json
grepj "no-wake next says resume-when-woken (not schedule)" '"action": "resume-when-woken"' -- next pend.json
grepj "no-wake next reports the durable statusFile" '"statusFile"' -- next pend.json
# a wake capability present -> schedule the next poll instead
grepj "next with a wake capability schedules the next poll" '"action": "schedule-next-poll"' -- next pend.json --wake schedule
grepj "next with native wake also schedules" '"action": "schedule-next-poll"' -- next pend.json --wake native
# next on a terminal watch reports the terminal outcome, not a poll
grepj "next on a terminal watch reports terminal:true" '"terminal": true' -- next obs.json --wake schedule
grepj "next on a success watch actions 'proceed'" '"action": "proceed"' -- next obs.json

# durability of init: cannot clobber/restart an EXISTING watch
want 2 "init REFUSES to clobber an existing (terminal) watch" -- init obs.json --target "deploy" --deadline "$FUTURE" --max-polls 5 --interval 120
want 2 "init REFUSES to clobber an existing (live) watch" -- init pend.json --target "CI" --deadline "$FUTURE" --max-polls 5 --interval 120

# read-only: status never mutates the file
CK_BEFORE="$(cksum < pend.json)"
node "$WS" status pend.json >/dev/null 2>&1
node "$WS" next pend.json >/dev/null 2>&1
CK_AFTER="$(cksum < pend.json)"
[ "$CK_BEFORE" = "$CK_AFTER" ] && pass "status/next are read-only (file byte-identical)" || bad "status/next mutated the state file"

echo ""
if [ "$fails" -gt 0 ]; then echo "✗ $fails watch-state test(s) failed"; exit 1; fi
echo "✓ all watch-state contract tests pass"
