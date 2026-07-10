#!/bin/bash
# test-validate-skills.sh — behavior contract for the dual-platform validate-skills.mjs (CI-run).
# Proves: (a) --surface <claude|codex|all> + repeated --skill filters validate only the requested
# slice and reject an unknown skill; (b) the codex-skills/ adapter tree is validated separately when
# present (invalid manifest, broken delegate, missing openai.yaml field, unsupported Codex hook event
# each fail nonzero); (c) the DOC-HONESTY guard fails on a reintroduced over-claim ("mechanically
# impossible", an unattended "spec to ship") or a dropped fail-closed / common-spellings caveat, while
# the legitimate "Spec to a shippable PR" wording stays green.
# Fixtures are built in a temp dir and the validator is pointed at them with --root, so the real repo
# tree is never mutated. The unqualified `node validate-skills.mjs` run (real 18 skills) is exercised
# by the slice command that precedes this script.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
V="$ROOT/scripts/validate-skills.mjs"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fails=0

# expect EXACT rc: expect <rc> <desc> <validator args...>
expect() {
  local want=$1 desc=$2; shift 2
  node "$V" "$@" >/dev/null 2>&1; local got=$?
  if [ "$got" = "$want" ]; then echo "PASS (rc=$got) $desc"
  else echo "FAIL (got $got want $want) $desc"; fails=$((fails+1)); fi
}
# expect ANY nonzero rc (a violation was caught): expect_nz <desc> <validator args...>
expect_nz() {
  local desc=$1; shift
  node "$V" "$@" >/dev/null 2>&1; local got=$?
  if [ "$got" != "0" ]; then echo "PASS (rc=$got) $desc"
  else echo "FAIL (rc=0, wanted nonzero) $desc"; fails=$((fails+1)); fi
}

# --- clean fixture root: 2 Claude skills + a valid Codex adapter tree + an honest README ---
C="$TMP/clean"
mk_clean() {
  local d="$1"; rm -rf "$d"; mkdir -p "$d"
  cat > "$d/README.md" <<'MD'
# Fixture Collection
Every mode is bounded and the gates fail closed. The deterministic hooks stop the
common spellings of a banned command at the tool layer before it runs.
MD
  for s in someskill otherskill; do
    mkdir -p "$d/$s"
    cat > "$d/$s/SKILL.md" <<MD
---
name: $s
description: Does a bounded thing when you need that bounded thing done unattended.
allowed-tools:
  - Read
---
# $s
Body of the skill.
MD
  done
  mkdir -p "$d/codex-skills/adapter-a"
  printf '{"adapters":["adapter-a"]}\n' > "$d/codex-skills/manifest.json"
  cat > "$d/codex-skills/adapter-a/openai.yaml" <<'YML'
name: adapter-a
description: Codex adapter that delegates to the someskill Claude skill.
delegate: someskill
YML
}
mk_clean "$C"

# fresh mutable copy of the clean fixture
newcase() { local d="$TMP/$1"; rm -rf "$d"; cp -R "$C" "$d"; printf '%s' "$d"; }

# ---- 1. clean tree passes on every surface ----
expect 0 "clean tree (default surface=all) passes"   --root "$C"
expect 0 "clean tree --surface claude"                --root "$C" --surface claude
expect 0 "clean tree --surface codex"                 --root "$C" --surface codex
expect 0 "clean tree --surface all"                   --root "$C" --surface all

# ---- 2. --surface / --skill filters ----
expect 0 "single --skill (Claude skill)"              --root "$C" --skill someskill
expect 0 "repeated --skill (two Claude skills)"       --root "$C" --skill someskill --skill otherskill
expect 0 "--skill selects a Codex adapter under all"  --root "$C" --skill adapter-a
expect_nz "unknown --skill exits nonzero"             --root "$C" --skill ghost
expect_nz "unknown --skill among known ones"          --root "$C" --skill someskill --skill ghost
expect 2  "invalid --surface value exits 2"           --root "$C" --surface martian

# ---- 3. Codex adapter-tree violations each fail nonzero ----
d=$(newcase invalid_manifest); printf 'this is not json {{\n' > "$d/codex-skills/manifest.json"
expect_nz "invalid Codex manifest"                    --root "$d"

d=$(newcase broken_delegate)
cat > "$d/codex-skills/adapter-a/openai.yaml" <<'YML'
name: adapter-a
description: Codex adapter whose delegate points at nothing.
delegate: ghost-skill
YML
expect_nz "broken delegate"                           --root "$d"
expect_nz "broken delegate under --surface codex"     --root "$d" --surface codex

d=$(newcase missing_field)
cat > "$d/codex-skills/adapter-a/openai.yaml" <<'YML'
name: adapter-a
description: Codex adapter missing its required delegate field.
YML
expect_nz "missing openai.yaml field"                 --root "$d"

d=$(newcase bad_hook)
printf '{"hooks":{"Notification":[{"hooks":[{"type":"command","command":"true"}]}]}}\n' \
  > "$d/codex-skills/adapter-a/hooks.json"
expect_nz "unsupported Codex hook event"              --root "$d"

# ---- 4. DOC-HONESTY guard ----
d=$(newcase doc_mech); printf '\nBypassing the gate is mechanically impossible here.\n' >> "$d/README.md"
expect_nz "over-claim: 'mechanically impossible' in README"        --root "$d"
expect 0  "DOC-HONESTY does not run under --surface codex"         --root "$d" --surface codex

d=$(newcase doc_spec); printf '\nIt goes from spec to ship with no human in the loop.\n' >> "$d/README.md"
expect_nz "over-claim: unattended 'spec to ship' in README"        --root "$d"

d=$(newcase doc_shippable_ok); printf '\nSpec to a shippable PR, unattended. Then it learns.\n' >> "$d/README.md"
expect 0  "'Spec to a shippable PR' wording stays allowed"         --root "$d"

d=$(newcase doc_drop_failclosed)
printf '# Fixture\nThe hooks stop the common spellings at the tool layer.\n' > "$d/README.md"
expect_nz "dropped fail-closed caveat in README"                   --root "$d"

d=$(newcase doc_drop_spellings)
printf '# Fixture\nEvery mode is bounded and fails closed at each gate.\n' > "$d/README.md"
expect_nz "dropped common-spellings caveat in README"              --root "$d"

d=$(newcase doc_skill_banned); printf '\nThis path is mechanically impossible to reach.\n' >> "$d/someskill/SKILL.md"
expect_nz "over-claim reintroduced in a SKILL.md"                  --root "$d"

echo ""
if [ "$fails" -gt 0 ]; then echo "✗ $fails validate-skills contract test(s) failed"; exit 1; fi
echo "✓ all validate-skills dual-platform contract tests pass"
