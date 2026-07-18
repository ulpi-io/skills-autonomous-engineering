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
echo "$R" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["eligible"]==["a"], d; assert d["dep_blocked"]=={"b":"a","c":"a"}, d'
ok $? "resume computes eligible=[a], dep_blocked points at CHAIN ROOT (b→a, c→a)"

node "$CK" unit $F a in_progress >/dev/null && node "$CK" unit $F a done --note landed >/dev/null; ok $? "a → done"
node "$CK" resume $F | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["skip"]==["a"] and d["eligible"]==["b"], d'; ok $? "resume skips done, unblocks b"

node "$CK" unit $F a pending >/dev/null 2>&1; ref $? "demoting a done unit"
node "$CK" init $F --task clobber >/dev/null 2>&1; ref $? "re-init over a live checkpoint"
node "$CK" finalize $F done >/dev/null 2>&1; ref $? "finalize done with open units"

node "$CK" phase $F build running >/dev/null; ok $? "phase set (build running)"
node "$CK" get $F --summary | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["done"]==1 and d["total"]==3 and d["currentPhase"]=="build", d'; ok $? "summary is accurate"

node "$CK" unit $F b done >/dev/null && node "$CK" unit $F c done >/dev/null
node "$CK" finalize $F done --result "all landed" >/dev/null; ok $? "finalize done when all units done"

# item: durable openItems appends (object and array forms)
node "$CK" item $F --json '{"phase":"test","issue":"gap"}' >/dev/null; ok $? "item appends object"
node "$CK" item $F --json '[{"phase":"review","issue":"a"},{"phase":"review","issue":"b"}]' >/dev/null; ok $? "item appends array"
node "$CK" get $F | python3 -c 'import sys,json; d=json.load(sys.stdin); assert len(d["openItems"])==3, d'; ok $? "openItems has 3"

# finalize done is fail-closed on MORE than open units: a BLOCKED phase or an OPEN finding also refuse.
FP=.ulpi/runs/fp.json
node "$CK" init $FP --task "finalize backstop: blocked phase" --units "x" --id fp1 >/dev/null
node "$CK" unit $FP x done >/dev/null
node "$CK" phase $FP review blocked >/dev/null
node "$CK" finalize $FP done >/dev/null 2>&1; ref $? "finalize done refused while a phase is blocked (all units done)"
node "$CK" phase $FP review done >/dev/null
node "$CK" finalize $FP done >/dev/null 2>&1; ok $? "finalize done ok once no phase is blocked"

FQ=.ulpi/runs/fq.json
node "$CK" init $FQ --task "finalize backstop: open finding" --units "x" --id fq1 >/dev/null
node "$CK" unit $FQ x done >/dev/null
node "$CK" item $FQ --json '{"phase":"review","issue":"unresolved"}' >/dev/null
node "$CK" finalize $FQ done >/dev/null 2>&1; ref $? "finalize done refused while openItems non-empty (all units done)"
node "$CK" finalize $FQ needs_attention >/dev/null; ok $? "finalize needs_attention allowed with open findings"

# gc: archives old TERMINAL runs, never running ones
node "$CK" init .ulpi/runs/old.json --task old --id old1 >/dev/null && node "$CK" finalize .ulpi/runs/old.json aborted >/dev/null
python3 -c 'import json; p=".ulpi/runs/old.json"; d=json.load(open(p)); d["updatedAt"]="2026-01-01T00:00:00Z"; json.dump(d,open(p,"w"))'
node "$CK" init .ulpi/runs/live.json --task live --id live1 >/dev/null
node "$CK" gc .ulpi/runs --keep-days 7 >/dev/null; ok $? "gc runs"
[ -f .ulpi/runs/archive/old.json ] && [ -f .ulpi/runs/live.json ] && echo "PASS gc archived old terminal, kept running" || { echo "FAIL gc selection"; fails=$((fails+1)); }

# atomicity: concurrent unit patches must not lose writes
node "$CK" init .ulpi/runs/r2.json --task race --units "$(seq -s, 1 20)" --id race >/dev/null
for i in $(seq 1 20); do node "$CK" unit .ulpi/runs/r2.json "$i" done >/dev/null & done; wait
node "$CK" get .ulpi/runs/r2.json --summary | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["done"]==20, f"lost writes: {d}"'; ok $? "concurrent patches lose ZERO writes (mkdir lock)"

# timestamps EVERYWHERE — units (created/updated/started/finished), phases, items, doc.finishedAt
TS=.ulpi/runs/ts.json
node "$CK" init $TS --task "ts" --units "x" --id ts1 --launch '{"scriptPath":"/abs/wf.js","args":{"root":"/r","approved":true}}' >/dev/null
node "$CK" unit $TS x in_progress >/dev/null
node "$CK" unit $TS x done >/dev/null
node "$CK" phase $TS build running >/dev/null && node "$CK" phase $TS build done >/dev/null
node "$CK" item $TS --json '{"phase":"review","issue":"z"}' >/dev/null
# an open finding means the honest terminal status is needs_attention (finalize done would now REFUSE);
# finishedAt is stamped on any terminal finalize, so the timestamp assertions below still hold.
node "$CK" finalize $TS needs_attention --result ok >/dev/null
node "$CK" get $TS | python3 -c '
import sys,json
d=json.load(sys.stdin)
u=d["units"]["x"]
for k in ("createdAt","updatedAt","startedAt","finishedAt"): assert u.get(k), f"unit missing {k}: {u}"
p=d["phases"]["build"]
for k in ("startedAt","updatedAt","finishedAt"): assert p.get(k), f"phase missing {k}: {p}"
assert d["openItems"][0].get("at"), "item missing at"
assert d.get("finishedAt"), "doc missing finishedAt"
assert d["launch"]["scriptPath"]=="/abs/wf.js", d.get("launch")
'; ok $? "timestamps present on units/phases/items/doc + launch persisted"

# --launch with invalid JSON is rejected (usage error, not silent)
node "$CK" init .ulpi/runs/bad.json --task bad --launch 'not json' >/dev/null 2>&1
[ "$?" = "1" ] && echo "PASS (rejected) invalid --launch JSON" || { echo "FAIL invalid --launch JSON not rejected"; fails=$((fails+1)); }

# REGRESSION (withLock stale-steal): a STALE leftover lock must not let two concurrent writers
# both enter the critical section and lose an update. Plant a >5s-stale lock, then fire 20 patches.
node "$CK" init .ulpi/runs/steal.json --task steal --units "$(seq -s, 1 20)" --id steal >/dev/null
mkdir -p .ulpi/runs/steal.json.lock
python3 -c 'import os,time; t=time.time()-3600; os.utime(".ulpi/runs/steal.json.lock",(t,t))'  # backdate to 1h stale
for i in $(seq 1 20); do node "$CK" unit .ulpi/runs/steal.json "$i" done >/dev/null 2>&1 & done; wait
node "$CK" get .ulpi/runs/steal.json --summary | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["done"]==20, f"stale-steal lost writes: {d}"'; ok $? "stale lock stolen atomically, ZERO lost writes (two-writer race fixed)"

# REGRESSION (init id guard): a unit id with whitespace must be refused at INIT, not silently
# created into a permanently un-updatable (never-finalizable) state.
node "$CK" init .ulpi/runs/ws.json --task ws --units "task a,b" --id ws >/dev/null 2>&1
[ "$?" = "1" ] && echo "PASS (rejected) init unit id with whitespace" || { echo "FAIL whitespace unit id not rejected at init"; fails=$((fails+1)); }

# ── v2 store: shared library is importable and CLI is a thin shim over it ──────────
LIB="$ROOT/checkpoint-resume/scripts/lib/checkpoint-store.mjs"
[ -f "$LIB" ] && echo "PASS store library exists (CLI + engine share one locked store)" || { echo "FAIL store library missing"; fails=$((fails+1)); }
# The engine can import and drive the SAME locked store the CLI uses (one implementation, not two).
node --input-type=module -e '
import * as s from "'"$LIB"'";
import { readFileSync, rmSync } from "node:fs";
const f = ".ulpi/runs/eng.json";
const id = s.init(f, { task: "engine", units: ["u1"], id: "eng1" });
if (id !== "eng1") throw new Error("init returned "+id);
s.unit(f, "u1", "done");
const r = s.resume(f);
if (JSON.stringify(r.skip) !== JSON.stringify(["u1"])) throw new Error("resume "+JSON.stringify(r));
s.finalize(f, "done", { result: "engine ok" });
const d = JSON.parse(readFileSync(f, "utf8"));
if (d.status !== "done" || d.schemaVersion !== 2) throw new Error("doc "+JSON.stringify(d));
rmSync(f);
'; ok $? "engine imports the store directly and drives init/unit/resume/finalize"

# ── typed launch-descriptor validation: an invalid descriptor refuses init, no checkpoint written ──
BADL=.ulpi/runs/badlaunch.json
node "$CK" init $BADL --task "bad launch shape" --launch '{"args":{}}' >/dev/null 2>&1; rc=$?
[ "$rc" != "0" ] && [ ! -f "$BADL" ] && echo "PASS (rejected) launch missing scriptPath — no checkpoint written" || { echo "FAIL invalid launch descriptor created a checkpoint (rc=$rc)"; fails=$((fails+1)); }
BADL2=.ulpi/runs/badlaunch2.json
node "$CK" init $BADL2 --task "bad launch type" --launch '["not","an","object"]' >/dev/null 2>&1; rc=$?
[ "$rc" != "0" ] && [ ! -f "$BADL2" ] && echo "PASS (rejected) launch is an array — no checkpoint written" || { echo "FAIL array launch descriptor created a checkpoint (rc=$rc)"; fails=$((fails+1)); }
# a well-typed descriptor still initializes fine and is persisted
GOODL=.ulpi/runs/goodlaunch.json
node "$CK" init $GOODL --task "typed launch" --units z --id gl1 --launch '{"scriptPath":"/abs/wf.js","args":{"root":"/r"}}' >/dev/null; ok $? "typed launch descriptor accepted"
node "$CK" get $GOODL | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["launch"]["scriptPath"]=="/abs/wf.js", d; assert d["schemaVersion"]==2, d'; ok $? "typed launch persisted at schemaVersion 2"

# ── idempotent finding upsert (stable ids) ──────────────────────────────────────────
UP=.ulpi/runs/upsert.json
node "$CK" init $UP --task "upsert" --units u --id up1 >/dev/null
node "$CK" item $UP --json '{"id":"F1","phase":"review","issue":"same"}' >/dev/null
node "$CK" item $UP --json '{"id":"F1","phase":"review","issue":"same"}' >/dev/null   # re-report → upsert, not a dup
node "$CK" get $UP | python3 -c 'import sys,json; d=json.load(sys.stdin); o=d["openItems"]; assert len(o)==1, o; assert o[0]["id"]=="F1", o'; ok $? "explicit-id finding upserts idempotently (no duplicate)"
# findings WITHOUT an explicit id get a STABLE content-derived id; re-reporting the same content dedupes
node "$CK" item $UP --json '{"phase":"test","issue":"gap"}' >/dev/null
node "$CK" item $UP --json '{"phase":"test","issue":"gap"}' >/dev/null   # identical content → same stable id
node "$CK" get $UP | python3 -c 'import sys,json; d=json.load(sys.stdin); o=d["openItems"]; assert len(o)==2, o; assert all(x.get("id") for x in o), o'; ok $? "content-hash finding is stable and dedupes (still 2 findings, all have stable ids)"

# ── resolve moves stable ids from openItems → durable resolvedItems, unblocking finalize done ──────
node "$CK" resolve $UP --ids "F1" >/dev/null; ok $? "resolve op runs"
node "$CK" get $UP | python3 -c 'import sys,json; d=json.load(sys.stdin); assert len(d["openItems"])==1, d["openItems"]; assert len(d["resolvedItems"])==1 and d["resolvedItems"][0]["id"]=="F1", d["resolvedItems"]; assert d["resolvedItems"][0].get("resolvedAt"), d'; ok $? "resolved finding moved to durable resolvedItems (stamped resolvedAt)"
node "$CK" resolve $UP --ids "F1" >/dev/null; node "$CK" get $UP | python3 -c 'import sys,json; d=json.load(sys.stdin); assert len(d["resolvedItems"])==1, d'; ok $? "resolve is idempotent (re-resolving a resolved id is a no-op)"
# resolve the remaining content-hash finding, then finalize done succeeds (no open findings left)
CID=$(node "$CK" get $UP | python3 -c 'import sys,json; print(json.load(sys.stdin)["openItems"][0]["id"])')
node "$CK" unit $UP u done >/dev/null
node "$CK" finalize $UP done >/dev/null 2>&1; ref $? "finalize done still refused while a finding is open"
node "$CK" resolve $UP --ids "$CID" >/dev/null
node "$CK" finalize $UP done >/dev/null; ok $? "finalize done succeeds once every finding is resolved"

# ── finalize done refuses incomplete REQUIRED phases (opt-in gate; inert for runs that don't declare it) ──
RP=.ulpi/runs/reqphase.json
node "$CK" init $RP --task "required phases" --units u --id rp1 --required-phases "build,test" >/dev/null
node "$CK" unit $RP u done >/dev/null
node "$CK" phase $RP build done >/dev/null
node "$CK" finalize $RP done >/dev/null 2>&1; ref $? "finalize done refused while a required phase (test) is not done"
node "$CK" phase $RP test done >/dev/null
node "$CK" finalize $RP done >/dev/null; ok $? "finalize done ok once all required phases are done"

# ── finalize done refuses absent/red FINAL validation (opt-in gate) ──────────────────
FV=.ulpi/runs/finalval.json
node "$CK" init $FV --task "final validation" --units u --id fv1 --require-validation >/dev/null
node "$CK" unit $FV u done >/dev/null
node "$CK" finalize $FV done >/dev/null 2>&1; ref $? "finalize done refused while final validation is ABSENT"
node "$CK" validation $FV red --note "suite red" >/dev/null
node "$CK" finalize $FV done >/dev/null 2>&1; ref $? "finalize done refused while final validation is RED"
node "$CK" validation $FV green >/dev/null
node "$CK" finalize $FV done >/dev/null; ok $? "finalize done ok once final validation is GREEN"

# ── canonical pipeline finalize refuses missing/uncovered binding scope ───────────────
node --input-type=module -e '
import * as s from "'"$LIB"'";
const f = ".ulpi/runs/scope-finalize.json";
s.init(f, { task: "scope finalize", units: ["u"], id: "scope-finalize" });
s.unit(f, "u", "done");
s.withLock(f, () => { const d=s.upgradeDoc(s.readDoc(f)); d.pipeline={}; s.writeDoc(f,d); });
let missing=false; try { s.finalize(f,"done"); } catch (e) { missing=/coverage receipt is absent/.test(e.message); }
if (!missing) throw new Error("missing scope receipt did not refuse");
s.withLock(f, () => { const d=s.upgradeDoc(s.readDoc(f)); d.pipeline.scopeCoverage={total:1,covered:[],dropped:[],uncovered:["SCOPE-001"],errors:[]}; s.writeDoc(f,d); });
let uncovered=false; try { s.finalize(f,"done"); } catch (e) { uncovered=/UNCOVERED: SCOPE-001/.test(e.message); }
if (!uncovered) throw new Error("uncovered scope did not refuse");
s.withLock(f, () => { const d=s.upgradeDoc(s.readDoc(f)); d.pipeline.scopeCoverage={total:2,covered:["SCOPE-001"],dropped:[],uncovered:[],errors:[]}; s.writeDoc(f,d); });
let tampered=false; try { s.finalize(f,"done"); } catch (e) { tampered=/accounts for 1 of 2/.test(e.message); }
if (!tampered) throw new Error("tampered scope receipt did not refuse");
s.withLock(f, () => { const d=s.upgradeDoc(s.readDoc(f)); d.pipeline.scopeCoverage={total:1,covered:["SCOPE-001"],dropped:[],uncovered:[],errors:[]}; s.writeDoc(f,d); });
s.finalize(f,"done");
'; ok $? "canonical finalize requires a valid, fully covered selected-scope receipt"

# ── schemaVersion:1 back-compat: v1 files load/resume/finalize UNCHANGED (add-only in-place upgrade) ──
V1=.ulpi/runs/legacy.json
python3 -c '
import json
d={"schemaVersion":1,"id":"legacy","task":"legacy run","status":"running",
   "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z",
   "phases":{},"units":{"a":{"status":"done","dependsOn":[],"note":"","createdAt":"2026-01-01T00:00:00Z"},
                        "b":{"status":"pending","dependsOn":["a"],"note":"","createdAt":"2026-01-01T00:00:00Z"}},
   "openItems":[],"result":None}
json.dump(d, open(".ulpi/runs/legacy.json","w"), indent=2)
'
# resume is READ-ONLY: same skip/eligible output AND the file is not mutated (still schemaVersion 1)
node "$CK" resume $V1 | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["skip"]==["a"] and d["eligible"]==["b"], d'; ok $? "v1 resume output unchanged"
python3 -c 'import json; assert json.load(open(".ulpi/runs/legacy.json"))["schemaVersion"]==1, "resume mutated the v1 file"'; ok $? "v1 resume did NOT mutate the file (still schemaVersion 1)"
# a mutating write performs the idempotent in-place upgrade WITHOUT touching existing data
node "$CK" unit $V1 b done >/dev/null; ok $? "v1 file accepts a mutation"
node "$CK" get $V1 | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["schemaVersion"]==2, d; assert d["resolvedItems"]==[], d; assert d["units"]["a"]["status"]=="done", d; assert d["units"]["a"]["note"]=="", d'; ok $? "v1 upgraded to v2 add-only (resolvedItems added, existing units preserved)"
node "$CK" finalize $V1 done --result "legacy landed" >/dev/null; ok $? "v1 run finalizes done unchanged after upgrade"

# ── store-write failure PROPAGATES (an unwritable runs dir is not swallowed into a false success) ──
mkdir -p .ulpi/runs/wd
node "$CK" init .ulpi/runs/wd/w.json --task wd --units x --id wd1 >/dev/null
node "$CK" unit .ulpi/runs/wd/w.json x done >/dev/null
chmod 555 .ulpi/runs/wd
node "$CK" finalize .ulpi/runs/wd/w.json needs_attention >/dev/null 2>&1; rc=$?
chmod 755 .ulpi/runs/wd
[ "$rc" != "0" ] && echo "PASS store-write failure (unwritable runs dir) propagates as non-zero exit" || { echo "FAIL unwritable-dir write silently succeeded"; fails=$((fails+1)); }

echo ""
if [ "$fails" -gt 0 ]; then echo "✗ $fails checkpoint test(s) failed"; exit 1; fi
echo "✓ all checkpoint contract tests pass"
