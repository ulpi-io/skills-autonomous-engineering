---
name: schedule-recurring-agent
description: |
  Codex adapter — stand up a recurring scheduled agent for standing work (triage, monitoring, audits,
  digests) as a self-contained, IDEMPOTENT, per-run-BOUNDED brief with escalation rules and a teardown
  condition. Codex has no native scheduler, so registration degrades honestly to a ready brief; the
  cadence/idempotency/off-switch methodology is delegated to the canonical skill.
---

# schedule-recurring-agent (Codex adapter)

This is a THIN Codex adapter. The canonical methodology — the self-contained idempotent brief, cadence
matching, per-run budget, escalation rules, and teardown/off-switch — lives in the root skill and is the
single source of truth.

## Apply the runtime map first

Read `codex-skills/.shared/codex-runtime.md` and apply it as the binding capability contract. For this
skill the relevant rows are **§8 Scheduling** and the **Claude-only** table.

- **Scheduling on Codex is not a native capability.** `RemoteTrigger` and `CronCreate` are
  **Claude-Code-only** and MUST NOT be presented as runnable Codex operations. Do not claim a routine was
  registered.
- The IMPLEMENTED Codex path is the honest capability ladder in
  `schedule-recurring-agent/scripts/validate-job.mjs`: `validate` checks the recurring-job schema; `create`
  dedups against the registry and — on Codex, which has no supported scheduler capability — returns
  **`created:false, registered:false, reason:'no-capability'`** with a **ready brief** for manual/other-platform
  registration (exit 3). It never fabricates a registration. Evidence: `bash scripts/test-scheduled-job.sh`.

So on Codex this skill produces a validated, idempotent, bounded **brief plus a ready-to-register
schedule spec** — it does not itself start a durable cloud routine or an in-session cron.

## Delegate to the canonical methodology

Apply the root **schedule-recurring-agent** skill (`schedule-recurring-agent/SKILL.md`) end to end:
build a self-contained idempotent brief, match cadence to how often the work arrives, bound every run,
define escalation for irreversible actions, and declare the teardown condition. Confirm with the user
before anything that would act unattended. Translate each Claude-only registration step to its honest
Codex outcome via the runtime map above.

## Output contract

Report the validated brief + schedule spec, and — on Codex — the honest `created:false` /
`reason:'no-capability'` result with the ready brief for manual registration. Never report a routine as
created when no supported capability exists.
