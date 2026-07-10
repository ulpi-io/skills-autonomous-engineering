---
name: autonomous-pipeline
description: |
  Codex adapter — run the whole engineering lifecycle (spec → plan → build → simplify → test → review →
  performance → ship) as one governed autonomous pass with a single human plan-approval and hard-gated
  escalation for anything irreversible. Explicit-user-only. Delegates the methodology to the canonical
  autonomous-pipeline skill and drives the IMPLEMENTED deterministic coordinator CLI on Codex.
---

# Autonomous Pipeline — Codex adapter (thin)

This is the **Codex adapter**. It carries no methodology of its own: the canonical contract — the
`<EXTREMELY-IMPORTANT>` guardrails, the eight fail-closed phase gates, the one-approval rule, the
durable-resume and whole-run-budget requirements, and the honest end-state Output Contract — lives in the
root **`autonomous-pipeline/SKILL.md`**. Read and apply that skill in full; this file only maps its
runtime to what Codex can actually execute.

## 1. Apply the shared runtime map (binding)

Before anything else, apply **`codex-skills/.shared/codex-runtime.md`** — the implemented-only capability
contract. It decides which operations are real on Codex and which degrade honestly. Non-negotiable
consequences here:

- **No Claude-only mechanism is a Codex operation.** `Workflow()` (the legacy
  `references/pipeline-workflow.js` backend), `ScheduleWakeup`, native `/goal`+`/loop`, `RemoteTrigger`,
  and `CronCreate` are Claude-Code-only and MUST NOT be presented, invoked, or emulated on Codex. Where
  the canonical skill reaches for one, use its implemented substitute below.
- **Honest termination.** A gate that did not run is never reported clean; a blocked required gate
  hard-stops downstream and the run returns `status:blocked` / `converged:false` with the open register.

## 2. The one operation Codex actually runs: the deterministic coordinator CLI

On Codex the unattended stretch runs on the **implemented, zero-dependency coordinator** — NOT a
Workflow. Drive it through the five public verbs (see `autonomous-pipeline/references/cli-contract.md`,
`budget-contract.md`, `authorization-contract.md`):

```
node autonomous-pipeline/scripts/pipeline.mjs approve   --plan <canonical.json> --config <run-config.json>
node autonomous-pipeline/scripts/pipeline.mjs start      --run <id>
node autonomous-pipeline/scripts/pipeline.mjs resume     --run <id>
node autonomous-pipeline/scripts/pipeline.mjs status     --run <id>
node autonomous-pipeline/scripts/pipeline.mjs authorize  --run <id> --action <ship|deploy|publish|remote-merge>
```

- `approve` mints the ONE-USE, hash-bound plan-approval capability — **this is the single recorded human
  gate.** A human MUST sit between `approve` and `start`; the coordinator can never auto-chain it (a
  non-interactive/piped/child invocation is refused).
- `start` runs every preflight refusal, consumes the approval BEFORE any executor spawns, then drives the
  fail-closed phase DAG. A blocked required gate hard-stops downstream — deterministically, not by model
  judgment. `resume` continues from durable checkpoint state without re-consuming the approval or erasing
  spend. `status` is a read-only snapshot.
- `authorize` halts a converged run and mints a fresh, action-scoped capability for ONE irreversible step.
  Plan approval never satisfies an action — every ship/deploy/publish/remote-merge is separately gated.

The spec and plan halves (`auto-spec` → `auto-plan`) run first via their own Codex adapters
(`$auto-spec`, `$auto-plan`) before you produce the canonical plan JSON that `approve` consumes.

## 3. Delegate

Apply **`autonomous-pipeline/SKILL.md`** (canonical) for all phase semantics, guardrails, and the Output
Contract. This adapter changes only the runtime binding (CLI, not Workflow); it changes nothing about the
methodology.
