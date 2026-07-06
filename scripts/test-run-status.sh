#!/bin/bash
# test-run-status.sh — behavior contract tests for run-status.mjs (CI-run).
# The reader must be READ-ONLY, discover .ulpi/runs by walking up, render/list/json/resume correctly,
# reconstruct a resume recipe from the persisted launch, and exit 3 on an unknown id.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CK="$ROOT/checkpoint-resume/scripts/checkpoint.mjs"
RS="$ROOT/checkpoint-resume/scripts/run-status.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
fails=0
ok()  { if [ "$1" = "0" ]; then echo "PASS $2"; else echo "FAIL (rc=$1) $2"; fails=$((fails+1)); fi; }

# a project with two runs; run from a SUBDIR to prove upward .ulpi/runs discovery.
# Build the OLDER run first (finalized), then sleep, then the live `demo` so demo is genuinely newest.
mkdir -p proj/src/deep && cd proj
node "$CK" init .ulpi/runs/older.json --id older --task "old run" --units "x" >/dev/null
node "$CK" unit .ulpi/runs/older.json x done >/dev/null
node "$CK" finalize .ulpi/runs/older.json done --result "shipped" >/dev/null 2>&1 || true
sleep 1
F=.ulpi/runs/demo.json
node "$CK" init "$F" --id demo --task "add oauth" --units "a,b,c" \
  --launch '{"scriptPath":"/repo/autonomous-pipeline/references/pipeline-workflow.js","args":{"root":"/repo","workingBranch":"feat","approved":true}}' >/dev/null
node "$CK" unit "$F" a done >/dev/null
node "$CK" unit "$F" b in_progress >/dev/null
node "$CK" unit "$F" c blocked --note "needs decision" >/dev/null
node "$CK" phase "$F" build running >/dev/null
node "$CK" item "$F" --json '{"phase":"review","kind":"finding","why":"missing null check"}' >/dev/null

# snapshot the runs dir to prove the reader NEVER writes
SNAP_BEFORE="$(cd .ulpi/runs && for f in *.json; do printf '%s:%s\n' "$f" "$(cksum < "$f")"; done)"

# default render finds the NEWEST run (demo, updated after older), from a deep subdir
OUT="$(cd src/deep && node "$RS" --no-color)"
echo "$OUT" | grep -q "demo" && echo "$OUT" | grep -q "1/3" ; ok $? "default render: newest run, progress 1/3, from a subdir"
echo "$OUT" | grep -q "needs decision" ; ok $? "render shows blocked unit note"

# --list shows both, newest first. NB: only inspect DATA ROWS (they end in " ago") — the header line
# echoes the runs-dir path, and macOS mktemp's /var/folders/… literally contains the substring "older".
LIST="$(node "$RS" --list --no-color | grep ' ago')"
echo "$LIST" | grep -q "demo" && echo "$LIST" | grep -q "older" ; ok $? "--list shows both runs"
ORDER="$(echo "$LIST" | grep -oE 'demo|older' | head -2 | tr '\n' ' ')"
[ "$ORDER" = "demo older " ] ; ok $? "--list is newest-first (demo before older)"

# --json emits the raw doc
node "$RS" --json demo | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["id"]=="demo" and len(d["units"])==3, d'; ok $? "--json emits the durable doc"

# prefix match works
node "$RS" --json dem | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["id"]=="demo", d'; ok $? "id prefix match"

# --resume reconstructs the recipe from persisted launch, forcing statusFile back to this run
RES="$(node "$RS" --resume demo --no-color)"
echo "$RES" | grep -q '"scriptPath": "/repo/autonomous-pipeline/references/pipeline-workflow.js"' ; ok $? "--resume emits persisted scriptPath"
echo "$RES" | python3 -c 'import sys,json,re; t=sys.stdin.read(); j=t[t.index("{"):]; d=json.loads(j); assert d["args"]["statusFile"].endswith("demo.json"), d'; ok $? "--resume injects statusFile back into args"

# unknown id → exit 3
node "$RS" nope-nope >/dev/null 2>&1; [ "$?" = "3" ] && echo "PASS unknown id exits 3" || { echo "FAIL unknown id exit code"; fails=$((fails+1)); }

# READ-ONLY: the runs dir is byte-identical after all those reads
SNAP_AFTER="$(cd .ulpi/runs && for f in *.json; do printf '%s:%s\n' "$f" "$(cksum < "$f")"; done)"
[ "$SNAP_BEFORE" = "$SNAP_AFTER" ] && echo "PASS reader never wrote (runs dir byte-identical)" || { echo "FAIL reader mutated the runs dir"; fails=$((fails+1)); }

# empty project → graceful "no runs", exit 0
cd "$TMP" && mkdir -p empty && ( cd empty && node "$RS" --no-color >/dev/null 2>&1 ); ok $? "empty project: no runs, exit 0"

echo ""
if [ "$fails" -gt 0 ]; then echo "✗ $fails run-status test(s) failed"; exit 1; fi
echo "✓ all run-status contract tests pass"
