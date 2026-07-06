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
want() { local rc=$1 desc=$2 f=$3; node "$V" "$f" >/dev/null 2>&1; local got=$?; [ "$got" = "$rc" ] && echo "PASS ($got) $desc" || { echo "FAIL (got $got want $rc) $desc"; fails=$((fails+1)); }; }
catch() { local desc=$1 pat=$2 f=$3; if node "$V" "$f" 2>&1 | grep -q "$pat"; then echo "PASS (caught) $desc"; else echo "FAIL (not caught) $desc"; fails=$((fails+1)); fi; }
mk() { python3 -c "import json,sys; json.dump(json.loads(sys.argv[1]), open('$TMP/p.json','w'))" "$1"; echo "$TMP/p.json"; }

T='{"id":"T1","title":"a","writeScope":["src/a.ts"],"validate":"pnpm exec vitest run src/a.test.ts","acceptance":["does X","rejects bad input"]}'
U='{"id":"T2","title":"b","writeScope":["src/b.ts"],"validate":"pnpm exec vitest run src/b.test.ts","acceptance":["does Y","errors on Z"],"dependsOn":["T1"]}'

want 0 "safe plan passes" "$(mk "{\"tasks\":[$T,$U],\"layers\":[[\"T1\"],[\"T2\"]]}")"
catch "cycle" "cycle" "$(mk "{\"tasks\":[$(echo $T | sed 's/}$/,\"dependsOn\":[\"T2\"]}/'),$U],\"layers\":[[\"T1\"],[\"T2\"]]}")"
catch "mis-ordered layer (dep after dependent)" "missing base" "$(mk "{\"tasks\":[$T,$U],\"layers\":[[\"T2\"],[\"T1\"]]}")"
catch "same-layer dependency" "missing base" "$(mk "{\"tasks\":[$T,$U],\"layers\":[[\"T1\",\"T2\"]]}")"
catch "intra-layer writeScope overlap" "would race" "$(mk '{"tasks":[{"id":"A","title":"a","writeScope":["src/api"],"validate":"x","acceptance":["a","b"]},{"id":"B","title":"b","writeScope":["src/api/h.ts"],"validate":"x","acceptance":["a","b"]}],"layers":[["A","B"]]}')"
catch ">3 files" "split the task" "$(mk '{"tasks":[{"id":"A","title":"a","writeScope":["1","2","3","4"],"validate":"x","acceptance":["a","b"]}],"layers":[["A"]]}')"
catch "phantom dependsOn" "does not exist" "$(mk "{\"tasks\":[$(echo $T | sed 's/}$/,\"dependsOn\":[\"GHOST\"]}/')],\"layers\":[[\"T1\"]]}")"
catch "duplicate id" "duplicate" "$(mk "{\"tasks\":[$T,$T],\"layers\":[[\"T1\"]]}")"
catch "unlayered task" "never build" "$(mk "{\"tasks\":[$T,$U],\"layers\":[[\"T1\"]]}")"
catch "thin acceptance" "acceptance criteria" "$(mk '{"tasks":[{"id":"A","title":"a","writeScope":["x"],"validate":"x","acceptance":["only one"]}],"layers":[["A"]]}')"
catch "vitest -- footgun" "footgun" "$(mk '{"tasks":[{"id":"A","title":"a","writeScope":["x"],"validate":"pnpm --filter pkg test -- src/a.test.ts","acceptance":["a","b"]}],"layers":[["A"]]}')"
catch "whole-suite e2e validate" "end-state" "$(mk '{"tasks":[{"id":"A","title":"a","writeScope":["x"],"validate":"playwright test","acceptance":["a","b"]}],"layers":[["A"]]}')"
want 2 "unreadable plan exits 2" "$TMP/nope.json"

echo ""
if [ "$fails" -gt 0 ]; then echo "✗ $fails plan-validate test(s) failed"; exit 1; fi
echo "✓ all plan-validate contract tests pass"
