#!/usr/bin/env bash
# test-review-workflow-claude-only.sh — acceptance fixture for TASK-052.
#
# Proves the auto-review Workflow template is a LEGACY, CLAUDE-ONLY compatibility backend and that
# the Codex marketplace artifact does NOT ship it:
#
#   AC1  auto-review/references/review-workflow.js DECLARES the Claude-only label (LEGACY + CLAUDE-ONLY
#        + the "Codex adapter cannot select it" disqualifier), carries NO unqualified Codex-runnable /
#        Codex-delegation claim (no `delegate: review: codex` framing), and lets NO model prompt own the
#        review's convergence. It also stays Workflow-sandbox clean (no require/import/Date.now/Math.random)
#        and node-parseable, so relabeling did not change runtime behavior.
#   AC2  codex-skills/ contains NO reference to review-workflow.js, AND the packaged Codex artifact
#        (built to a temp --out) contains NO review-workflow.js anywhere — while the delegate SKILL.md
#        and its .md references still ship so delegation resolves.
#   AC3  the AC1 label/claim check is DISCRIMINATING — it FAILS on a copy whose label is stripped and on
#        a copy where a Codex-delegation claim is re-introduced; and the pre-existing gates stay green:
#          node scripts/validate-skills.mjs --surface claude --skill auto-review
#          bash  scripts/test-codex-package.sh
#
# Exit 0 = all assertions pass; exit 1 = one or more failed.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
WF="$REPO/auto-review/references/review-workflow.js"
PKG="$SCRIPT_DIR/package-codex-plugin.mjs"
PLUGIN_REL="plugins/autonomous-engineering"

PASS=0
FAIL=0
pass() { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; }

TMPROOT="$(mktemp -d)"
cleanup() { rm -rf "$TMPROOT"; }
trap cleanup EXIT

# label_ok <file> — the single AC1 label/claim predicate, reused by AC1 (must pass on the real file)
# and AC3 (must FAIL on the mutated copies). Returns 0 only when the file is a properly-labeled,
# Claude-only backend with no delegation / model-owns-convergence claim.
label_ok() {
  local f="$1"
  # POSITIVE: the three label pillars must ALL be present.
  grep -qiE 'legacy'                         "$f" || return 1
  grep -qiE 'claude[- ]only'                 "$f" || return 1
  grep -qiE 'codex adapter cannot select it' "$f" || return 1
  # NEGATIVE: no Codex-delegation framing (the `delegate: review: codex` hand-off relabeled away).
  grep -qiE 'delegate[^a-z0-9]{0,6}review[^a-z0-9]{0,6}codex' "$f" && return 1
  # NEGATIVE: no unqualified universal/cross-host RUNNABLE claim (Claude-qualified negations are fine).
  grep -qiE 'runs (on|under) (any|every|all|the codex|codex|both)' "$f" && return 1
  # NEGATIVE: no model prompt is presented as OWNING the review's convergence.
  grep -qiE '(prompt|reviewer|skeptic|model|agent)[^.]{0,60}owns[^.]{0,40}converg' "$f" && return 1
  grep -qiE 'converg[a-z]*[^.]{0,40}(is|are) owned by' "$f" && return 1
  return 0
}

# ===========================================================================
echo "[AC1] review-workflow.js declares the Claude-only label, no delegation/convergence claim"
# ===========================================================================
[ -f "$WF" ] && pass "review-workflow.js exists" || fail "review-workflow.js missing at $WF"

if label_ok "$WF"; then
  pass "label predicate holds: LEGACY + Claude-only + 'Codex adapter cannot select it', no delegation/convergence claim"
else
  fail "review-workflow.js does not satisfy the Claude-only label predicate"
fi

# meta.description also carries the Claude-only / cannot-select framing (the machine-readable surface).
if grep -qiE "description:.*claude-only.*(codex adapter cannot select|cannot select it)" "$WF"; then
  pass "meta.description is labeled Claude-only + Codex-adapter-cannot-select"
else
  fail "meta.description is not relabeled Claude-only"
fi

# runtime behavior unchanged: still Workflow-sandbox clean + node-parseable.
if grep -nE 'require\(|(^|[^.])\bimport\b|Date\.now|Math\.random' "$WF" >/dev/null 2>&1; then
  fail "review-workflow.js introduced a banned sandbox construct (require/import/Date.now/Math.random)"
else
  pass "no banned sandbox construct (require/import/Date.now/Math.random)"
fi
if node --check "$WF" >/dev/null 2>&1; then
  pass "review-workflow.js parses cleanly (node --check)"
else
  fail "review-workflow.js failed node --check"
fi
# export const meta still present and valid-shaped (name + description keys survive relabeling).
if grep -qE "export const meta = \{" "$WF" && grep -qE "name: 'auto-review'" "$WF"; then
  pass "export const meta preserved (name: 'auto-review')"
else
  fail "export const meta was damaged by relabeling"
fi

# ===========================================================================
echo "[AC2] codex-skills/ and the packaged artifact carry NO review-workflow.js"
# ===========================================================================
if grep -rn "review-workflow" "$REPO/codex-skills" >/dev/null 2>&1; then
  fail "codex-skills/ references review-workflow (must not)"
else
  pass "codex-skills/ has NO reference to review-workflow"
fi

OUT="$(mktemp -d "$TMPROOT/out.XXXXXX")"
if node "$PKG" --root "$REPO" --out "$OUT" >/dev/null 2>&1; then
  pass "packaging the real repo exits 0"
else
  fail "packaging the real repo failed"
fi
# no review-workflow.js (nor its pipeline sibling) anywhere in the shipped artifact
WF_HITS="$(find "$OUT" -name 'review-workflow.js' 2>/dev/null)"
[ -z "$WF_HITS" ] && pass "artifact contains NO review-workflow.js" \
  || fail "artifact still ships review-workflow.js:\n$WF_HITS"
PWF_HITS="$(find "$OUT" -name 'pipeline-workflow.js' 2>/dev/null)"
[ -z "$PWF_HITS" ] && pass "artifact contains NO pipeline-workflow.js (sibling Claude-only template)" \
  || fail "artifact still ships pipeline-workflow.js:\n$PWF_HITS"
# but the delegate SKILL.md + its .md references DO still ship (delegation resolves)
[ -f "$OUT/$PLUGIN_REL/auto-review/SKILL.md" ] \
  && pass "delegate auto-review/SKILL.md still ships" \
  || fail "delegate auto-review/SKILL.md missing from artifact"
[ -f "$OUT/$PLUGIN_REL/autonomous-pipeline/references/pipeline-state.md" ] \
  && pass "delegate .md references still ship (pipeline-state.md kept, only *.js dropped)" \
  || fail "delegate .md reference was wrongly dropped from artifact"

# ===========================================================================
echo "[AC3] the label check is discriminating + the pre-existing gates stay green"
# ===========================================================================
# (a) label stripped → predicate must FAIL
MUT_NOLABEL="$TMPROOT/nolabel.js"
sed -E 's/LEGACY, CLAUDE-ONLY compatibility backend/runnable Workflow/; s/the Codex adapter cannot select it//I; s/LEGACY Claude-only Workflow backend//I' "$WF" > "$MUT_NOLABEL"
if label_ok "$MUT_NOLABEL"; then
  fail "predicate wrongly PASSED a copy with the Claude-only label stripped"
else
  pass "predicate FAILS when the Claude-only label is missing"
fi

# (b) a Codex-delegation claim re-introduced → predicate must FAIL
MUT_DELEG="$TMPROOT/deleg.js"
{ printf '// regression: delegate: review: codex — routes the review to the Codex runtime\n'; cat "$WF"; } > "$MUT_DELEG"
if label_ok "$MUT_DELEG"; then
  fail "predicate wrongly PASSED a copy with a Codex-delegation claim"
else
  pass "predicate FAILS when a Codex-delegation claim is present"
fi

# (c) pre-existing Claude auto-review validation stays green
if node "$REPO/scripts/validate-skills.mjs" --surface claude --skill auto-review >/dev/null 2>&1; then
  pass "validate-skills.mjs --surface claude --skill auto-review stays green"
else
  fail "validate-skills.mjs --surface claude --skill auto-review is RED"
fi

# (d) the legacy Codex packager acceptance suite stays green
if bash "$SCRIPT_DIR/test-codex-package.sh" >/dev/null 2>&1; then
  pass "test-codex-package.sh stays green"
else
  fail "test-codex-package.sh is RED"
fi

# ===========================================================================
echo
echo "==================== RESULT: $PASS passed, $FAIL failed ===================="
[ "$FAIL" -eq 0 ]
