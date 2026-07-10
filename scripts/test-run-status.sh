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

# --resume on a LEGACY Workflow launch keeps the read-only migration inspection green: it still echoes
# the persisted scriptPath and re-pins statusFile to THIS run, but must LABEL it migration-only /
# non-runnable (a Claude Workflow(), NEVER presented as a runnable Codex shell command).
RES="$(node "$RS" --resume demo --no-color)"
echo "$RES" | grep -q '"scriptPath": "/repo/autonomous-pipeline/references/pipeline-workflow.js"' ; ok $? "--resume emits persisted scriptPath"
echo "$RES" | python3 -c 'import sys,json,re; t=sys.stdin.read(); j=t[t.index("{"):]; d=json.loads(j); assert d["args"]["statusFile"].endswith("demo.json"), d'; ok $? "--resume injects statusFile back into args"
echo "$RES" | grep -qiE 'migration.only|not a runnable|non-runnable' ; ok $? "--resume labels a legacy Workflow launch migration-only"
echo "$RES" | grep -q 'node pipeline.mjs resume' && echo "FAIL legacy launch shown as runnable codex command" && fails=$((fails+1)) || echo "PASS legacy launch not shown as a runnable codex command"

# --resume --json on a legacy launch emits ONLY the typed descriptor (one JSON object), flagged non-runnable.
node "$RS" --resume demo --json | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["runnable"] is False and d.get("migrationOnly") is True and d["kind"]=="legacy-workflow", d'; ok $? "--resume --json legacy: single non-runnable descriptor"

# unknown id → exit 3
node "$RS" nope-nope >/dev/null 2>&1; [ "$?" = "3" ] && echo "PASS unknown id exits 3" || { echo "FAIL unknown id exit code"; fails=$((fails+1)); }

# READ-ONLY: the runs dir is byte-identical after all those reads
SNAP_AFTER="$(cd .ulpi/runs && for f in *.json; do printf '%s:%s\n' "$f" "$(cksum < "$f")"; done)"
[ "$SNAP_BEFORE" = "$SNAP_AFTER" ] && echo "PASS reader never wrote (runs dir byte-identical)" || { echo "FAIL reader mutated the runs dir"; fails=$((fails+1)); }

# empty project → graceful "no runs", exit 0
cd "$TMP" && mkdir -p empty && ( cd empty && node "$RS" --no-color >/dev/null 2>&1 ); ok $? "empty project: no runs, exit 0"

# REGRESSION (null-unit crash): a malformed run with a null unit value still parses as JSON — a
# read-only status tool must render it, never crash, and never blank sibling runs. Both render and --list.
cd "$TMP" && mkdir -p mal/.ulpi/runs
printf '%s' '{"schemaVersion":1,"id":"mal","task":"m","status":"running","units":{"a":{"status":"done"},"b":null}}' > mal/.ulpi/runs/mal.json
( cd mal && node "$RS" --no-color >/dev/null 2>&1 ); ok $? "render tolerates a null unit value (no crash)"
( cd mal && node "$RS" --list --no-color >/dev/null 2>&1 ); ok $? "--list tolerates a null unit value (no crash)"

# ── CODEX-NATIVE resume (its own project so the read-only snapshot above stays byte-clean) ────────────
# launch is the pipeline.mjs resume recipe → --resume emits the shell-safe `node pipeline.mjs resume
# --run <id>` (argv-safe, no interpolation); --resume --json emits ONLY the typed descriptor with argv.
cd "$TMP" && mkdir -p cdxproj && cd cdxproj
node "$CK" init .ulpi/runs/cdx.json --id cdx --task "codex run" --units "u1,u2" \
  --launch '{"scriptPath":"autonomous-pipeline/scripts/pipeline.mjs","args":{"command":"resume","run":"cdx"}}' >/dev/null
node "$CK" unit .ulpi/runs/cdx.json u1 done >/dev/null
CRES="$(node "$RS" --resume cdx --no-color)"
echo "$CRES" | grep -qF 'node pipeline.mjs resume --run cdx' ; ok $? "--resume codex run emits shell-safe coordinator command"
echo "$CRES" | grep -qF 'pipeline-workflow.js' && { echo "FAIL codex resume leaked a Workflow script"; fails=$((fails+1)); } || echo "PASS codex resume is a clean coordinator command"
node "$RS" --resume cdx --json | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["runnable"] is True and d["kind"]=="codex-cli" and d["run"]=="cdx" and d["command"]=="node" and d["argv"]==["pipeline.mjs","resume","--run","cdx"], d'; ok $? "--resume --json codex: typed descriptor with argv"
# codex-native --resume is byte-for-byte read-only too
CSNAP_B="$(cksum < .ulpi/runs/cdx.json)"; node "$RS" --resume cdx --no-color >/dev/null; node "$RS" --resume cdx --json >/dev/null
CSNAP_A="$(cksum < .ulpi/runs/cdx.json)"; [ "$CSNAP_B" = "$CSNAP_A" ] && echo "PASS codex --resume never wrote" || { echo "FAIL codex --resume mutated the run"; fails=$((fails+1)); }

# ── FULL COORDINATOR render: phases, integration branch, resolved+open findings, final validation ─────
cd "$TMP" && mkdir -p fullproj && cd fullproj
node "$CK" init .ulpi/runs/full.json --id full --task "full run" --units "t1" \
  --launch '{"scriptPath":"autonomous-pipeline/scripts/pipeline.mjs","args":{"command":"resume","run":"full"}}' >/dev/null
# stamp coordinator metadata (integration branch) under .pipeline the way `approve` does
python3 - <<'PY'
import json
f=".ulpi/runs/full.json"
d=json.load(open(f))
d["pipeline"]={"run":"full","integrationRef":"refs/heads/ulpi-int-full","targetRef":"refs/heads/main"}
json.dump(d,open(f,"w"),indent=2)
PY
node "$CK" phase .ulpi/runs/full.json build running >/dev/null
node "$CK" item .ulpi/runs/full.json --json '{"id":"F-KEEP","phase":"review","kind":"finding","why":"open finding stays"}' >/dev/null
node "$CK" item .ulpi/runs/full.json --json '{"id":"F-GONE","phase":"test","kind":"finding","why":"this one gets resolved"}' >/dev/null
node "$CK" resolve .ulpi/runs/full.json --ids F-GONE >/dev/null
node "$CK" validation .ulpi/runs/full.json green --note "all slices green" >/dev/null
FULL="$(node "$RS" full --no-color)"
echo "$FULL" | grep -qE 'ulpi-int-full' ; ok $? "render shows the integration branch"
echo "$FULL" | grep -qi 'resolved' ; ok $? "render shows resolved findings"
echo "$FULL" | grep -qiE 'validation.*green|green.*validation' ; ok $? "render shows final validation"
echo "$FULL" | grep -qF 'open finding stays' ; ok $? "render shows unresolved finding"

echo ""
if [ "$fails" -gt 0 ]; then echo "✗ $fails run-status test(s) failed"; exit 1; fi
echo "✓ all run-status contract tests pass"
