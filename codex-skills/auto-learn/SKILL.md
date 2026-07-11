---
name: auto-learn
description: |
  Use when an autonomous run has just finished, or a session hit blocks, thrash, wrong turns, or surprises
  worth not repeating, and you want the lessons captured so the next session starts smarter. Triggers on run
  wrap-up, "what did we learn", a recurring mistake, the post-mortem of a pipeline run.
---

# auto-learn (Codex adapter)

This is a THIN Codex adapter. The canonical methodology — harvest-from-artifacts, adversarial verification,
dedupe, routed writes, and surface-don't-self-patch — lives in the root skill and is the single source of
truth.

## Apply the runtime map first

Read `codex-skills/.shared/codex-runtime.md` and apply it as the binding capability contract. Relevant
rows: **§11 Skill invocation** and the **Claude-only** table. Any adversarial fan-out the canonical skill
describes via the Claude `Agent`/`Workflow` tools has **no native Codex fan-out primitive** — do not present
it as a runnable Codex operation; perform the verification directly/sequentially instead.

On Codex the durable-memory surface is the **AGENTS.md** tree (root + path-scoped nested files), not
`CLAUDE.md` / `.claude/rules` / Claude auto memory. Route each verified learning to the appropriate
AGENTS.md location; never invent a memory location Codex lacks.

## Delegate to the canonical methodology

Apply the root **auto-learn** skill (`auto-learn/SKILL.md`) end to end: draw candidates only from the run's
structured evidence, verify each adversarially before writing, dedupe against what is already documented,
and write each surviving learning to the memory the next session loads. Surface machine defects to the
user — never self-patch them. Run only on complete run evidence, never mid-run.

## Output contract

Report the verified learnings written (with their routed destinations), the deduped/rejected candidates,
and any machine defects surfaced to the user. Never write an unverified or already-documented learning.
