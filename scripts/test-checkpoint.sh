#!/bin/bash
# test-checkpoint.sh — behavior contract tests for checkpoint.mjs (CI-run).
# The CLI must implement the checkpoint-resume contract INCLUDING the fail-closed refusals:
# never clobber a live run, never demote a done unit, never finalize done with open units.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CK="$ROOT/checkpoint-resume/scripts/checkpoint.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
F=.ulpi/runs/t.json
fails=0
ok()  { if [ "$1" = "0" ]; then echo "PASS $2"; else echo "FAIL (rc=$1) $2"; fails=$((fails+1)); fi; }
ref() { if [ "$1" = "2" ]; then echo "PASS (refused) $2"; else echo "FAIL (rc=$1, wanted refusal 2) $2"; fails=$((fails+1)); fi; }

node "$CK" init $F --task "ci test" --units "a,b,c" --id ci1 >/dev/null; ok $? "init with units"
node "$CK" unit $F b pending --deps a >/dev/null; ok $? "set deps b→a"
node "$CK" unit $F c pending --deps b >/dev/null; ok $? "set deps c→b"

R=$(node "$CK" resume $F)
echo "$R" | grep -q '"eligible": \[\s*"a"' || { echo "$R" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["eligible"]==["a"], d; assert d["dep_blocked"]=={"b":"a","c":"b"}, d' ; }
ok $? "resume computes eligible=[a], dep_blocked{b→a,c→b}"

node "$CK" unit $F a in_progress >/dev/null && node "$CK" unit $F a done --note landed >/dev/null; ok $? "a → done"
node "$CK" resume $F | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["skip"]==["a"] and d["eligible"]==["b"], d'; ok $? "resume skips done, unblocks b"

node "$CK" unit $F a pending >/dev/null 2>&1; ref $? "demoting a done unit"
node "$CK" init $F --task clobber >/dev/null 2>&1; ref $? "re-init over a live checkpoint"
node "$CK" finalize $F done >/dev/null 2>&1; ref $? "finalize done with open units"

node "$CK" phase $F build running >/dev/null; ok $? "phase set (build running)"
node "$CK" get $F --summary | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["done"]==1 and d["total"]==3 and d["currentPhase"]=="build", d'; ok $? "summary is accurate"

node "$CK" unit $F b done >/dev/null && node "$CK" unit $F c done >/dev/null
node "$CK" finalize $F done --result "all landed" >/dev/null; ok $? "finalize done when all units done"

# atomicity: concurrent unit patches must not lose writes
node "$CK" init .ulpi/runs/r2.json --task race --units "$(seq -s, 1 20)" --id race >/dev/null
for i in $(seq 1 20); do node "$CK" unit .ulpi/runs/r2.json "$i" done >/dev/null & done; wait
node "$CK" get .ulpi/runs/r2.json --summary | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["done"]==20, f"lost writes: {d}"'; ok $? "concurrent patches lose ZERO writes (mkdir lock)"

echo ""
if [ "$fails" -gt 0 ]; then echo "✗ $fails checkpoint test(s) failed"; exit 1; fi
echo "✓ all checkpoint contract tests pass"
