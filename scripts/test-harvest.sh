#!/bin/bash
# test-harvest.sh — behavior contract test for auto-learn's harvest-run.mjs (CI-run).
# The harvester must faithfully extract EVERY learning-signal class from a checkpoint (blocked/
# dep_blocked units, gate failures, delegation degradations, thrash notes, open findings, aborted
# runs) — the self-improvement loop learns from exactly the failures these represent, so a silent
# miss means the loop stops learning from real defects.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
H="$ROOT/auto-learn/scripts/harvest-run.mjs"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT; cd "$TMP"
fails=0
ok() { if [ "$1" = "0" ]; then echo "PASS $2"; else echo "FAIL (rc=$1) $2"; fails=$((fails+1)); fi; }

# a checkpoint exercising every signal class
cat > ck.json <<'JSON'
{ "schemaVersion":1, "id":"run-x", "status":"needs_attention",
  "units": {
    "T1": { "status":"done" },
    "T2": { "status":"blocked", "note":"review blocked after fix loop" },
    "T3": { "status":"dep_blocked", "note":"blocked on dependency T2" },
    "T4": { "status":"blocked", "note":"3 attempts exhausted, still red" }
  },
  "openItems": [
    { "phase":"test", "kind":"gate", "why":"suite not green" },
    { "phase":"review", "kind":"delegation_degraded", "why":"review delegated to codex but none available — ran native" },
    { "phase":"performance", "issue":"p95 still above target" }
  ] }
JSON

OUT=$(node "$H" ck.json --json)
echo "$OUT" | python3 -c '
import sys, json
d = json.load(sys.stdin)
b = d["bySignal"]
assert b.get("blocked_unit",0) >= 1, d          # T2, T4
assert b.get("dep_blocked_unit",0) == 1, d      # T3
assert b.get("thrash_signal",0) >= 1, d         # T4 (and T2 "fix loop")
assert b.get("gate_failure",0) == 1, d          # test gate
assert b.get("degradation",0) == 1, d           # codex degrade
assert b.get("open_finding",0) == 1, d          # perf issue
assert d["candidates"] >= 6, d
# every candidate cites the artifact field it came from (evidence is load-bearing)
assert all(c.get("evidence") for c in d["items"]), d
'; ok $? "extracts every signal class with evidence citations"

# aborted run is captured
printf '%s' '{"id":"a","status":"aborted","result":"preflight failed","units":{}}' > ab.json
node "$H" ab.json --json | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["bySignal"].get("aborted_run")==1, d'; ok $? "captures an aborted run"

# a clean run yields zero candidates (and exit 0 — clean teaches by staying clean)
printf '%s' '{"id":"clean","status":"done","units":{"T1":{"status":"done"}},"openItems":[]}' > clean.json
node "$H" clean.json --json | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["candidates"]==0, d'; ok $? "clean run → zero candidates"

# unreadable checkpoint → exit 2 (not a silent empty harvest)
node "$H" /nonexistent/nope.json >/dev/null 2>&1; [ "$?" = "2" ] && echo "PASS (2) unreadable checkpoint refused" || { echo "FAIL unreadable not refused"; fails=$((fails+1)); }

echo ""
if [ "$fails" -gt 0 ]; then echo "✗ $fails harvest test(s) failed"; exit 1; fi
echo "✓ all harvest contract tests pass"
