#!/bin/bash
# test-plan-validate.sh — behavior contract for auto-plan's DAG gate (CI-run).
# Must PASS a structurally safe plan and CATCH: cycles, mis-ordered layers, intra-layer write
# overlap, >3-file tasks, phantom deps, dup ids, unlayered tasks, thin acceptance, the vitest
# `test -- <file>` footgun, and whole-suite e2e validates.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
V="$ROOT/auto-plan/scripts/validate-plan.mjs"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fails=0
want()  { local rc=$1 desc=$2 f=$3; node "$V" "$TMP/$f" >/dev/null 2>&1; local got=$?; [ "$got" = "$rc" ] && echo "PASS ($got) $desc" || { echo "FAIL (got $got want $rc) $desc"; fails=$((fails+1)); }; }
catch() { local desc=$1 pat=$2 f=$3; if node "$V" "$TMP/$f" 2>&1 | grep -q "$pat"; then echo "PASS (caught) $desc"; else echo "FAIL (not caught) $desc"; fails=$((fails+1)); fi; }

TMP="$TMP" python3 <<'PY'
import json, os, copy
TMP = os.environ['TMP']
def task(id, ws=None, dep=None, val=None, acc=None):
    return {"id": id, "title": id, "writeScope": ws or [f"src/{id}.ts"],
            "validate": val or f"pnpm exec vitest run src/{id}.test.ts",
            "acceptance": acc or ["does X", "rejects bad input"],
            **({"dependsOn": dep} if dep else {})}
def w(name, plan): json.dump(plan, open(f"{TMP}/{name}", "w"))

w("safe.json",     {"tasks": [task("T1"), task("T2", dep=["T1"])], "layers": [["T1"], ["T2"]]})
w("cycle.json",    {"tasks": [task("T1", dep=["T2"]), task("T2", dep=["T1"])], "layers": [["T1"], ["T2"]]})
w("misorder.json", {"tasks": [task("T1"), task("T2", dep=["T1"])], "layers": [["T2"], ["T1"]]})
w("samelayer.json",{"tasks": [task("T1"), task("T2", dep=["T1"])], "layers": [["T1", "T2"]]})
w("overlap.json",  {"tasks": [task("A", ws=["src/api"]), task("B", ws=["src/api/h.ts"])], "layers": [["A", "B"]]})
w("fat.json",      {"tasks": [task("A", ws=["1", "2", "3", "4"])], "layers": [["A"]]})
w("ghostdep.json", {"tasks": [task("T1", dep=["GHOST"])], "layers": [["T1"]]})
w("dup.json",      {"tasks": [task("T1"), task("T1")], "layers": [["T1"]]})
w("unlayered.json",{"tasks": [task("T1"), task("T2", dep=["T1"])], "layers": [["T1"]]})
w("thin.json",     {"tasks": [task("A", acc=["only one"])], "layers": [["A"]]})
w("footgun.json",  {"tasks": [task("A", val="pnpm --filter pkg test -- src/a.test.ts")], "layers": [["A"]]})
w("jestcanon.json",{"tasks": [task("A", val="npm test -- src/a.test.ts")], "layers": [["A"]]})
w("e2e.json",      {"tasks": [task("A", val="playwright test")], "layers": [["A"]]})
PY

want 0  "safe plan passes"                        safe.json
catch   "cycle"                    "cycle"        cycle.json
catch   "mis-ordered layer"        "missing base" misorder.json
catch   "same-layer dependency"    "missing base" samelayer.json
catch   "intra-layer overlap"      "would race"   overlap.json
catch   ">3 files"                 "split the task" fat.json
catch   "phantom dependsOn"        "does not exist" ghostdep.json
catch   "duplicate id"             "duplicate"    dup.json
catch   "unlayered task"           "never build"  unlayered.json
catch   "thin acceptance"          "acceptance criteria" thin.json
catch   "vitest -- footgun warned"  "footgun"      footgun.json
want 0  "footgun is a WARNING, not a build-blocker" footgun.json
want 0  "Jest-canonical 'npm test -- <file>' not blocked" jestcanon.json
catch   "whole-suite e2e validate" "end-state"    e2e.json
want 2  "unreadable plan exits 2"                 nope.json

echo ""
if [ "$fails" -gt 0 ]; then echo "✗ $fails plan-validate test(s) failed"; exit 1; fi
echo "✓ all plan-validate contract tests pass"
