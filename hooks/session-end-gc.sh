#!/bin/bash
# session-end-gc — SessionEnd hook. Fire-and-forget housekeeping: archive TERMINAL autonomous runs
# (done/needs_attention/aborted) older than the retention window into .ulpi/runs/archive, so stale
# checkpoints stop arming guards and cluttering the SessionStart announcement. NEVER touches a running
# run (checkpoint.mjs gc refuses those). SessionEnd cannot block; this is pure cleanup. Fail-open silently.
set -u
runs="${CLAUDE_PROJECT_DIR:-.}/.ulpi/runs"
[ -d "$runs" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0
# Resolve checkpoint.mjs across the install layouts (plugin / project / universal / home), same order the
# skill-scoped guard resolvers use.
for p in "${CLAUDE_PLUGIN_ROOT:-/nonexistent}/checkpoint-resume/scripts/checkpoint.mjs" \
         "${CLAUDE_PROJECT_DIR:-.}/.claude/skills/checkpoint-resume/scripts/checkpoint.mjs" \
         "${CLAUDE_PROJECT_DIR:-.}/.agents/skills/checkpoint-resume/scripts/checkpoint.mjs" \
         "$HOME/.claude/skills/checkpoint-resume/scripts/checkpoint.mjs" \
         "$HOME/.agents/skills/checkpoint-resume/scripts/checkpoint.mjs"; do
  [ -f "$p" ] && { node "$p" gc "$runs" --keep-days "${ULPI_GC_KEEP_DAYS:-7}" >/dev/null 2>&1 || true; break; }
done
exit 0
