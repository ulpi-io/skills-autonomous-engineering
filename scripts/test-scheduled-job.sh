#!/bin/bash
# test-scheduled-job.sh — behavior contract for schedule-recurring-agent's recurring-job gate
# (validate-job.mjs). Proves four load-bearing guarantees:
#
#   1. SCHEMA-REQUIRED-FIELDS — a job MUST declare key, repo, timezone cadence, self-contained prompt,
#      dedup, per-run cap, reporting, escalation, teardown. Dropping any → exit 2 with the field named.
#   2. DEDUP-FIRST — create lists/deduplicates against the registry BEFORE any capability check; a job
#      whose key already exists is an idempotent no-op (created:false, reason:duplicate) and never
#      stacks a second registration — even with a supported capability + authorization.
#   3. CREATED:FALSE-WITHOUT-CAPABILITY — a valid job with no supported capability (e.g. Codex) or no
#      authorization returns created:false / nonzero and a ready brief.
#   4. NO-FALSE-REGISTRATION-CLAIM — the no-capability path emits registered:false, mints NO automation
#      id, and never claims a RemoteTrigger/CronCreate registration; a supported+authorized create mints
#      a VERIFIABLE id persisted to the registry.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
V="$ROOT/schedule-recurring-agent/scripts/validate-job.mjs"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fails=0

# exit-code assertion
want()  { local rc=$1 desc=$2; shift 2; node "$V" "$@" >/dev/null 2>&1; local got=$?; \
  [ "$got" = "$rc" ] && echo "PASS ($got) $desc" || { echo "FAIL (got $got want $rc) $desc"; fails=$((fails+1)); }; }
# combined stdout+stderr must MATCH pattern
catch() { local desc=$1 pat=$2; shift 2; if node "$V" "$@" 2>&1 | grep -qi "$pat"; then echo "PASS (caught) $desc"; \
  else echo "FAIL (not caught) $desc"; fails=$((fails+1)); fi; }
# combined stdout+stderr must NOT match pattern
absent(){ local desc=$1 pat=$2; shift 2; if node "$V" "$@" 2>&1 | grep -qi "$pat"; then \
  echo "FAIL (present) $desc"; fails=$((fails+1)); else echo "PASS (absent) $desc"; fi; }

if [ ! -f "$V" ]; then echo "FAIL: validate-job.mjs not found at $V"; exit 1; fi

TMP="$TMP" python3 <<'PY'
import json, os, copy
TMP = os.environ['TMP']

def w(name, obj): json.dump(obj, open(f"{TMP}/{name}", "w"))

VALID = {
    "key": "issue-triage",
    "repo": "acme/app",
    "cadence": {"timezone": "Europe/London", "cron": "0 9 * * 1-5"},
    "prompt": "Triage every issue opened in acme/app since the last run: apply a type label and a "
              "priority, skip any issue already carrying both. Done when each new issue is labeled.",
    "dedup": {"marker": "labeled:type+priority", "sinceQuery": "opened since last run"},
    "perRunCap": {"maxItems": 25},
    "reporting": {"channel": "#eng-triage", "always": "report even when nothing to do"},
    "escalation": "stop-and-ask on any security-labeled or ambiguous issue; never close/merge",
    "teardown": "disable after 5 consecutive empty runs or when the triage backlog project is archived",
}
w("valid.json", VALID)

# a per-field drop for the missing-field checks
REQUIRED = ["key", "repo", "cadence", "prompt", "dedup", "perRunCap", "reporting", "escalation", "teardown"]
for f in REQUIRED:
    j = copy.deepcopy(VALID); j.pop(f, None); w(f"missing_{f}.json", j)

# cadence present but WITHOUT a timezone → still invalid (timezone-anchored cadence required)
j = copy.deepcopy(VALID); j["cadence"] = {"cron": "0 9 * * 1-5"}; w("notz.json", j)
# cadence present but no cron/expression → invalid
j = copy.deepcopy(VALID); j["cadence"] = {"timezone": "UTC"}; w("nocron.json", j)
# perRunCap present but UNBOUNDED (zero) → invalid
j = copy.deepcopy(VALID); j["perRunCap"] = {"maxItems": 0}; w("nocap.json", j)
# unsafe / non-stable key → invalid
j = copy.deepcopy(VALID); j["key"] = "../etc/passwd"; w("badkey.json", j)
# thin (not self-contained) prompt → invalid
j = copy.deepcopy(VALID); j["prompt"] = "triage"; w("thinprompt.json", j)

# registry pre-seeded with the SAME key (for dedup-first tests)
w("registry_dupe.json", [{"key": "issue-triage", "id": "RemoteTrigger:issue-triage", "capability": "RemoteTrigger"}])
# empty registry array
w("registry_empty.json", [])
PY

echo "── 1. schema requires every field ─────────────────────────────────────────"
want 0 "valid job schema passes"                          validate "$TMP/valid.json"
for f in key repo cadence prompt dedup perRunCap reporting escalation teardown; do
  want 2  "missing $f fails (exit 2)"                      validate "$TMP/missing_$f.json"
  catch   "missing $f names the field"        "$f"         validate "$TMP/missing_$f.json"
done
want 2  "cadence without timezone fails"                   validate "$TMP/notz.json"
catch   "cadence without timezone names timezone" "timezone" validate "$TMP/notz.json"
want 2  "cadence without cron/expression fails"            validate "$TMP/nocron.json"
want 2  "unbounded per-run cap fails"                      validate "$TMP/nocap.json"
catch   "unbounded cap names a positive bound" "positive bound" validate "$TMP/nocap.json"
want 2  "unsafe/non-stable key fails"                      validate "$TMP/badkey.json"
catch   "unsafe key is named"               "key must match" validate "$TMP/badkey.json"
want 2  "thin (non-self-contained) prompt fails"           validate "$TMP/thinprompt.json"

echo "── 2. create: dedup FIRST (before capability) ─────────────────────────────"
# duplicate key → idempotent no-op even WITH a supported capability + authorization (proves list-first)
want 0  "duplicate key is a no-op (exit 0)"                create "$TMP/valid.json" --capability RemoteTrigger --authorize --existing "$TMP/registry_dupe.json" --json
catch   "duplicate reported"                "duplicate"   create "$TMP/valid.json" --capability RemoteTrigger --authorize --existing "$TMP/registry_dupe.json" --json
absent  "duplicate does NOT mint a new id"  '"automationId"' create "$TMP/valid.json" --capability RemoteTrigger --authorize --existing "$TMP/registry_dupe.json" --json
absent  "duplicate does NOT report created:true" 'created":true' create "$TMP/valid.json" --capability RemoteTrigger --authorize --existing "$TMP/registry_dupe.json" --json
# and the registry is NOT grown by the dedup no-op
node "$V" create "$TMP/valid.json" --capability RemoteTrigger --authorize --existing "$TMP/registry_dupe.json" --json >/dev/null 2>&1
DUPES=$(python3 -c "import json;print(len(json.load(open('$TMP/registry_dupe.json'))))")
if [ "$DUPES" = "1" ]; then echo "PASS (no stacking) dedup did not append a duplicate record"; else echo "FAIL dedup stacked a record (len=$DUPES)"; fails=$((fails+1)); fi

echo "── 3. create: created:false without capability / authorization ────────────"
# no supported capability (Codex-like) → created:false, exit 3, ready brief
want 3  "no capability → not created (exit 3)"             create "$TMP/valid.json" --capability none --existing "$TMP/registry_empty.json" --json
catch   "no capability → created:false"     'created":false' create "$TMP/valid.json" --capability none --json
catch   "no capability → ready brief"       "brief"       create "$TMP/valid.json" --capability none --json
# supported capability but NOT authorized → created:false, exit 3
want 3  "capability without authorization → not created"   create "$TMP/valid.json" --capability RemoteTrigger --json
catch   "unauthorized → created:false"      'created":false' create "$TMP/valid.json" --capability RemoteTrigger --json
# invalid schema in create mode → exit 2, nothing registered
want 2  "invalid schema in create → exit 2"                create "$TMP/missing_key.json" --capability RemoteTrigger --authorize --json

echo "── 4. no false registration claim + verifiable id on success ──────────────"
absent  "no-capability mints NO automation id"   '"automationId"'  create "$TMP/valid.json" --capability none --json
catch   "no-capability says registered:false"    'registered":false' create "$TMP/valid.json" --capability none --json
absent  "no-capability never claims a registration" 'registered":true' create "$TMP/valid.json" --capability none --json
catch   "no-capability names RemoteTrigger/CronCreate as Claude-only" "claude" create "$TMP/valid.json" --capability none --json
# a supported + authorized create DOES mint a verifiable id, persisted to the registry
node "$V" create "$TMP/valid.json" --capability RemoteTrigger --authorize --existing "$TMP/registry_empty.json" --json > "$TMP/created.out" 2>&1
if grep -q '"created":true' "$TMP/created.out" && grep -q '"automationId":"RemoteTrigger:issue-triage"' "$TMP/created.out"; then
  echo "PASS (created) supported+authorized mints RemoteTrigger:issue-triage"
else echo "FAIL supported+authorized did not mint the expected id"; fails=$((fails+1)); cat "$TMP/created.out"; fi
# the minted id is VERIFIABLE — it now lives in the registry, so a re-create dedups it
if node "$V" create "$TMP/valid.json" --capability RemoteTrigger --authorize --existing "$TMP/registry_empty.json" --json 2>&1 | grep -qi duplicate; then
  echo "PASS (verifiable) persisted id is found on re-create (dedup)"
else echo "FAIL persisted id was not verifiable on re-create"; fails=$((fails+1)); fi

echo ""
if [ "$fails" -gt 0 ]; then echo "✗ $fails scheduled-job contract test(s) failed"; exit 1; fi
echo "✓ all scheduled-job contract tests pass"
