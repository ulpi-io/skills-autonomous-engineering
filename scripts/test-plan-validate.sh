#!/bin/bash
# test-plan-validate.sh — behavior contract for auto-plan's DAG gate (CI-run).
# Must PASS a structurally safe plan and CATCH: cycles, mis-ordered layers, intra-layer write
# overlap, >3-file tasks, phantom deps, dup ids, unlayered tasks, thin acceptance, the vitest
# `test -- <file>` footgun, and whole-suite e2e validates.
#
# EXECUTABLE plans (Codex-native, coordinator-run: ids reach `git worktree add -b task/<id>`,
# validateCommand is executed) get HARDENED checks — this suite also asserts: an unsafe/traversal
# task id, a missing required execution field, a cycle, a mis-layering, and an end-state-only
# (whole-suite) validate each FAIL with task-specific evidence; a valid executable plan (whose
# tasks carry only the provider-neutral `validateCommand`, no legacy `validate`) PASSES.
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

# executable task: provider-neutral `validateCommand` (no legacy `validate`) — a task carrying a
# nonempty validateCommand is what marks a plan EXECUTABLE (coordinator-run). `drop` removes a
# required execution field to exercise the missing-field gate.
def xtask(id, ws=None, dep=None, vc=None, acc=None, drop=None):
    t = {"id": id, "title": id,
         "writeScope": ws if ws is not None else [f"src/{id}.ts"],
         "acceptanceCriteria": acc or ["does X", "rejects bad input"],
         "validateCommand": vc if vc is not None else f"pnpm exec vitest run src/x-{id}.test.ts"}
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

want 2  "unreadable plan exits 2"                 nope.json

echo ""
if [ "$fails" -gt 0 ]; then echo "✗ $fails plan-validate test(s) failed"; exit 1; fi
echo "✓ all plan-validate contract tests pass"
