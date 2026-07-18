#!/bin/bash
# test-plan-validate.sh — behavior contract for auto-plan's DAG gate (CI-run).
# Must PASS a structurally safe plan and CATCH: cycles, mis-ordered layers, intra-layer write
# overlap, >3-file tasks, phantom deps, dup ids, unlayered tasks, thin acceptance, the vitest
# `test -- <file>` footgun, and whole-suite e2e validates.
#
# EXECUTABLE plans (Codex-native, coordinator-run: ids reach `git worktree add -b task/<id>`,
# validateCommand is executed) get HARDENED checks — including independent intake fidelity and binding
# selected-scope coverage. This suite
# also asserts: an unsafe/traversal
# task id, a missing required execution field, a cycle, a mis-layering, and an end-state-only
# (whole-suite) validate each FAIL with task-specific evidence; a valid executable plan (whose
# tasks carry only the provider-neutral `validateCommand`, no legacy `validate`) PASSES.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
V="$ROOT/auto-plan/scripts/validate-plan.mjs"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fails=0
runv() {
  local f=$1; shift
  local args=("$TMP/$f")
  [ -f "$TMP/$f.intake.json" ] && args+=(--intake "$TMP/$f.intake.json")
  node "$V" "${args[@]}" "$@"
}
want()  { local rc=$1 desc=$2 f=$3; runv "$f" >/dev/null 2>&1; local got=$?; [ "$got" = "$rc" ] && echo "PASS ($got) $desc" || { echo "FAIL (got $got want $rc) $desc"; fails=$((fails+1)); }; }
catch() {
  local desc=$1 pat=$2 f=$3 out got
  out="$(runv "$f" 2>&1)"; got=$?
  if [ "$got" = 1 ] && grep -q "$pat" <<<"$out"; then
    echo "PASS (caught exit 1) $desc"
  else
    echo "FAIL (got exit $got; message pattern '$pat') $desc"; fails=$((fails+1))
  fi
}
warn() {
  local desc=$1 pat=$2 f=$3 out got
  out="$(runv "$f" 2>&1)"; got=$?
  if [ "$got" = 0 ] && grep -q "$pat" <<<"$out"; then
    echo "PASS (warned exit 0) $desc"
  else
    echo "FAIL (got exit $got; warning pattern '$pat') $desc"; fails=$((fails+1))
  fi
}

TMP="$TMP" python3 <<'PY'
import hashlib, json, os, copy
TMP = os.environ['TMP']
def task(id, ws=None, dep=None, val=None, acc=None):
    return {"id": id, "title": id, "writeScope": ws or [f"src/{id}.ts"],
            "validate": val or f"pnpm exec vitest run src/{id}.test.ts",
            "acceptance": acc or ["does X", "rejects bad input"],
            **({"dependsOn": dep} if dep else {})}
def w(name, plan): json.dump(plan, open(f"{TMP}/{name}", "w"))

# executable task: provider-neutral `validateCommand` (no legacy `validate`) — a task carrying a
# nonempty validateCommand is what marks a plan EXECUTABLE (coordinator-run). `drop` removes a
# required execution field to exercise the missing-field gate.
def xtask(id, ws=None, dep=None, vc=None, acc=None, drop=None, scopes=None):
    t = {"id": id, "title": id,
         "writeScope": ws if ws is not None else [f"src/{id}.ts"],
         "acceptanceCriteria": acc or ["does X", "rejects bad input"],
         "validateCommand": vc if vc is not None else f"pnpm exec vitest run src/x-{id}.test.ts",
         "scopeItems": scopes if scopes is not None else ["SCOPE-001"]}
    if dep: t["dependsOn"] = dep
    for k in (drop or []): t.pop(k, None)
    return t

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

# ── EXECUTABLE-plan hardening fixtures ────────────────────────────────────────────────
# valid executable plan — detected via validateCommand alone (no `executable` flag, no legacy
# `validate`); safe TASK-<n> ids, disjoint scopes, slice-scoped validateCommand → must PASS.
w("xsafe.json",    {"tasks": [xtask("TASK-001"), xtask("TASK-002", dep=["TASK-001"])],
                    "layers": [["TASK-001"], ["TASK-002"]]})
# safe charset accepts [A-Za-z0-9_-] starting alphanumeric → must PASS.
w("xchars.json",   {"tasks": [xtask("TASK-12_ab-CD")], "layers": [["TASK-12_ab-CD"]]})
# real-plan-shaped compound validateCommand (references slice files) is NOT end-state → must PASS.
w("xslice.json",   {"tasks": [xtask("TASK-001", vc="node scripts/validate-skills.mjs && bash scripts/test-x.sh")],
                    "layers": [["TASK-001"]]})
# path-traversal id would poison `git worktree add -b task/<id>` → must FAIL (unsafe id).
w("xtraversal.json",{"executable": True, "tasks": [xtask("../../etc/passwd")], "layers": [["../../etc/passwd"]]})
# shell-metachar / git-flag-injection id → must FAIL (unsafe id).
w("xmeta.json",    {"executable": True, "tasks": [xtask("T; rm -rf /")], "layers": [["T; rm -rf /"]]})
# leading-hyphen id (looks like a git flag) → must FAIL (unsafe id).
w("xflag.json",    {"executable": True, "tasks": [xtask("-rf")], "layers": [["-rf"]]})
# executable task missing a required execution field (writeScope) → must FAIL.
w("xmissing.json", {"tasks": [xtask("TASK-001"), xtask("TASK-002", dep=["TASK-001"], drop=["writeScope"])],
                    "layers": [["TASK-001"], ["TASK-002"]]})
# executable task with no slice command at all (no validateCommand, no validate) → must FAIL.
w("xnocmd.json",   {"executable": True, "tasks": [xtask("TASK-001"), xtask("TASK-002", drop=["validateCommand"])],
                    "layers": [["TASK-001", "TASK-002"]]})
# executable cycle / mis-layering — DAG checks still bite in executable context → must FAIL.
w("xcycle.json",   {"executable": True, "tasks": [xtask("TASK-001", dep=["TASK-002"]), xtask("TASK-002", dep=["TASK-001"])],
                    "layers": [["TASK-001"], ["TASK-002"]]})
w("xmislayer.json",{"executable": True, "tasks": [xtask("TASK-001"), xtask("TASK-002", dep=["TASK-001"])],
                    "layers": [["TASK-002"], ["TASK-001"]]})
# end-state-only (whole-suite) validateCommand for a task → must FAIL.
w("xendstate.json",{"tasks": [xtask("TASK-001", vc="pnpm -w test")], "layers": [["TASK-001"]]})

# Every executable fixture above gets a binding intake scope. This keeps each negative fixture focused on
# its named defect instead of also failing the new scope gate.
SCOPE = {"id": "SCOPE-001", "title": "selected feature", "source": "user selected Full MVP"}
for name in ["xsafe.json", "xchars.json", "xslice.json", "xtraversal.json", "xmeta.json", "xflag.json",
             "xmissing.json", "xnocmd.json", "xcycle.json", "xmislayer.json", "xendstate.json"]:
    path = f"{TMP}/{name}"
    plan = json.load(open(path))
    plan["selectedScope"] = [SCOPE]
    plan["scopeDrops"] = []
    w(name, plan)

# Binding-scope contract fixtures.
w("xscope-missing.json", {"tasks": [xtask("TASK-001")], "layers": [["TASK-001"]]})
w("xscope-uncovered.json", {"selectedScope": [SCOPE, {"id": "SCOPE-002", "title": "second", "source": "user"}],
                            "scopeDrops": [], "tasks": [xtask("TASK-001")], "layers": [["TASK-001"]]})
w("xscope-unknown.json", {"selectedScope": [SCOPE], "scopeDrops": [],
                          "tasks": [xtask("TASK-001", scopes=["SCOPE-GHOST"])], "layers": [["TASK-001"]]})
w("xscope-task-missing.json", {"selectedScope": [SCOPE], "scopeDrops": [],
    "tasks": [xtask("TASK-001", drop=["scopeItems"])], "layers": [["TASK-001"]]})
w("xscope-drop-unack.json", {"selectedScope": [SCOPE],
    "scopeDrops": [{"scopeId": "SCOPE-001", "reason": "too large"}],
    "tasks": [xtask("TASK-001", scopes=[])], "layers": [["TASK-001"]]})
VALID_DROP = {"scopeId": "SCOPE-001", "reason": "user removed it",
              "acknowledgedByUser": True, "acknowledgement": "Drop SCOPE-001"}
w("xscope-drop-valid.json", {"selectedScope": [SCOPE], "scopeDrops": [VALID_DROP],
    "tasks": [xtask("TASK-001", scopes=[])], "layers": [["TASK-001"]]})
w("xscope-conflict.json", {"selectedScope": [SCOPE], "scopeDrops": [VALID_DROP],
    "tasks": [xtask("TASK-001")], "layers": [["TASK-001"]]})
w("xscope-duplicate.json", {"selectedScope": [SCOPE, dict(SCOPE)], "scopeDrops": [],
    "tasks": [xtask("TASK-001")], "layers": [["TASK-001"]]})
w("xscope-drop-unknown.json", {"selectedScope": [SCOPE],
    "scopeDrops": [{"scopeId": "SCOPE-GHOST", "reason": "not selected",
                    "acknowledgedByUser": True, "acknowledgement": "Drop ghost"}],
    "tasks": [xtask("TASK-001")], "layers": [["TASK-001"]]})
w("xscope-shrunk.json", {"selectedScope": [SCOPE], "scopeDrops": [],
    "tasks": [xtask("TASK-001")], "layers": [["TASK-001"]]})
w("xscope-changed.json", {"selectedScope": [{**SCOPE, "title": "rewritten by plan"}], "scopeDrops": [],
    "tasks": [xtask("TASK-001")], "layers": [["TASK-001"]]})
w("xscope-expanded.json", {"selectedScope": [SCOPE, {"id": "SCOPE-002", "title": "plan-only", "source": "plan"}],
    "scopeDrops": [], "tasks": [xtask("TASK-001", scopes=["SCOPE-001", "SCOPE-002"])], "layers": [["TASK-001"]]})
w("xscope-no-intake.json", {"selectedScope": [SCOPE], "scopeDrops": [],
    "tasks": [xtask("TASK-001")], "layers": [["TASK-001"]]})

# The executable validator consumes the independent, canonical Phase-0 snapshot. Generate one per
# fixture so each negative remains focused. xscope-shrunk deliberately anchors TWO intake ids while its
# plan declares one; xscope-no-intake deliberately gets no artifact.
def canonical(v):
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
def snapshot(name, scope):
    payload = {"schemaVersion": 1, "run": "validator-test", "selection": "Full MVP test bundle",
               "selectedScope": scope}
    snap = dict(payload)
    snap["scopeSha256"] = hashlib.sha256(canonical(payload).encode()).hexdigest()
    path = f"{TMP}/{name}.intake.json"
    with open(path, "w") as f:
        json.dump(snap, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.chmod(path, 0o400)

for name in os.listdir(TMP):
    if not name.startswith("x") or not name.endswith(".json") or name == "xscope-no-intake.json":
        continue
    plan = json.load(open(f"{TMP}/{name}"))
    scope = plan.get("selectedScope")
    if not isinstance(scope, list) or not scope:
        scope = [SCOPE]
    if name == "xscope-duplicate.json":
        scope = [SCOPE]
    if name == "xscope-shrunk.json":
        scope = [SCOPE, {"id": "SCOPE-002", "title": "must survive planning", "source": "user"}]
    if name in ["xscope-changed.json", "xscope-expanded.json"]:
        scope = [SCOPE]
    snapshot(name, scope)
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
warn    "vitest -- footgun warned"  "footgun"      footgun.json
want 0  "footgun is a WARNING, not a build-blocker" footgun.json
want 0  "Jest-canonical 'npm test -- <file>' not blocked" jestcanon.json
catch   "whole-suite e2e validate" "end-state"    e2e.json

# ── EXECUTABLE-plan hardening ──────────────────────────────────────────────────────────
want 0  "valid executable plan passes (validateCommand-only, no legacy validate)" xsafe.json
want 0  "safe id charset [A-Za-z0-9_-] accepted"          xchars.json
want 0  "compound validateCommand referencing slice files is not end-state" xslice.json
catch   "traversal id blocked from worktree/branch"  "unsafe task id"  xtraversal.json
want 1  "traversal id fails (exit 1)"                     xtraversal.json
catch   "shell-metachar id blocked"                  "unsafe task id"  xmeta.json
catch   "leading-hyphen (git-flag) id blocked"       "unsafe task id"  xflag.json
catch   "missing required execution field caught"    "execution field" xmissing.json
catch   "executable task with no slice command caught" "execution field" xnocmd.json
catch   "executable cycle caught"                    "cycle"           xcycle.json
catch   "executable mis-layering caught"             "missing base"    xmislayer.json
catch   "end-state-only validateCommand caught"      "end-state"       xendstate.json
want 1  "end-state-only validateCommand fails (exit 1)"   xendstate.json

# ── BINDING selected-scope coverage ───────────────────────────────────────────────────
catch   "missing intake scope authority"       "missing nonempty selectedScope" xscope-missing.json
catch   "selected item with no task is UNCOVERED" "UNCOVERED"                   xscope-uncovered.json
catch   "task mapping to unknown scope id"      "unknown selectedScope"          xscope-unknown.json
catch   "every executable task declares scopeItems" "missing scopeItems"          xscope-task-missing.json
catch   "drop needs per-id user acknowledgement" "explicit per-id"               xscope-drop-unack.json
want 0  "explicit per-id acknowledged drop passes"                              xscope-drop-valid.json
catch   "scope id cannot be mapped and dropped" "both task-mapped and dropped"   xscope-conflict.json
catch   "duplicate selectedScope id is rejected" "duplicate selectedScope id"     xscope-duplicate.json
catch   "scope drop cannot reference an unknown intake id" "scopeDrops references unknown" xscope-drop-unknown.json
catch   "plan cannot delete an id from captured intake" "missing from plan.selectedScope" xscope-shrunk.json
catch   "plan cannot rewrite captured title/source" "changed intake title/source" xscope-changed.json
catch   "plan cannot add uncaptured selected scope" "absent from the captured intake" xscope-expanded.json
catch   "executable plan requires independent intake snapshot" "missing --intake" xscope-no-intake.json
if runv "xsafe.json" --render 2>/dev/null | grep -q "SCOPE COVERAGE: 1 of 1"; then
  echo "PASS (render) scope coverage block"
else
  echo "FAIL (render) scope coverage block"; fails=$((fails+1))
fi
if runv "xsafe.json" --json 2>/dev/null | grep -q '"scopeCoverage"'; then
  echo "PASS (json) scope coverage object"
else
  echo "FAIL (json) scope coverage object"; fails=$((fails+1))
fi

want 2  "unreadable plan exits 2"                 nope.json

echo ""
if [ "$fails" -gt 0 ]; then echo "✗ $fails plan-validate test(s) failed"; exit 1; fi
echo "✓ all plan-validate contract tests pass"
