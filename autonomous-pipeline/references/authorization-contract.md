# Authorization Contract — capability-gated plan approval + irreversible actions

The single source of truth for the coordinator's two privileged transitions is
`../scripts/lib/authorization.mjs` (zero-dependency; imports only the shared checkpoint store and the
CLI contract's action list). This document is the human-readable spec; the module + `../../scripts/test-authorization.mjs` are the machine-enforced one. If they ever disagree, the module and its tests win.

Everything here is **fail-closed**: a missing, expired, replayed, revoked, mismatched, symlinked,
unsafe-mode, or child-issued capability — and any mint attempt while an executor is live — is a hard
refusal that fires **before** the privileged action, never a silently-accepted default.

---

## Trust model (read this first)

The security boundary is the **outer, user-run coordinator process** plus **sandbox isolation** of its
executor children. This controller is **not** designed to resist a same-UID adversary who can already
read and rewrite arbitrary files the user owns — that is explicitly out of scope. Within that boundary
it guarantees, against mistakes, drift, replay, auto-chaining, and sandboxed children reaching back:

- Capabilities are **coordinator-private** state (`O_EXCL`, mode `0600`) written to a dir that must live
  **outside every executor worktree**. A child worktree therefore receives neither writable issuance
  state nor capability material.
- Every capability is **one-use** and **hash-bound**; consuming it is a **single-winner atomic rename**.
- Minting requires an **interactive operator** in the **coordinator** context. This is the mechanism
  that prevents an auto-chained `approve→start`: a human must sit between mint and consume.

---

## Two capability kinds

`CAP_KINDS = ['plan', 'ship', 'deploy', 'publish', 'remote-merge']` — the plan approval plus the four
irreversible actions (reused from the CLI contract's `AUTHORIZE_ACTIONS`, so the lists can never drift).

### (1) Plan approval — gates `start`

Minted **only from the `prepared` window** (before any executor exists), by an interactive coordinator,
with no executor active. Bound to:

| Binding | Source |
|---|---|
| `planSha` | SHA-256 of the **raw** canonical plan (exact bytes) |
| `configSha` | SHA-256 of the run config **including its budget** |
| `intakeSha` | SHA-256 of the independently captured, write-once intake snapshot |
| `baseSha` | the recorded base commit |
| `targetRef` | the integration target ref |
| `engineVersion` | the executor engine version |
| `nonce` | a fresh per-issuance nonce |
| TTL | `expiresAt = issuedAt + ttlMs` |

`start` **consumes it exactly once** by presenting freshly-recomputed hashes; an edited plan, changed
intake snapshot, changed budget, moved base, different target/engine, or replayed nonce all mismatch.

### (2) Action capability — gates one irreversible action

An irreversible request first **durably halts** the run at `awaiting_authorization`
(`haltForAuthorization`), which **refuses unless there are zero live children** and records
`{ action, evidenceSha, checkpointRevision }`. A **fresh, action-scoped, TTL-limited** capability
(`issueActionCapability`) is then minted, bound to that evidence + checkpoint-revision hash (pulled
straight from the halt so it matches exactly) plus base/target/engine and a fresh nonce. It is
**consumed immediately before** the action (`consumeActionCapability`), which recomputes the
checkpoint-revision **live** — so any drift since the halt mismatches and refuses.

A **plan approval never satisfies an action capability**: different kind, different on-disk key,
different bindings.

---

## Lifecycle (on-disk, single-winner)

A capability's status is encoded in its filename suffix under `<capDir>/<run>.<kind>`:

```
.cap.json        issued      (created O_EXCL, mode 0600)
.consumed.json   consumed    (atomic rename issued→consumed = the one-use consume)
.completed.json  completed   (observed-complete: rename consumed→completed)
.revoked.json    revoked     (rename issued→revoked)
```

- **One per key.** Mint refuses if any capability for the key already exists in **any** stage. This is
  what makes a consumed / `outcome_unknown` capability non-retryable — it can never be re-minted.
- **Consume is a single-winner rename.** A replay or a concurrent second consumer loses the rename
  (`ENOENT`) → `replayed`.

---

## Refusal reasons (`REASONS`) — all fire before the action

| Reason | When |
|---|---|
| `missing` | no capability at the key |
| `expired` | `now ≥ expiresAt` (TTL elapsed) |
| `replayed` | already consumed/completed, or lost the consume race |
| `revoked` | the capability was revoked |
| `mismatched` | presented bindings' digest ≠ the bound digest (intake/plan/config/base/target/engine/nonce/evidence/revision) |
| `symlinked` | the capability file is a symlink or not a regular file (never followed) |
| `unsafe-mode` | the capability file is group/world accessible (mode `& 0o077`) |
| `child-issued` | the record's `issuerContext` is not `coordinator` |
| `not-interactive` | mint attempted without an interactive operator (piped / CI / non-TTY) |
| `child-context` | mint attempted from an executor/adapter context, or capDir inside a worktree |
| `executor-active` | mint or halt attempted while a child/executor is live |
| `wrong-state` | mint/consume from the wrong run status (plan ≠ `prepared`, action ≠ `awaiting_authorization`/wrong action) |
| `wrong-kind` | a stored record's kind differs from the lookup kind |
| `already-issued` | a capability for the key already exists (one-per-key) |
| `outcome-unknown` | reserved for the crash-after-consume reconciliation |

Refusals throw `AuthorizationError` carrying `.reason` and a pinned exit `.code` (default `3` =
preflight / approval-refusal; checkpoint I/O and outcome-unknown map to `6`).

---

## Crash semantics — `outcome_unknown`, never auto-retried

A crash **after consume but before observed completion** leaves a `.consumed.json` with no
`completedAt`. `reconcileCapability` reports `{ status: 'outcome_unknown', retryable: false }`. Because a
consumed capability can never be re-minted for the same key, the action is **never auto-retried** — a
human must decide. `completeCapability` records the observed outcome (`consumed→completed`) so a clean
run reconciles as `completed`, not `outcome_unknown`.

---

## API surface

```
markPrepared(checkpointFile)                         → { status:'prepared' }
haltForAuthorization({ checkpointFile, action, evidence, now? })
                                                     → { status, action, evidenceSha, checkpointRevision, liveChildren:0 }

issuePlanApproval({ capDir, run, rawPlan, config, intakeSha, baseSha, targetRef, engineVersion,
                    ttlMs, nonce?, interactive?, context?, checkpointFile?, worktreePaths?, now? })  → record
consumePlanApproval({ capDir, run, rawPlan, config, intakeSha, baseSha, targetRef, engineVersion, nonce, now? }) → { record, consumedAt }

issueActionCapability({ capDir, run, action, baseSha, targetRef, engineVersion,
                        ttlMs, nonce?, interactive?, context?, checkpointFile, worktreePaths?, now? })  → record
consumeActionCapability({ capDir, run, action, checkpointFile, baseSha, targetRef, engineVersion, nonce, now? }) → { record, consumedAt }

verifyCapability({ capDir, run, kind, present, now? })   → { ok, record?, reason? }   (pure read)
completeCapability({ capDir, run, kind, outcome?, now? })
revokeCapability({ capDir, run, kind, reason?, now? })
reconcileCapability({ capDir, run, kind })               → { status, retryable:false, ... }

assertCapabilityDirIsolated(capDir, worktreePaths)  isInteractiveOperator(env?, streams?)  detectContext(env?)
executorActive(doc)  checkpointRevisionOf(doc)  contentSha(x)  digestBindings(bindings)
```

`now` is an injectable epoch-ms clock (default `Date.now()`) so TTL/expiry is deterministically testable.
`interactive`/`context` accept explicit overrides; by default they are probed from the TTY/env
(`ULPI_NONINTERACTIVE`, `CI`, `CODEX_SANDBOX`, `ULPI_ROLE`).
