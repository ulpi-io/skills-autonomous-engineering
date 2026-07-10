#!/usr/bin/env bash
# test-codex-package.sh — acceptance test for scripts/package-codex-plugin.mjs (TASK-037).
#
# Proves the Codex marketplace packager:
#   1. TOPOLOGY   — packages the real repo to a TEMP --out with the required topology:
#                   .agents/plugins/marketplace.json + plugins/autonomous-engineering/ +
#                   EXACTLY 18 adapters (SKILL.md + agents/openai.yaml) + artifact manifest whose
#                   version MATCHES source + all 18 canonical delegate dirs present outside
#                   codex-skills/ + NO plugin-root skills/ dir.
#   2. REPRODUCIBLE — two runs print the SAME sha256 digest and produce byte-identical trees.
#   3. EXCLUSIONS  — .git / .claude-plugin / examples / .ulpi / .DS_Store never reach the artifact.
#   4. FAIL-CLASSES — each sealed hazard class exits nonzero with the right PACKAGE-FAIL label:
#                   default skills/ dir, missing delegate, escaping path, stale catalog,
#                   invalid marketplace source, artifact/source topology drift.
#   5. NO-MUTATION — the source repo tree is byte-identical before and after packaging.
#
# Exit 0 = all assertions pass; exit 1 = one or more failed.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG="$SCRIPT_DIR/package-codex-plugin.mjs"
PLUGIN_REL="plugins/autonomous-engineering"

PASS=0
FAIL=0
pass() { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; }

TMPROOT="$(mktemp -d)"
cleanup() { rm -rf "$TMPROOT"; }
trap cleanup EXIT

# Canonical delegate dir names, read straight from the sealed catalog (no hardcoding / drift).
DELEGATES="$(node -e "const c=require('$REPO/codex-skills/catalog.json');process.stdout.write(c.skills.map(s=>s.canonicalSource).join(' '))")"
if [ -z "$DELEGATES" ]; then echo "FATAL: could not read delegate list from catalog"; exit 1; fi

# --- helpers ----------------------------------------------------------------

# snapshot <dir> — single stable hash of every file (path+content) under dir, minus volatile bits.
snapshot() {
  ( cd "$1" && find . -type f \
      ! -path './.git/*' ! -path '*/.git/*' ! -path './.ulpi/*' \
      ! -name '.DS_Store' -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 shasum 2>/dev/null \
    | shasum | awk '{print $1}' )
}

# build_fixture <dest> — assemble a MINIMAL, VALID source tree the packager accepts.
build_fixture() {
  local dest="$1"
  mkdir -p "$dest"
  cp -R "$REPO/.codex-plugin" "$dest/"
  cp -R "$REPO/codex-skills" "$dest/"
  local d
  for d in $DELEGATES; do cp -R "$REPO/$d" "$dest/$d"; done
}

# run_pkg <fixtureRoot> <outDir> — run packager, echo combined output, return its rc.
run_pkg() { node "$PKG" --root "$1" --out "$2" 2>&1; }

# assert_fail_class <desc> <class> <fixtureRoot> — packaging the fixture must exit nonzero and print
# `PACKAGE-FAIL: <class>`.
assert_fail_class() {
  local desc="$1" class="$2" fx="$3"
  local o out rc
  o="$(mktemp -d "$TMPROOT/out.XXXXXX")"
  out="$(node "$PKG" --root "$fx" --out "$o" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then
    fail "$desc: expected nonzero exit, got 0"
    return
  fi
  if printf '%s' "$out" | grep -q "PACKAGE-FAIL: $class"; then
    pass "$desc → exit $rc, class '$class'"
  else
    fail "$desc: nonzero but wrong/missing class. output: $out"
  fi
}

exists() { [ -e "$1" ]; }

# ===========================================================================
echo "[1] TOPOLOGY — package the real repo"
# ===========================================================================
OUT1="$(mktemp -d "$TMPROOT/out.XXXXXX")"
if OUTPUT1="$(node "$PKG" --root "$REPO" --out "$OUT1" 2>&1)"; then
  pass "packaging the real repo exits 0"
else
  fail "packaging the real repo exited nonzero: $OUTPUT1"
fi

MKT="$OUT1/.agents/plugins/marketplace.json"
exists "$MKT" && pass "marketplace source at .agents/plugins/marketplace.json" \
  || fail "missing marketplace source"

MANIFEST="$OUT1/$PLUGIN_REL/.codex-plugin/plugin.json"
exists "$MANIFEST" && pass "plugin manifest present" || fail "missing plugin manifest"

# exactly 18 adapters (SKILL.md + agents/openai.yaml)
ADAPTERS=0
for d in "$OUT1/$PLUGIN_REL/codex-skills"/*/; do
  [ -f "$d/SKILL.md" ] && [ -f "$d/agents/openai.yaml" ] && ADAPTERS=$((ADAPTERS+1))
done
[ "$ADAPTERS" -eq 18 ] && pass "exactly 18 adapters (SKILL.md + agents/openai.yaml)" \
  || fail "expected 18 adapters, found $ADAPTERS"

# version match: artifact manifest version == source .codex-plugin/plugin.json version
SRC_VER="$(node -e "process.stdout.write(require('$REPO/.codex-plugin/plugin.json').version)")"
ART_VER="$(node -e "process.stdout.write(require('$MANIFEST').version)")"
[ -n "$SRC_VER" ] && [ "$SRC_VER" = "$ART_VER" ] \
  && pass "artifact manifest version ($ART_VER) matches source" \
  || fail "version mismatch: source=$SRC_VER artifact=$ART_VER"

# marketplace plugin version also matches
MKT_VER="$(node -e "process.stdout.write(require('$MKT').plugins[0].version)")"
[ "$MKT_VER" = "$SRC_VER" ] && pass "marketplace plugin version matches source" \
  || fail "marketplace version mismatch: $MKT_VER != $SRC_VER"

# skills pointer preserved
ART_SKILLS="$(node -e "process.stdout.write(require('$MANIFEST').skills)")"
[ "$ART_SKILLS" = "./codex-skills/" ] && pass "artifact skills pointer is ./codex-skills/" \
  || fail "artifact skills pointer drifted: $ART_SKILLS"

# all 18 canonical delegate dirs present OUTSIDE codex-skills/
MISSING_DEL=""
for d in $DELEGATES; do
  [ -f "$OUT1/$PLUGIN_REL/$d/SKILL.md" ] || MISSING_DEL="$MISSING_DEL $d"
done
[ -z "$MISSING_DEL" ] && pass "all 18 delegate dirs ship outside codex-skills/" \
  || fail "missing delegate dirs in artifact:$MISSING_DEL"

# NO plugin-root skills/ dir anywhere in the artifact
if find "$OUT1/$PLUGIN_REL" -maxdepth 1 -type d -name skills | grep -q .; then
  fail "artifact plugin root contains a skills/ dir"
else
  pass "no plugin-root skills/ dir in artifact"
fi

# digest line is emitted
printf '%s' "$OUTPUT1" | grep -q 'digest=sha256:[0-9a-f]\{64\}' \
  && pass "packager prints a sha256 content digest" \
  || fail "no sha256 digest line in output"

# ===========================================================================
echo "[2] REPRODUCIBLE — byte-identical re-run"
# ===========================================================================
OUT2="$(mktemp -d "$TMPROOT/out.XXXXXX")"
OUTPUT2="$(node "$PKG" --root "$REPO" --out "$OUT2" 2>&1)"
D1="$(printf '%s' "$OUTPUT1" | grep -o 'digest=sha256:[0-9a-f]*')"
D2="$(printf '%s' "$OUTPUT2" | grep -o 'digest=sha256:[0-9a-f]*')"
[ -n "$D1" ] && [ "$D1" = "$D2" ] && pass "two runs print the SAME digest ($D1)" \
  || fail "digest differs across runs: '$D1' vs '$D2'"

S1="$(snapshot "$OUT1")"; S2="$(snapshot "$OUT2")"
[ "$S1" = "$S2" ] && pass "two runs produce byte-identical trees" \
  || fail "artifact trees differ across runs ($S1 vs $S2)"

# ===========================================================================
echo "[3] EXCLUSIONS — junk never reaches the artifact"
# ===========================================================================
# clean artifact: none of the excluded names present
BADHITS="$(find "$OUT1" \( -name '.git' -o -name '.claude-plugin' -o -name 'examples' \
  -o -name '.ulpi' -o -name '.DS_Store' \) 2>/dev/null)"
[ -z "$BADHITS" ] && pass "clean artifact excludes .git/.claude-plugin/examples/.ulpi/.DS_Store" \
  || fail "artifact contains excluded paths:\n$BADHITS"

# inject junk into a fixture and confirm it is stripped
FX_EXC="$TMPROOT/fx-exclude"
build_fixture "$FX_EXC"
mkdir -p "$FX_EXC/auto-spec/.ulpi" "$FX_EXC/auto-spec/.git" "$FX_EXC/codex-skills/auto-spec/.ulpi"
: > "$FX_EXC/auto-spec/.ulpi/state.json"
: > "$FX_EXC/auto-spec/.DS_Store"
: > "$FX_EXC/auto-spec/.git/HEAD"
: > "$FX_EXC/codex-skills/auto-spec/.ulpi/run.json"
OUT_EXC="$(mktemp -d "$TMPROOT/out.XXXXXX")"
if node "$PKG" --root "$FX_EXC" --out "$OUT_EXC" >/dev/null 2>&1; then
  JUNK="$(find "$OUT_EXC" \( -name '.ulpi' -o -name '.git' -o -name '.DS_Store' \) 2>/dev/null)"
  [ -z "$JUNK" ] && pass "injected .ulpi/.git/.DS_Store stripped from artifact" \
    || fail "injected junk survived into artifact:\n$JUNK"
else
  fail "packaging the junk-injected fixture unexpectedly failed"
fi

# ===========================================================================
echo "[4] NO-MUTATION — the source repo is unchanged by packaging"
# ===========================================================================
REPO_BEFORE="$(snapshot "$REPO")"
OUT_NM="$(mktemp -d "$TMPROOT/out.XXXXXX")"
node "$PKG" --root "$REPO" --out "$OUT_NM" >/dev/null 2>&1
REPO_AFTER="$(snapshot "$REPO")"
[ "$REPO_BEFORE" = "$REPO_AFTER" ] && pass "repo tree byte-identical before/after packaging" \
  || fail "repo tree changed during packaging ($REPO_BEFORE -> $REPO_AFTER)"

# writing INTO the repo is refused (bad invocation, exit 2)
node "$PKG" --root "$REPO" --out "$REPO/some-artifact" >/dev/null 2>&1
[ $? -eq 2 ] && pass "refuses --out inside the source repo (exit 2)" \
  || fail "did not refuse --out inside the repo"

# ===========================================================================
echo "[5] FAIL-CLASSES — each sealed hazard exits nonzero with its label"
# ===========================================================================

# (a) default skills/ directory at the plugin root
FX="$TMPROOT/fx-skills"; build_fixture "$FX"; mkdir -p "$FX/skills/leak"
assert_fail_class "default skills/ dir" "default skills/ directory" "$FX"

# (b) missing delegate — remove a canonical delegate dir the catalog still references
FX="$TMPROOT/fx-deleg"; build_fixture "$FX"; rm -rf "$FX/auto-spec"
assert_fail_class "missing delegate" "missing delegate" "$FX"

# (c) escaping path — catalog canonicalSource points outside the root
FX="$TMPROOT/fx-escape"; build_fixture "$FX"
node -e "const f='$FX/codex-skills/catalog.json';const c=require(f);c.skills[0].canonicalSource='../evil';require('fs').writeFileSync(f,JSON.stringify(c,null,2))"
assert_fail_class "escaping path" "escaping path" "$FX"

# (d) stale catalog — adapters on disk (17) disagree with the catalog (18)
FX="$TMPROOT/fx-stale"; build_fixture "$FX"; rm -rf "$FX/codex-skills/auto-plan"
assert_fail_class "stale catalog" "stale catalog" "$FX"

# (e) invalid marketplace source — manifest yields no valid marketplace descriptor
FX="$TMPROOT/fx-mkt"; build_fixture "$FX"
node -e "const f='$FX/.codex-plugin/plugin.json';const m=require(f);m.name='';require('fs').writeFileSync(f,JSON.stringify(m,null,2))"
assert_fail_class "invalid marketplace source" "invalid marketplace source" "$FX"

# (f) artifact/source topology drift — skills pointer is cross-surface (./ instead of ./codex-skills/)
FX="$TMPROOT/fx-drift"; build_fixture "$FX"
node -e "const f='$FX/.codex-plugin/plugin.json';const m=require(f);m.skills='./';require('fs').writeFileSync(f,JSON.stringify(m,null,2))"
assert_fail_class "artifact/source topology drift" "artifact/source topology drift" "$FX"

# ===========================================================================
echo
echo "==================== RESULT: $PASS passed, $FAIL failed ===================="
[ "$FAIL" -eq 0 ]
