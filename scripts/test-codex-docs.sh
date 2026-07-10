#!/usr/bin/env bash
# test-codex-docs.sh — the Codex-docs HONESTY fixture (TASK-039).
#
# Mechanically ties every Codex-ready CLAIM in the published docs to a path that EXISTS. It FAILS if:
#   1. README.md still calls Codex "phase 2" (the deferral we removed) — the claim must be present-tense.
#   2. Any Codex-ready claim in the README "## Codex plugin" section OR in the Codex plugin guide cites an
#      implemented path / deterministic-test file that is ABSENT from the repo (a phantom reference).
#   3. The required LIVE evidence (the real-Codex plugin smoke, `smoke-codex-plugin.mjs --live`) is not
#      linked from README, or the guide itself is not linked — an unlinked capability is an unproven claim.
#   4. A core Codex capability path is silently dropped from the README Codex section.
#
# Zero deps beyond coreutils + awk. Bash 3.2 compatible (macOS default). Run from anywhere.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
README="$ROOT/README.md"
GUIDE="$ROOT/codex-skills/.shared/codex-plugin-guide.md"

FAILS=0
fail() { printf 'DOC-FAIL: %s\n' "$1" >&2; FAILS=$((FAILS + 1)); }
ok()   { printf '  ok: %s\n' "$1"; }

# ── 0. the two documents must exist ─────────────────────────────────────────────────────────────────
[ -f "$README" ] || fail "README.md missing at $README"
[ -f "$GUIDE" ]  || fail "Codex plugin guide missing at $GUIDE"
if [ "$FAILS" -ne 0 ]; then printf '\ntest-codex-docs: %d failure(s)\n' "$FAILS" >&2; exit 1; fi

# ── 1. README must NOT defer Codex to "phase 2" ─────────────────────────────────────────────────────
if grep -niE 'phase[[:space:]]+2' "$README" >/dev/null 2>&1; then
  fail "README.md still says Codex 'phase 2' — every Codex claim must be present-tense/implemented"
  grep -niE 'phase[[:space:]]+2' "$README" | sed 's/^/    /' >&2
else
  ok "README does not defer Codex to 'phase 2'"
fi

# ── 2. README must link the guide + the live-smoke evidence ─────────────────────────────────────────
if grep -qF 'codex-skills/.shared/codex-plugin-guide.md' "$README"; then
  ok "README links the Codex plugin guide"
else
  fail "README does not link the Codex plugin guide (codex-skills/.shared/codex-plugin-guide.md)"
fi
# required LIVE evidence: the real-Codex plugin smoke must be linked with its --live flag.
if grep -E 'smoke-codex-plugin\.mjs[^\n]*--live' "$README" >/dev/null 2>&1; then
  ok "README links the required live evidence (smoke-codex-plugin.mjs --live)"
else
  fail "README does not link the required live evidence: 'node scripts/smoke-codex-plugin.mjs --live'"
fi

# ── 3. extract the README "## Codex plugin" section (up to the next '## ' heading) ───────────────────
SECTION="$(awk '
  /^## Codex plugin[[:space:]]*$/ { grab=1; next }
  grab && /^## / { exit }
  grab { print }
' "$README")"
if [ -z "$SECTION" ]; then
  fail "README has no '## Codex plugin' section"
fi

# ── path-existence scan: every source-file path cited in <text> must exist under ROOT ───────────────
# Pulls inline-code spans (backtick-delimited), splits to tokens, keeps only repo-source-file-looking
# paths (contain '/', end in a known code/doc extension, no placeholder metachars), and asserts each
# exists. A cited-but-absent path is a phantom claim → FAIL.
scan_paths() {
  local label="$1"; shift
  local text="$1"
  local found=0
  # inline-code spans → one token per line
  local tokens
  tokens="$(printf '%s\n' "$text" \
    | grep -oE '`[^`]+`' \
    | sed 's/`//g' \
    | tr ' ' '\n' \
    | sed -E 's/[),.:;]+$//' \
    | grep -E '^[A-Za-z0-9._/-]+\.(mjs|sh|json|md|js|yaml|yml)$' \
    | grep '/' \
    | sort -u)"
  if [ -z "$tokens" ]; then
    return 0
  fi
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    found=$((found + 1))
    if [ -e "$ROOT/$p" ]; then
      ok "$label cites existing path: $p"
    else
      fail "$label cites a phantom path (absent from repo): $p"
    fi
  done <<EOF
$tokens
EOF
  if [ "$found" -eq 0 ]; then
    fail "$label references no implemented paths — a Codex-ready claim must cite one"
  fi
}

scan_paths "README '## Codex plugin' section" "$SECTION"
scan_paths "Codex plugin guide" "$(cat "$GUIDE")"

# ── 4. core Codex capability paths must be PRESENT (not silently dropped) AND exist on disk ──────────
# claim-label|path-that-must-be-cited-in-the-README-Codex-section
REQUIRED="\
marketplace packager|scripts/package-codex-plugin.mjs
sealed adapter catalog|codex-skills/catalog.json
plugin manifest|.codex-plugin/plugin.json
codex exec executor|autonomous-pipeline/scripts/lib/codex-executor.mjs
codex-event guard hooks|hooks/hooks.json
live plugin smoke|scripts/smoke-codex-plugin.mjs"

while IFS='|' read -r label path; do
  [ -z "$label" ] && continue
  if [ ! -e "$ROOT/$path" ]; then
    fail "required Codex capability '$label' has no implemented file at $path"
    continue
  fi
  if printf '%s\n' "$SECTION" | grep -qF "$path"; then
    ok "README Codex section documents '$label' ($path)"
  else
    fail "README Codex section drops the '$label' claim — $path is not referenced"
  fi
done <<EOF
$REQUIRED
EOF

# ── verdict ─────────────────────────────────────────────────────────────────────────────────────────
if [ "$FAILS" -ne 0 ]; then
  printf '\ntest-codex-docs: FAILED with %d issue(s)\n' "$FAILS" >&2
  exit 1
fi
printf '\ntest-codex-docs: PASSED — every Codex-ready claim maps to a path that exists\n'
exit 0
