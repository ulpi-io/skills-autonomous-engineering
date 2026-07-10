---
name: auto-map
description: |
  Codex adapter — generate/refresh the project's disclosure-tiered CONTEXT ARCHITECTURE, verified against
  the real repo before it ships. Platform-aware: on Codex it builds the root + nested AGENTS.md tree (never
  inventing a memory location the platform lacks). Mutates durable project memory, so it is not
  auto-invoked; the verified-map methodology is delegated to the canonical skill.
---

# auto-map (Codex adapter)

This is a THIN Codex adapter. The canonical methodology — the disclosure-tiered map, the
verify-before-ship discipline, and the generated-vs-human ownership rules — lives in the root skill and is
the single source of truth.

## Apply the runtime map first

Read `codex-skills/.shared/codex-runtime.md` and apply it as the binding capability contract. Relevant
rows: **§11 Skill invocation** (this adapter delegates to the canonical skill) and the **Claude-only**
table. Any fan-out the canonical skill describes via the Claude `Agent` tool has **no native Codex
equivalent** — do not present `Agent`/`Workflow` fan-out as a runnable Codex operation; run the mapping
work directly/sequentially instead.

On Codex the memory surface is the **root + nested `AGENTS.md`** tree (not `CLAUDE.md` / `.claude/rules`).
Emit the map into AGENTS.md files only; never invent a memory location Codex lacks, and never touch
private agent memory.

## Delegate to the canonical methodology

Apply the root **auto-map** skill (`auto-map/SKILL.md`) end to end: build the disclosure-tiered context
architecture, VERIFY every claim against the real repo (commands actually run, paths actually exist) before
it ships, link deep references rather than importing them, and STOP before mutating when a platform is
unsupported or generated-vs-human ownership is ambiguous.

## Output contract

Report the verified map (files written/updated), the verification evidence, and any STOP/escalation where
ownership or platform support was ambiguous. Never ship an unverified claim.
