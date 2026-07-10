# Codex runtime capability map — the honest, implemented-only reference

This file is the **binding capability contract** every Codex adapter in `codex-skills/` applies. It maps
each runtime capability the collection relies on to the **exact file that implements it** and a **real
evidence command** (a test that already passes) that proves the behavior. It is normative in one
direction only: it describes **what is implemented today**, never an aspiration. If an adapter's prose
and this map disagree, this map (and the code + test it links) wins.

> **Honesty rule (non-negotiable).** A capability is listed as runnable ONLY when a real file implements
> it under Codex. A capability Codex cannot perform is listed with its **honest degraded outcome** —
> `blocked`, `gateNotRun`, `created:false`, or a **draft/ready brief** — NEVER an emulated success. No
> adapter may present a Claude-only mechanism (`Workflow()`, `ScheduleWakeup`, `RemoteTrigger`,
> `CronCreate`, native `/goal`+`/loop`) as Codex-runnable. Those appear here only in the **Claude-only**
> column, as the thing Codex explicitly does NOT have.

All evidence commands run from the repo root. Every one below is green as of this writing.

---

## Capability map (at a glance)

| Capability | Implemented path (Codex) | Honest outcome when unsupported | Evidence command |
|---|---|---|---|
| Codex executor CLI form | `autonomous-pipeline/scripts/lib/cli-contract.mjs` → `buildCodexArgv()` | usage error (exit 2) on any forbidden flag/sandbox | `node scripts/test-cli-contract.mjs` |
| Codex executor invocation | `autonomous-pipeline/scripts/lib/codex-executor.mjs` | `blocked` on preflight drift / off-schema output | `node scripts/test-codex-executor.mjs` |
| Fan-out / subagents | deterministic coordinator (`build-engine.mjs` + `git-workspaces.mjs`), budget-bounded | no native Codex fan-out primitive — bounded by `maxCodexCalls` + layer barrier | `node scripts/test-git-workspaces.mjs` |
| Workflow (multi-agent orchestration) | `autonomous-pipeline/scripts/pipeline.mjs` (deterministic CLI — the **replacement**) | — (Codex has no Workflow tool; the CLI is the substitute) | `node scripts/test-pipeline-cli.mjs` |
| Worktrees | `autonomous-pipeline/scripts/lib/git-workspaces.mjs` | error if git/base-SHA unavailable | `node scripts/test-git-workspaces.mjs` |
| Budgets / termination set | `autonomous-pipeline/scripts/lib/budget-ledger.mjs` | **rejects** a hard token ceiling (unsupported); observe-only tokens | `node scripts/test-budget-ledger.mjs` |
| User input / approval | `autonomous-pipeline/scripts/lib/authorization.mjs` | refusal (exit 3) if non-interactive / child context / drift | `node scripts/test-authorization.mjs` |
| Scheduling | `schedule-recurring-agent/scripts/validate-job.mjs` | **`created:false`** + ready brief (no capability on Codex) | `bash scripts/test-scheduled-job.sh` |
| Hooks | `hooks/hooks.json` (Codex events) | `systemMessage` notice / `decision:block` (strict) | `bash scripts/test-codex-hooks.sh` |
| Shell / edit gate | `hooks/hooks.json` matcher `Edit\|Write\|apply_patch` → `auto-test/scripts/guard-test-integrity.sh` | **blocks** (exit 2) a test-integrity violation | `bash scripts/test-codex-hooks.sh` |
| Skill invocation | Codex adapter → `delegate` → canonical `<skill>/SKILL.md` | — (a missing delegate fails validation) | `node scripts/validate-skills.mjs --surface codex` |
| Goals / convergence | `budget-ledger.mjs` `evaluate()` + pipeline-state `convergence-v1` | stops + reports open items (never fabricated green) | `node scripts/test-budget-ledger.mjs` |

---

## 1. The EXACT `codex exec` CLI form

**Implemented:** `autonomous-pipeline/scripts/lib/cli-contract.mjs` → `buildCodexArgv({ sandbox, cd,
schemaFile, outputLastMessage })`. Human spec: `autonomous-pipeline/references/cli-contract.md`.

The executor argv is built as a **`string[]` (never a shell string)**. Global flags come **before**
`exec`; the prompt is passed **only via stdin** (trailing `-`). Pinned shape:

```
codex --ask-for-approval never --sandbox <read-only|workspace-write> --cd <absolute-worktree>
      exec --ephemeral --ignore-user-config --json --output-schema <file> --output-last-message <file> -
```

Fail-closed: `--sandbox danger-full-access` and the whole `FORBIDDEN_CODEX_FLAGS` set
(`--dangerously-bypass-approvals-and-sandbox`, `--add-dir`, `--search`, `--skip-git-repo-check`,
`--ignore-rules`), any shell metacharacter/interpolation in a value, and a relative/`..` `--cd` all throw
`CliContractError` (exit 2). **No emulated success** — an unsafe request is a hard usage error.

**Evidence:** `node scripts/test-cli-contract.mjs`

## 2. Codex executor invocation (the adapter that actually spawns Codex)

**Implemented:** `autonomous-pipeline/scripts/lib/codex-executor.mjs`. Pinned to
`PINNED_CODEX_VERSION = 0.44.0`; preflight requires the local `codex` to expose every
`REQUIRED_CODEX_FLAGS` entry. A drifted/missing binary, a non-zero exit, a timeout, a leaked descendant,
a missing `--output-last-message` file, malformed JSON, or an off-schema final message all resolve to a
typed **`blocked`** result — never a fabricated green, never a fallback to a bypass flag.

**Evidence:** `node scripts/test-codex-executor.mjs`

## 3. Fan-out / subagents (honest: no native Codex fan-out primitive)

Codex has **no** Claude-style `Agent`/`Workflow` multi-agent fan-out, and this repo implements **no
`.toml` subagent runtime** (that integration is not built). What IS implemented is the **deterministic
coordinator's** own fan-out: within a plan layer, the build engine spawns one Codex executor **child
process per task**, each in a **distinct worktree** (structural isolation — no two tasks share a tree),
awaited together as a **layer barrier** (`Promise.all`), then integrated one-by-one.

**Implemented:** `autonomous-pipeline/scripts/lib/build-engine.mjs` (`runBuild` — concurrent-within-layer,
barrier between layers) + `autonomous-pipeline/scripts/lib/git-workspaces.mjs` (`createTaskWorktree`,
`verifyScope`, `quarantineWorktree`).

**Honest bound.** There is **no live "~6 concurrency cap"** enforced in the coordinator — a layer's
independent tasks run together. The real, enforced bound on total executor spawns is the budget's
`maxCodexCalls` (consumed one-per-spawn by `budget-ledger.reserve()`), plus the layer barrier and
per-task worktree isolation. The `fan-out-work` skill's `~min(16, cores−2)` concurrency figure is a
**Claude Agent/Workflow-runtime** property and does **not** apply to Codex; do not cite it for a Codex run.

**Evidence:** `node scripts/test-git-workspaces.mjs` (worktree isolation + scope) and
`node scripts/test-budget-ledger.mjs` (spawn cap via `reserve`).

## 4. Workflow REPLACEMENT — the deterministic pipeline CLI

Codex **cannot** select the Claude `Workflow()` tool (that is a Claude-Code-only orchestration primitive
— see **Claude-only** below). The Codex substitute is a **deterministic Node CLI**, not a Codex Workflow:

**Implemented:** `autonomous-pipeline/scripts/pipeline.mjs` (public entrypoint) over
`autonomous-pipeline/scripts/lib/pipeline-engine.mjs`. Five public verbs only (`PIPELINE_COMMANDS`):
`approve`, `start`, `resume`, `status`, `authorize`. One JSON object on stdout in `--json` mode; pinned
exit codes (`EXIT`/`EXIT_TABLE`: 0/2/3/4/5/6/7, with 1 reserved for an unexpected crash). This CLI owns
the DAG walk, checkpoints, worktrees, budget, and authorization deterministically — the model never
drives the loop.

**Evidence:** `node scripts/test-pipeline-cli.mjs` (grammar + dispatch), `node scripts/test-pipeline-e2e.mjs`.

## 5. Worktrees

**Implemented:** `autonomous-pipeline/scripts/lib/git-workspaces.mjs`. Owns worktree lifecycle
(`resolveBaseSha`, `createIntegrationWorktree`, `createTaskWorktree`, `verifyScope`,
`quarantineWorktree`, `cleanupWorktree`) at a recorded base SHA. It is **read-only toward refs** — an
`ALLOWED_GIT_SUBCOMMANDS` allowlist (`rev-parse`, `worktree`, `diff`, `ls-files`, `status`) makes it
structurally impossible to stage/commit/merge/rebase/reset. Untrusted ids and changed paths (plus their
resolved symlink targets) are checked for traversal / `.git` / out-of-scope escape **before** any result
can integrate; violations quarantine, they never merge.

**Evidence:** `node scripts/test-git-workspaces.mjs`, `node scripts/test-git-integration.mjs`.

## 6. Budgets / termination set (honest about tokens)

**Implemented:** `autonomous-pipeline/scripts/lib/budget-ledger.mjs`. The immutable termination set
(`TERMINATION_KEYS`: `doneCondition`, `maxCodexCalls`, `maxActiveWallMs`, `maxAttemptsPerTask`,
`maxAttemptsPerPhase`, `maxNoProgressBarriers`, `escalationTriggers`) is bound into a config hash at init
and refused if changed on resume. `reserve()` atomically refuses when a limit is exhausted (exit 5).

**Honest token stance — NO hard token ceiling.** The Codex CLI cannot bound tokens **before** a turn
(there is no pre-turn token-ceiling flag), so any requested hard ceiling
(`FORBIDDEN_TOKEN_KEYS`: `maxTokens`, `tokenCeiling`, `hardTokenCeiling`, …) is **rejected loudly** at
`normalizeLimits()`. Tokens are only **observed** from the Codex `--json` JSONL stream after the fact
(`parseObservedTokensFromJsonl`, `reportTokens`) and **reported, never enforced**. The map does not
pretend to hold a bound it cannot keep.

**Evidence:** `node scripts/test-budget-ledger.mjs`.

## 7. User input / approval (one-use capability + interactive operator)

**Implemented:** `autonomous-pipeline/scripts/lib/authorization.mjs`. Approval is a **one-use,
hash-bound capability**, minted only by an **interactive operator** in the **coordinator** context, and
consumed exactly once by a single-winner atomic rename:

- **Plan approval** (`issuePlanApproval` → `consumePlanApproval` at `start`) — bound to the raw plan +
  config + base SHA + target ref + engine version; minted only from the `prepared` window (before any
  executor exists), written coordinator-private `O_EXCL` mode-0600 so a child worktree never receives it.
- **Irreversible action** (`haltForAuthorization` → `issueActionCapability` → `consumeActionCapability`)
  — the run first durably **halts at `awaiting_authorization`** with zero live children; a fresh,
  action-scoped, TTL-limited capability bound to the evidence + a live checkpoint-revision is consumed
  immediately before the action. Drift since the halt makes the revision mismatch → refused.

Every refusal (`missing`, `expired`, `replayed`, `revoked`, `mismatched`, `symlinked`, `unsafe-mode`,
`child-issued`, `not-interactive`, `child-context`, `executor-active`, …) fails **before** the action
with a pinned exit code (3 preflight / 6 checkpoint). A **non-interactive / piped / executor / adapter**
invocation is **refused** — this is what stops an auto-chained approve→start. A crash after consume but
before observed completion resolves to `outcome_unknown` and is **never auto-retried**.

**Evidence:** `node scripts/test-authorization.mjs`.

## 8. Scheduling (honest capability ladder — `created:false` without a capability)

**Implemented:** `schedule-recurring-agent/scripts/validate-job.mjs`. `validate` enforces the recurring-job
schema (exit 2 on any missing field). `create` runs an **honest capability ladder**:

1. schema first (invalid → `created:false`, exit 2);
2. **dedup against the registry** (a known key → idempotent `created:false`, `reason:duplicate`, exit 0);
3. **capability check** — a verifiable id is minted **only** when a `SUPPORTED` capability
   (`RemoteTrigger` **or** `CronCreate`, both **Claude-Code-only**) **and** `--authorize` are present.

**On Codex there is no supported scheduler capability**, so `create` returns
**`created:false, registered:false, reason:'no-capability'`** with a **ready brief** for manual/other-platform
registration and exit 3. It **never fabricates** a `RemoteTrigger`/`CronCreate` registration on a platform
that has neither — it degrades and says so.

**Evidence:** `bash scripts/test-scheduled-job.sh`.

## 9. Hooks (Codex events; `exit-2` / `decision:block`)

**Implemented:** `hooks/hooks.json` — the Codex event wiring:

- `SessionStart` → `hooks/session-start-announce.sh` (resume announce; read-only).
- `PreToolUse` matcher `Bash` → `auto-build/scripts/guard-git-hygiene.sh` +
  `auto-ship/scripts/guard-ship-irreversibles.sh`.
- `PreToolUse` matcher **`Edit|Write|apply_patch`** → `auto-test/scripts/guard-test-integrity.sh`.
- `Stop` → `hooks/honest-stop.sh` + `hooks/session-end-gc.sh`.

Guards **block** by exiting **2** (stderr shown to the model). The Stop hook emits a **non-blocking notice
via the documented Codex `{"systemMessage":…}` field** by default (NOT the Claude `hookSpecificOutput`
key) and escalates to the real Codex Stop schema **`{"decision":"block","reason":…}`** only under
`ULPI_STOP_STRICT=1`. Outside a live `.ulpi/runs/*` run every hook is a NO-OP.

**Evidence:** `bash scripts/test-codex-hooks.sh`.

## 10. Shell / edit gate (`apply_patch`)

Codex edits arrive through `apply_patch` (and `Edit`/`Write`). The `PreToolUse` matcher
`Edit|Write|apply_patch` routes every edit through `auto-test/scripts/guard-test-integrity.sh`, which
**blocks (exit 2)** a test-integrity violation before the write lands. There is no bypass path — a
blocked edit is blocked, not silently applied.

**Evidence:** `bash scripts/test-codex-hooks.sh` (and `bash scripts/test-guards.sh`).

## 11. Skill invocation (`$skill` → delegate → canonical SKILL.md)

A Codex adapter is a thin `codex-skills/<adapter>/openai.yaml` whose **`delegate`** resolves to a real
canonical Claude skill at `<delegate>/SKILL.md` — that canonical skill is the single source of truth the
adapter applies. The validator's `codex` surface enforces that every adapter has an `openai.yaml`
(`name` == dir, `description`, `delegate`) and that the delegate exists; a **missing/dangling delegate
fails validation**. Until adapters land, `codex-skills/` is an empty-but-valid adapter tree (this file's
`.shared/` sibling `source-layout.md` is the binding topology contract).

**Evidence:** `node scripts/validate-skills.mjs --surface codex`.

## 12. Goals / convergence (deterministic, not native `/goal`)

Codex has **no** native `/goal`+`/loop` (that is Claude-only — see below). The Codex equivalent is the
**deterministic convergence conjunction**: `doneCondition` is always `convergence-v1`, evaluated by
`budget-ledger.evaluate()` against a progress fingerprint, escalation triggers, and the termination set.
When the run converges it stops green; when it exhausts a limit or hits a no-progress barrier it **stops
and reports the open items** (exit 5) — it never spins and never fabricates a green verdict to exit.

**Evidence:** `node scripts/test-budget-ledger.mjs`.

---

## Claude-only mechanisms — NOT Codex-runnable

These exist **only** on Claude Code and must never be presented as a Codex capability. An adapter that
needs the behavior routes to the Codex-implemented substitute in the map above.

| Claude-only mechanism | Why it is Claude-only | Codex substitute (implemented) |
|---|---|---|
| `Workflow()` tool | Claude Code multi-agent JS orchestration primitive | `autonomous-pipeline/scripts/pipeline.mjs` (§4) |
| `ScheduleWakeup` / native `/loop` | Claude self-paced session loop | the deterministic CLI + `resume` (§4/§12) |
| `RemoteTrigger` | Claude-Code-only durable cloud routine capability | `validate-job.mjs` degrades to `created:false` + brief (§8) |
| `CronCreate` | Claude-Code-only in-process cron capability | `validate-job.mjs` degrades to `created:false` + brief (§8) |
| native `/goal` + `/loop` | Claude native goal/loop compilation | `convergence-v1` + `budget-ledger.evaluate()` (§12) |
| `Agent` tool fan-out (`~min(16, cores−2)`) | Claude background/worktree agent runtime | coordinator per-task Codex children + worktrees (§3) |

An adapter that would otherwise reach for one of these on Codex MUST instead return the honest outcome of
its substitute — `blocked`, `gateNotRun`, `created:false`, or a draft/ready brief — and say so.
