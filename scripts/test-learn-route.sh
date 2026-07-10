#!/bin/bash
# test-learn-route.sh — behavior contract for auto-learn's route-learnings.mjs (CI-run).
# The router is the fail-closed, DRY-RUN-FIRST gate between a verified learning and the shared,
# auto-loaded AGENTS.md context that both Codex and Claude Code read. A silent leak here poisons
# every future run, so we prove, mechanically:
#   1. default is a DRY RUN — a JSON patch manifest, ZERO writes;
#   2. --apply edits ONLY the stamped auto-learn block and preserves every other byte (and never
#      touches CLAUDE.md or Codex private memory);
#   3. the ≤5-survivor cap and duplicate-id evidence-merge;
#   4. every no-mutation refusal: unverified, missing evidence, secret, path traversal,
#      nonexistent scope, too-many-additions, and machine/environment defect.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
R="$ROOT/auto-learn/scripts/route-learnings.mjs"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fails=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; fails=$((fails+1)); }
# jq-free JSON assert via node
jassert() { node -e "$2" ; [ "$?" = "0" ] && pass "$1" || fail "$1"; }

# sha of a file (byte identity), empty string if absent
shaf() { [ -f "$1" ] && shasum -a 256 "$1" | awk '{print $1}' || echo "ABSENT"; }

# ── fresh project skeleton ─────────────────────────────────────────────────────────
P="$TMP/proj"; mkdir -p "$P/src/api"
# a hand-written AGENTS.md with content BEFORE and AFTER where our block will live
cat > "$P/AGENTS.md" <<'EOF'
# Agent guide (hand written — must survive byte-for-byte)

Follow the house rules.

## Footer kept verbatim
Do not clobber me.
EOF
# a sibling CLAUDE.md and a fake Codex private-memory file — must NEVER be touched
printf '# Claude memory (must not change)\n' > "$P/CLAUDE.md"
mkdir -p "$P/.codex"; printf 'private codex memory\n' > "$P/.codex/AGENTS.md.local"
CLAUDE_SHA0="$(shaf "$P/CLAUDE.md")"
CODEX_SHA0="$(shaf "$P/.codex/AGENTS.md.local")"

good_learning() {
cat <<'EOF'
{"learnings":[
  {"id":"L-fat-tasks","rule":"Split build tasks to one slice each","evidence":"run-x units.T4.note","verification":"adversarial-verify 3/3 on 2026-07-10","scope":"src/api"}
]}
EOF
}

# ── 1. DRY RUN is the default: manifest emitted, NOTHING written ─────────────────────
AGENTS_SHA0="$(shaf "$P/AGENTS.md")"
OUT="$(good_learning | node "$R" - --root "$P")"
RC=$?
[ "$RC" = "0" ] && pass "dry-run exits 0" || fail "dry-run exit ($RC)"
printf '%s' "$OUT" | node -e '
  const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
  if(d.mode!=="dry-run") throw new Error("mode="+d.mode);
  if(d.mutated!==false) throw new Error("mutated in dry run");
  if(d.survivors.length!==1) throw new Error("survivors "+d.survivors.length);
  if(!d.patches.length||!d.patches[0].after_sha) throw new Error("no patch manifest");
' && pass "dry-run emits a JSON patch manifest, mutated:false" || fail "dry-run manifest"
[ "$(shaf "$P/AGENTS.md")" = "$AGENTS_SHA0" ] && pass "dry-run wrote ZERO bytes to AGENTS.md" || fail "dry-run mutated AGENTS.md"

# ── 2. --apply edits only the stamped block; every other byte preserved ──────────────
PRE="$(sed -n '1,5p' "$P/AGENTS.md")"           # the human header/body region
good_learning | node "$R" - --root "$P" --apply >/dev/null
if grep -q 'BEGIN auto-learn:learnings' "$P/AGENTS.md" && grep -q 'END auto-learn:learnings' "$P/AGENTS.md"; then pass "--apply inserts a stamped block"; else fail "no stamped block after apply"; fi
grep -q 'L-fat-tasks' "$P/AGENTS.md" && pass "--apply writes the learning line" || fail "learning line missing"
# the hand-written header + footer bytes are intact
grep -q 'must survive byte-for-byte' "$P/AGENTS.md" && grep -q 'Do not clobber me.' "$P/AGENTS.md" && pass "--apply preserved human header + footer" || fail "human bytes lost"
# CLAUDE.md and Codex private memory are untouched
[ "$(shaf "$P/CLAUDE.md")" = "$CLAUDE_SHA0" ] && pass "CLAUDE.md never touched" || fail "CLAUDE.md changed"
[ "$(shaf "$P/.codex/AGENTS.md.local")" = "$CODEX_SHA0" ] && pass "Codex private memory never touched" || fail "codex memory changed"

# byte-preservation of NON-block content on a re-apply/update: capture everything outside the block,
# apply a DIFFERENT learning, and assert the outside bytes are identical.
python3 - "$P/AGENTS.md" > "$TMP/outside_before.txt" <<'PY'
import sys,re
t=open(sys.argv[1]).read()
sys.stdout.write(re.sub(r'<!-- BEGIN auto-learn:learnings.*?<!-- END auto-learn:learnings -->','<BLOCK>',t,flags=re.S))
PY
cat > "$TMP/second.json" <<'EOF'
{"learnings":[
  {"id":"L-slow-suite","rule":"Warm the DB before the perf suite","evidence":"run-y openItems","verification":"verified 2026-07-10","scope":"src/api"}
]}
EOF
node "$R" "$TMP/second.json" --root "$P" --apply >/dev/null
python3 - "$P/AGENTS.md" > "$TMP/outside_after.txt" <<'PY'
import sys,re
t=open(sys.argv[1]).read()
sys.stdout.write(re.sub(r'<!-- BEGIN auto-learn:learnings.*?<!-- END auto-learn:learnings -->','<BLOCK>',t,flags=re.S))
PY
diff -q "$TMP/outside_before.txt" "$TMP/outside_after.txt" >/dev/null && pass "re-apply preserved all bytes outside the block" || fail "bytes outside the block changed"
# prior learning survived the update (feed-forward accumulation), new one added
grep -q 'L-fat-tasks' "$P/AGENTS.md" && grep -q 'L-slow-suite' "$P/AGENTS.md" && pass "update merges into the block, keeps prior learning" || fail "update dropped a learning"

# ── 3a. duplicate ids merge evidence into ONE survivor ──────────────────────────────
cat > "$TMP/dup.json" <<'EOF'
{"learnings":[
  {"id":"L-dup","rule":"Rule text","evidence":"ev-A","verification":"verified 2026-07-10","scope":"."},
  {"id":"L-dup","rule":"Rule text","evidence":"ev-B","verification":"verified 2026-07-10","scope":"."}
]}
EOF
node "$R" "$TMP/dup.json" --root "$P" | node -e '
  const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
  if(d.survivors.length!==1) throw new Error("expected 1 merged survivor, got "+d.survivors.length);
  const ev=d.survivors[0].evidence;
  if(!(ev.includes("ev-A")&&ev.includes("ev-B"))) throw new Error("evidence not merged: "+JSON.stringify(ev));
' && pass "duplicate ids merge evidence into one survivor" || fail "dup-merge"

# ── 3b. the five-survivor cap → too_many_additions, NO mutation ─────────────────────
CAP_SHA0="$(shaf "$P/AGENTS.md")"
cat > "$TMP/six.json" <<'EOF'
{"learnings":[
  {"id":"A","rule":"r","evidence":"e","verification":"verified","scope":"."},
  {"id":"B","rule":"r","evidence":"e","verification":"verified","scope":"."},
  {"id":"C","rule":"r","evidence":"e","verification":"verified","scope":"."},
  {"id":"D","rule":"r","evidence":"e","verification":"verified","scope":"."},
  {"id":"E","rule":"r","evidence":"e","verification":"verified","scope":"."},
  {"id":"F","rule":"r","evidence":"e","verification":"verified","scope":"."}
]}
EOF
node "$R" "$TMP/six.json" --root "$P" --apply | node -e '
  const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
  if(d.refused!=="too_many_additions") throw new Error("refused="+d.refused);
  if(d.mutated!==false) throw new Error("mutated despite over-cap");
  if(d.patches.length!==0) throw new Error("patches emitted despite over-cap");
' && pass "6 distinct survivors → too_many_additions, no mutation" || fail "cap not enforced"
[ "$(shaf "$P/AGENTS.md")" = "$CAP_SHA0" ] && pass "over-cap --apply wrote ZERO bytes" || fail "over-cap mutated the file"
# exactly five is allowed
cat > "$TMP/five.json" <<'EOF'
{"learnings":[
  {"id":"A","rule":"r","evidence":"e","verification":"verified","scope":"."},
  {"id":"B","rule":"r","evidence":"e","verification":"verified","scope":"."},
  {"id":"C","rule":"r","evidence":"e","verification":"verified","scope":"."},
  {"id":"D","rule":"r","evidence":"e","verification":"verified","scope":"."},
  {"id":"E","rule":"r","evidence":"e","verification":"verified","scope":"."}
]}
EOF
node "$R" "$TMP/five.json" --root "$P" | node -e '
  const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
  if(d.refused!==null) throw new Error("five should not refuse");
  if(d.survivors.length!==5) throw new Error("survivors "+d.survivors.length);
' && pass "exactly five survivors is allowed" || fail "five wrongly refused"

# ── 4. every no-mutation refusal (each leaves AGENTS.md byte-identical under --apply) ─
REF_SHA0="$(shaf "$P/AGENTS.md")"
refuse_case() { # refuse_case <name> <reason> <json>
  local name=$1 reason=$2 json=$3
  printf '%s' "$json" > "$TMP/case.json"
  printf '%s' "$json" | node "$R" - --root "$P" --apply | node -e "
    const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
    const r=(d.rejected||[]).map(x=>x.reason);
    if(!r.includes('$reason')) throw new Error('reason \'$reason\' not in '+JSON.stringify(r));
    if(d.mutated!==false) throw new Error('mutated on refusal');
    if(d.survivors.length!==0) throw new Error('survivor slipped past refusal');
  " && pass "refusal: $name" || fail "refusal: $name"
  [ "$(shaf "$P/AGENTS.md")" = "$REF_SHA0" ] && pass "refusal $name wrote ZERO bytes" || fail "refusal $name mutated file"
}

refuse_case "missing evidence" "missing_field" \
  '{"learnings":[{"id":"X","rule":"r","verification":"verified","scope":"."}]}'
refuse_case "placeholder evidence" "missing_evidence" \
  '{"learnings":[{"id":"X","rule":"r","evidence":"none","verification":"verified","scope":"."}]}'
refuse_case "unverified" "unverified" \
  '{"learnings":[{"id":"X","rule":"r","evidence":"e","verification":"unverified","scope":"."}]}'
refuse_case "secret" "secret" \
  '{"learnings":[{"id":"X","rule":"use key AKIAIOSFODNN7EXAMPLE now","evidence":"e","verification":"verified","scope":"."}]}'
refuse_case "path traversal" "path_traversal" \
  '{"learnings":[{"id":"X","rule":"r","evidence":"e","verification":"verified","scope":"../../etc"}]}'
refuse_case "nonexistent scope" "nonexistent_scope" \
  '{"learnings":[{"id":"X","rule":"r","evidence":"e","verification":"verified","scope":"src/does-not-exist"}]}'
refuse_case "machine defect (explicit kind)" "machine_defect" \
  '{"learnings":[{"id":"X","rule":"r","evidence":"e","verification":"verified","scope":".","kind":"machine_defect"}]}'
refuse_case "machine defect (guard bug in rule)" "machine_defect" \
  '{"learnings":[{"id":"X","rule":"the guard bug swallowed our exit code","evidence":"e","verification":"verified","scope":"."}]}'

# ── usage / unreadable input → exit 2 (never a silent empty run) ────────────────────
node "$R" >/dev/null 2>&1; [ "$?" = "2" ] && pass "no input arg → exit 2" || fail "missing arg not refused"
node "$R" /nope/nope.json --root "$P" >/dev/null 2>&1; [ "$?" = "2" ] && pass "unreadable input → exit 2" || fail "unreadable not refused"
printf 'not json' | node "$R" - --root "$P" >/dev/null 2>&1; [ "$?" = "2" ] && pass "unparseable JSON → exit 2" || fail "bad JSON not refused"

echo ""
if [ "$fails" -gt 0 ]; then echo "✗ $fails route-learnings test(s) failed"; exit 1; fi
echo "✓ all route-learnings contract tests pass"
