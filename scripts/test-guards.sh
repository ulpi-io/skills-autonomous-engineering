#!/bin/bash
# test-guards.sh — behavior contract tests for the enforcement guards (CI-run).
# Each guard must BLOCK its cardinal sin (exit 2), ALLOW normal work (exit 0), honor its
# escape hatch, and honor its scoping (skill-scoped always-on vs plugin-scoped live-run-only).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

fails=0
t() { # t <want-rc> <desc> <env...> -- <json> <script>
  local want=$1 desc=$2; shift 2
  local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  local json=$1 script=$2
  printf '%s' "$json" | env "${envs[@]:-_=_}" bash "$ROOT/$script" >/dev/null 2>&1
  local rc=$?
  if [ "$rc" = "$want" ]; then echo "PASS ($rc) $desc"; else echo "FAIL (got $rc want $want) $desc"; fails=$((fails+1)); fi
}

G=auto-build/scripts/guard-git-hygiene.sh
echo "── guard-git-hygiene (skill-scoped: AUTO_GUARD_ALWAYS=1) ──"
t 2 "git add -A blocked"           AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git add -A"}}' $G
t 2 "git add . blocked"            AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git add ."}}' $G
t 0 "explicit paths allowed"       AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git add src/a.ts src/b.ts"}}' $G
t 0 "git add ./src allowed"        AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git add ./src"}}' $G
t 2 "git stage -A blocked (add synonym)" AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git stage -A"}}' $G
t 2 "git add :/ whole-repo pathspec blocked" AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git add :/"}}' $G
t 2 "commit -am blocked"           AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git commit -am wip"}}' $G
t 0 "commit --amend allowed"       AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git commit --amend --no-edit"}}' $G
t 0 "commit -m with dash-a text"   AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git commit -m \"x-a thing\""}}' $G
t 2 "push --force blocked"         AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git push --force origin main"}}' $G
t 0 "force-with-lease allowed"     AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git push --force-with-lease"}}' $G
t 2 "REGRESSION lease+force bypass blocked" AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git push --force-with-lease --force origin main"}}' $G
t 2 "REGRESSION add -u blocked"    AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git add -u"}}' $G
t 2 "REGRESSION add * blocked"     AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git add *"}}' $G
t 0 "push -u set-upstream allowed (not force)" AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git push -u origin feat"}}' $G
t 2 "reset --hard blocked"         AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git reset --hard HEAD~1"}}' $G
t 2 "clean -fd blocked"            AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git clean -fd"}}' $G
t 0 "non-git command allowed"      AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"npm test"}}' $G
t 2 "env-prefixed git blocked"     AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"FOO=1 git add -A"}}' $G
t 2 "git -C dir add -A blocked (global opts)" AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git -C /repo add -A"}}' $G
t 2 "git -c k=v commit -am blocked" AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git -c user.name=x commit -am wip"}}' $G
t 0 "git -C dir add paths allowed"  AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git -C /repo add src/a.ts"}}' $G
t 0 "MULTILINE: add path then ls ." AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git add src/main.py\nls ."}}' $G
t 2 "MULTILINE: echo then add -A"    AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"echo \"starting\"\ngit add -A"}}' $G
t 2 "MULTILINE: ./run.sh then add -A" AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"./run.sh\ngit add -A"}}' $G
t 0 "QUOTED: separator+git in -m msg" AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git commit -m \"see; git add -A for details\""}}' $G
t 2 "REGRESSION git add ./ blocked (trailing slash)" AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git add ./"}}' $G
t 2 "REGRESSION bash -c wrapper add -A blocked" AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"bash -c \"git add -A\""}}' $G
t 2 "REGRESSION sh -c wrapper add -A blocked"   AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"sh -c \"git add -A\""}}' $G
t 0 "bash -c wrapper non-git allowed (no false +)" AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"bash -c \"npm test\""}}' $G
echo "── guard-git-hygiene (plugin-scoped: live-run gating) ──"
t 0 "no live run → allow"          AUTO_GUARD_ALWAYS=0 -- '{"tool_input":{"command":"git add -A"}}' $G
mkdir -p .ulpi/runs && echo '{"status": "running"}' > .ulpi/runs/x.json
t 2 "live run → block"             AUTO_GUARD_ALWAYS=0 -- '{"tool_input":{"command":"git add -A"}}' $G
touch -t 202601010000 .ulpi/runs/x.json   # same running checkpoint, 6 months stale
t 0 "STALE running run → allow (no permanent lockout)" AUTO_GUARD_ALWAYS=0 -- '{"tool_input":{"command":"git add -A"}}' $G
rm -rf .ulpi
# REGRESSION (phase-level "running" false-arm): a FINALIZED run (top-level status terminal) whose last
# PHASE is still "running" must NOT arm the guard — the old grep-anywhere kept guards armed for 4h post-run.
mkdir -p .ulpi/runs && printf '%s' '{"schemaVersion":1,"status":"needs_attention","phases":{"build":{"status":"running"}}}' > .ulpi/runs/x.json
t 0 "REGRESSION finalized run w/ phase running → allow" AUTO_GUARD_ALWAYS=0 -- '{"tool_input":{"command":"git reset --hard"}}' $G
# and a task DESCRIPTION containing the word "running" must not arm it either
printf '%s' '{"schemaVersion":1,"status":"done","task":"add a status running indicator"}' > .ulpi/runs/x.json
t 0 "REGRESSION task text 'running' + status done → allow" AUTO_GUARD_ALWAYS=0 -- '{"tool_input":{"command":"git reset --hard"}}' $G
rm -rf .ulpi

G=auto-test/scripts/guard-test-integrity.sh
echo "── guard-test-integrity ──"
t 2 ".only blocked in test file"   AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"file_path":"src/a.test.ts","new_string":"it.only(\"x\")"}}' $G
t 2 ".skip blocked"                AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"file_path":"tests/b.spec.js","new_string":"describe.skip(\"y\")"}}' $G
t 2 "xit blocked"                  AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"file_path":"__tests__/c.js","content":"xit(\"z\")"}}' $G
t 2 "xit at a line start blocked (multiline)" AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"file_path":"__tests__/c.js","content":"beforeEach(reset)\nxit(\"z\")"}}' $G
t 2 "@ts-ignore blocked"           AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"file_path":"a.test.ts","new_string":"// @ts-ignore"}}' $G
t 2 "pytest skip blocked"          AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"file_path":"test_x.py","new_string":"@pytest.mark.skip"}}' $G
t 2 "rust #[ignore] blocked"       AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"file_path":"src/lib_test.rs","new_string":"#[ignore]"}}' $G
t 0 "normal test edit allowed"     AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"file_path":"a.test.ts","new_string":"expect(add(1,2)).toBe(3)"}}' $G
t 0 "non-test file allowed"        AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"file_path":"src/utils.ts","new_string":"steps.skip(2)"}}' $G
t 0 "REGRESSION Stream.skip in test allowed" AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"file_path":"a.test.ts","new_string":"names.stream().skip(1).collect()"}}' $G
t 0 "REGRESSION cursor.skip in test allowed" AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"file_path":"api.spec.js","new_string":"coll.find({}).skip(10).limit(10)"}}' $G
t 0 "REGRESSION model.fit in test allowed"   AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"file_path":"ml.test.py","new_string":"model.fit(X, y)"}}' $G
t 2 "test.skip blocked (keyword-anchored)"   AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"file_path":"a.test.ts","new_string":"test.skip(\"x\", ()=>{})"}}' $G
t 0 "escape hatch honored"         AUTO_GUARD_ALWAYS=1 AUTO_TEST_ALLOW_WEAKEN=1 -- '{"tool_input":{"file_path":"a.test.ts","new_string":"it.only(\"x\")"}}' $G
mkdir -p .ulpi && touch .ulpi/allow-test-weaken
t 0 "file escape hatch (2-min window)" AUTO_GUARD_ALWAYS=1 CLAUDE_PROJECT_DIR=. -- '{"tool_input":{"file_path":"a.test.ts","new_string":"it.only(\"x\")"}}' $G
t 0 "window survives a second guard instance (dual registration)" AUTO_GUARD_ALWAYS=1 CLAUDE_PROJECT_DIR=. -- '{"tool_input":{"file_path":"a.test.ts","new_string":"it.only(\"x\")"}}' $G
touch -t 202601010000 .ulpi/allow-test-weaken
t 2 "expired flag blocks again"     AUTO_GUARD_ALWAYS=1 CLAUDE_PROJECT_DIR=. -- '{"tool_input":{"file_path":"a.test.ts","new_string":"it.only(\"x\")"}}' $G
[ ! -f .ulpi/allow-test-weaken ] && echo "PASS (expired flag lazily removed)" || { echo "FAIL expired flag not removed"; fails=$((fails+1)); }
rm -rf .ulpi
t 0 "no live run → allow"          AUTO_GUARD_ALWAYS=0 -- '{"tool_input":{"file_path":"a.test.ts","new_string":"it.only(\"x\")"}}' $G

echo "── guard-test-integrity (Codex apply_patch payloads) ──"
# ADDED weakening token in a TEST file → BLOCK, across Add / Update / Move sections.
t 2 "apply_patch Add test file + it.skip blocked" AUTO_GUARD_ALWAYS=1 -- '{"tool_name":"apply_patch","tool_input":{"input":"*** Begin Patch\n*** Add File: a.test.ts\n+it.skip(\"x\", ()=>{})\n*** End Patch"}}' $G
t 2 "apply_patch Update test file + describe.only blocked" AUTO_GUARD_ALWAYS=1 -- '{"tool_name":"apply_patch","tool_input":{"input":"*** Begin Patch\n*** Update File: tests/b.spec.js\n@@\n+describe.only(\"y\", ()=>{})\n*** End Patch"}}' $G
t 2 "apply_patch Add + xit blocked"               AUTO_GUARD_ALWAYS=1 -- '{"tool_name":"apply_patch","tool_input":{"input":"*** Begin Patch\n*** Add File: __tests__/c.js\n+xit(\"z\")\n*** End Patch"}}' $G
t 2 "apply_patch pytest skip in test file blocked" AUTO_GUARD_ALWAYS=1 -- '{"tool_name":"apply_patch","tool_input":{"input":"*** Begin Patch\n*** Add File: test_x.py\n+@pytest.mark.skip\n*** End Patch"}}' $G
t 2 "apply_patch @ts-ignore in test file blocked"  AUTO_GUARD_ALWAYS=1 -- '{"tool_name":"apply_patch","tool_input":{"input":"*** Begin Patch\n*** Update File: a.test.ts\n@@\n+// @ts-ignore\n*** End Patch"}}' $G
t 2 "apply_patch Move into test path + skip blocked" AUTO_GUARD_ALWAYS=1 -- '{"tool_name":"apply_patch","tool_input":{"input":"*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: a.test.ts\n@@\n+xdescribe(\"z\", ()=>{})\n*** End Patch"}}' $G
# ALLOWED: same token in a PRODUCTION file, on a DELETED line, or on a CONTEXT line.
t 0 "apply_patch it.skip added in PRODUCTION file allowed" AUTO_GUARD_ALWAYS=1 -- '{"tool_name":"apply_patch","tool_input":{"input":"*** Begin Patch\n*** Update File: src/prod.ts\n@@\n+it.skip(\"x\")\n*** End Patch"}}' $G
t 0 "apply_patch DELETED it.skip in test file allowed (un-skip)" AUTO_GUARD_ALWAYS=1 -- '{"tool_name":"apply_patch","tool_input":{"input":"*** Begin Patch\n*** Update File: a.test.ts\n@@\n-it.skip(\"x\")\n+it(\"x\", ()=>{})\n*** End Patch"}}' $G
t 0 "apply_patch CONTEXT it.skip in test file allowed" AUTO_GUARD_ALWAYS=1 -- '{"tool_name":"apply_patch","tool_input":{"input":"*** Begin Patch\n*** Update File: a.test.ts\n@@\n it.skip(\"x\")\n+expect(1).toBe(1)\n*** End Patch"}}' $G
t 0 "apply_patch normal test add allowed"          AUTO_GUARD_ALWAYS=1 -- '{"tool_name":"apply_patch","tool_input":{"input":"*** Begin Patch\n*** Add File: a.test.ts\n+expect(add(1,2)).toBe(3)\n*** End Patch"}}' $G
# MULTI-FILE: a weakening test edit must NOT hide behind a safe non-test edit in the same patch.
t 2 "apply_patch multi-file hides test .only behind prod edit → blocked" AUTO_GUARD_ALWAYS=1 -- '{"tool_name":"apply_patch","tool_input":{"input":"*** Begin Patch\n*** Update File: src/prod.ts\n@@\n+const x = 1\n*** Update File: a.test.ts\n@@\n+test.only(\"y\", ()=>{})\n*** End Patch"}}' $G
t 0 "apply_patch multi-file prod edit + normal test edit allowed" AUTO_GUARD_ALWAYS=1 -- '{"tool_name":"apply_patch","tool_input":{"input":"*** Begin Patch\n*** Update File: src/prod.ts\n@@\n+const x = 1\n*** Update File: a.test.ts\n@@\n+expect(x).toBe(1)\n*** End Patch"}}' $G
# Scoping: apply_patch weakening is only guarded on a live run (plugin-scoped) / always-on (skill-scoped).
t 0 "apply_patch weakening, no live run → allow"   AUTO_GUARD_ALWAYS=0 -- '{"tool_name":"apply_patch","tool_input":{"input":"*** Begin Patch\n*** Add File: a.test.ts\n+it.skip(\"x\")\n*** End Patch"}}' $G

G=auto-ship/scripts/guard-ship-irreversibles.sh
echo "── guard-ship-irreversibles ──"
t 2 "push --force blocked"         AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git push --force"}}' $G
t 2 "push -f blocked"              AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git push -f origin main"}}' $G
t 0 "force-with-lease allowed"     AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git push --force-with-lease"}}' $G
t 2 "REGRESSION lease+force bypass blocked" AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git push --force-with-lease --force"}}' $G
t 2 "push --delete blocked"        AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git push origin --delete old"}}' $G
t 2 "push +refspec force blocked"  AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git push origin +main"}}' $G
t 2 "push :refspec delete blocked" AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git push origin :old"}}' $G
t 2 "push --mirror blocked"        AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git push --mirror origin"}}' $G
t 0 "normal push allowed"          AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git push -u origin feat"}}' $G
t 0 "push branch:branch allowed"   AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git push origin feat:feat"}}' $G
t 0 "gh pr create allowed"         AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"gh pr create --title x"}}' $G
t 0 "MULTILINE: push then rm -f"    AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git push origin main\nrm -f tmp.txt"}}' $G
t 2 "MULTILINE: quoted line then force" AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"echo \"done\"\ngit push --force"}}' $G
t 2 "git -C dir push --force blocked" AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"git -C /repo push --force"}}' $G
t 2 "REGRESSION bash -c wrapper push --force blocked" AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"bash -c \"git push --force\""}}' $G
t 0 "bash -c wrapper normal push allowed (no false +)" AUTO_GUARD_ALWAYS=1 -- '{"tool_input":{"command":"bash -c \"git push origin feat\""}}' $G

echo "── large payloads (ARG_MAX regression: stdin piping, not env) ──"
G=auto-test/scripts/guard-test-integrity.sh
python3 -c "import json;print(json.dumps({'tool_input':{'file_path':'big.test.ts','content':'x'*2000000+'\nit.skip(\"a\")'}}))" > big.json
if AUTO_GUARD_ALWAYS=1 bash "$ROOT/$G" < big.json >/dev/null 2>&1; then echo "FAIL (got 0 want 2) 2MB payload with it.skip"; fails=$((fails+1)); else echo "PASS (2) 2MB payload with it.skip blocked"; fi
rm -f big.json

echo "── frontmatter resolvers find + exec the scripts (installed-skill layout) ──"
mkdir -p proj/.claude/skills
for s in auto-build auto-test auto-ship; do ln -sfn "$ROOT/$s" "proj/.claude/skills/$s"; done
resolver() { # resolver <skill> — extract the frontmatter hook command (indent-agnostic)
  python3 - "$ROOT/$1/SKILL.md" <<'PY'
import sys, re
text = open(sys.argv[1]).read()
fm = re.match(r'^---\n(.*?)\n---\n', text, re.S).group(1)
m = re.search(r'command: \|\n(( +).*\n(?:(?:\2.*)?\n?)*)', fm)
assert m, "no block-scalar hook command found"
indent = m.group(2)
out = re.sub(r'^' + indent, '', m.group(1), flags=re.M).strip()
assert out, "extracted hook command is EMPTY — extraction regression, tests would pass vacuously"
print(out)
PY
}
rt() { # rt <want> <desc> <skill> <json>
  local want=$1 desc=$2 skill=$3 json=$4
  local cmd; cmd=$(resolver "$skill")
  printf '%s' "$json" | env -u CLAUDE_PLUGIN_ROOT CLAUDE_PROJECT_DIR="$TMP/proj" HOME=/nonexistent bash -c "$cmd" >/dev/null 2>&1
  local rc=$?
  if [ "$rc" = "$want" ]; then echo "PASS ($rc) $desc"; else echo "FAIL (got $rc want $want) $desc"; fails=$((fails+1)); fi
}
rt 2 "auto-build resolver blocks add -A"   auto-build '{"tool_input":{"command":"git add -A"}}'
rt 0 "auto-build resolver allows paths"    auto-build '{"tool_input":{"command":"git add src/x.ts"}}'
rt 2 "auto-test resolver blocks .only"     auto-test  '{"tool_input":{"file_path":"a.test.ts","new_string":"it.only(1)"}}'
rt 2 "auto-ship resolver blocks force"     auto-ship  '{"tool_input":{"command":"git push --force"}}'
rm -rf proj
mkdir -p empty && cd empty
cmd=$(resolver auto-build)
printf '%s' '{"tool_input":{"command":"git add -A"}}' | env -u CLAUDE_PLUGIN_ROOT CLAUDE_PROJECT_DIR=/nonexistent HOME=/nonexistent bash -c "$cmd" >/dev/null 2>&1
rc=$?
if [ "$rc" = "0" ]; then echo "PASS (0) resolver fail-open when script absent"; else echo "FAIL (got $rc want 0) resolver fail-open"; fails=$((fails+1)); fi

echo "── honest-stop (Stop hook: fail-closed termination, safe by design) ──"
HS="$ROOT/hooks/honest-stop.sh"
OLD="$(date -v-30M +%Y%m%d%H%M 2>/dev/null || date -d '30 min ago' +%Y%m%d%H%M)"   # 30min ago: quiet but not stale
hs() { # hs <want-substr-or-EMPTY> <desc> <env...> -- <json> <mtime|"">
  local want=$1 desc=$2; shift 2; local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  local json=$1 mt=$2
  local d; d="$(mktemp -d)"; mkdir -p "$d/.ulpi/runs"
  echo '{"status":"running","units":{"a":{"status":"done"},"b":{"status":"blocked"}}}' > "$d/.ulpi/runs/r.json"
  [ -n "$mt" ] && touch -t "$mt" "$d/.ulpi/runs/r.json"
  local o; o="$(printf '%s' "$json" | env "${envs[@]:-_=_}" CLAUDE_PROJECT_DIR="$d" bash "$HS" 2>/dev/null)"
  rm -rf "$d"
  if [ "$want" = "EMPTY" ]; then
    [ -z "$o" ] && echo "PASS (no-op) $desc" || { echo "FAIL (expected no output) $desc :: $o"; fails=$((fails+1)); }
  else
    printf '%s' "$o" | grep -q "$want" && echo "PASS (emitted $want) $desc" || { echo "FAIL (missing '$want') $desc :: $o"; fails=$((fails+1)); }
  fi
}
hs additionalContext "running run → non-blocking reminder (default)" -- '{"hook_event_name":"Stop"}' "$OLD"
hs '"decision": "block"' "running run + STRICT → hard block" ULPI_STOP_STRICT=1 -- '{"hook_event_name":"Stop"}' "$OLD"
# REGRESSION: a FRESH running run is the MOST COMMON dishonest stop (wrote last unit, reported done,
# stopped without finalizing → fresh mtime). The old mtime floor let it slip; it must now be surfaced.
hs additionalContext "FRESH running run → surfaced (common dishonest-stop caught)" -- '{"hook_event_name":"Stop"}' ""
STALE4H="$(date -v-5H +%Y%m%d%H%M 2>/dev/null || date -d '5 hours ago' +%Y%m%d%H%M)"
hs EMPTY ">4h stale running run → no-op (abandoned; gc territory)" ULPI_STOP_STRICT=1 -- '{"hook_event_name":"Stop"}' "$STALE4H"
hs EMPTY "stop_hook_active → allow (loop guard)" ULPI_STOP_STRICT=1 -- '{"hook_event_name":"Stop","stop_hook_active":true}' "$OLD"
# no .ulpi/runs at all → immediate no-op
empt="$(mktemp -d)"; o="$(printf '%s' '{"hook_event_name":"Stop"}' | CLAUDE_PROJECT_DIR="$empt" ULPI_STOP_STRICT=1 bash "$HS" 2>/dev/null)"; rm -rf "$empt"
[ -z "$o" ] && echo "PASS (no-op) no .ulpi/runs → no-op" || { echo "FAIL no-op expected :: $o"; fails=$((fails+1)); }

echo "── session-end-gc (SessionEnd hook: archive terminal runs, never running) ──"
GD="$(mktemp -d)"; mkdir -p "$GD/.ulpi/runs"
echo '{"status":"done","units":{}}'    > "$GD/.ulpi/runs/old-done.json";   touch -t 202601010000 "$GD/.ulpi/runs/old-done.json"
echo '{"status":"running","units":{}}' > "$GD/.ulpi/runs/live.json"
CLAUDE_PLUGIN_ROOT="$ROOT" CLAUDE_PROJECT_DIR="$GD" bash "$ROOT/hooks/session-end-gc.sh" >/dev/null 2>&1
[ -f "$GD/.ulpi/runs/archive/old-done.json" ] && echo "PASS terminal run archived" || { echo "FAIL terminal run not archived"; fails=$((fails+1)); }
[ -f "$GD/.ulpi/runs/live.json" ] && echo "PASS running run left in place" || { echo "FAIL running run wrongly moved"; fails=$((fails+1)); }
rm -rf "$GD"

echo "── session-start-announce (SessionStart hook: running-first priority) ──"
SD="$(mktemp -d)"; mkdir -p "$SD/.ulpi/runs"
# REGRESSION: 3 FRESH needs_attention runs + 1 OLDER running run — the running run must still be
# announced (not crowded out of the top-3 by fresher needs_attention runs) per the header's promise.
for i in 1 2 3; do echo '{"id":"na'$i'","status":"needs_attention","units":{"x":{"status":"blocked"}}}' > "$SD/.ulpi/runs/na$i.json"; done
echo '{"id":"LIVERUN","status":"running","units":{"a":{"status":"done"},"b":{"status":"in_progress"}}}' > "$SD/.ulpi/runs/run.json"
touch -t "$OLD" "$SD/.ulpi/runs/run.json"   # running run is the OLDEST of the four
SOUT="$(CLAUDE_PROJECT_DIR="$SD" bash "$ROOT/hooks/session-start-announce.sh" 2>/dev/null)"
printf '%s' "$SOUT" | grep -q "LIVERUN" && echo "PASS running run survives the top-3 cap (running-first sort)" || { echo "FAIL running run crowded out :: $SOUT"; fails=$((fails+1)); }
rm -rf "$SD"

echo ""
if [ "$fails" -gt 0 ]; then echo "✗ $fails guard test(s) failed"; exit 1; fi
echo "✓ all guard behavior tests pass"
