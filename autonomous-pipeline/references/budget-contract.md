# Budget & Termination-Set Contract

The autonomous pipeline is bounded, never infinite. `scripts/lib/budget-ledger.mjs` owns that bound. It
does **not** re-implement a state store — it imports the one locked, atomic checkpoint store
(`checkpoint-resume/scripts/lib/checkpoint-store.mjs`) and keeps all budget state in a `budget` block
inside the **same** checkpoint file, so every budget mutation is serialized by the **same** mkdir lock and
is crash-atomic (tmp + rename). The stop exit code is pinned by `cli-contract.mjs` — `EXIT.BUDGET === 5`;
this module never invents an exit meaning.

## The immutable termination set

Bound into a config hash and into the checkpoint **at init** (`initBudget`), then refused thereafter:

| key | meaning |
| --- | --- |
| `doneCondition` | always `convergence-v1` — the `pipeline-state` convergence conjunction is the only done condition |
| `maxCodexCalls` | hard cap on total Codex executor spawns |
| `maxActiveWallMs` | hard cap on **active** wall time (paused-authorization time is excluded) |
| `maxAttemptsPerTask` | per-task attempt cap |
| `maxAttemptsPerPhase` | per-phase attempt cap |
| `maxNoProgressBarriers` | consecutive unchanged progress fingerprints tolerated before a stop |
| `escalationTriggers` | the **named** escalation conditions that force a stop |

All five numeric caps must be positive integers; `escalationTriggers` is an array of unique non-empty
strings (stored sorted). `computeConfigHash(limits)` is a stable, key-order-independent SHA-256 over the
normalized set — **any** change of **any** limit changes the hash.

### Immutability / resume safety

`initBudget(file, limits)`:
- **first call** writes the `budget` block (`created: true`).
- **same set again** (matching config hash) is idempotent — returns the existing block, **spend
  untouched**. This is the resume path.
- **any different set** (raised, lowered, or otherwise changed → different hash) is **refused** with a
  `BudgetError` (exit `USAGE`). This is how *resume cannot raise a limit* and *resume cannot erase spend*
  are jointly enforced: the only accepted re-init is the identical set, which never resets counters.

### Tokens: observed, never enforced (honesty)

The Codex CLI **cannot** bound tokens before a turn — there is no pre-turn token-ceiling flag. Therefore a
requested **hard token ceiling** is **rejected as unsupported**: `normalizeLimits` throws for any of
`maxTokens`, `tokenCeiling`, `maxTokenBudget`, `hardTokenCeiling`, `tokenLimit`, `maxTokensPerTurn`,
`maxTokensTotal`, `maxTokenSpend`. Token usage is only ever **observed** — `reportTokens` /
`parseObservedTokensFromJsonl` accumulate usage from the Codex `--json` JSONL stream for visibility. No
amount of observed tokens ever stops the run.

## Atomic reservation (the anti-oversubscription core)

Before **every** spawn the coordinator calls `reserve(file, { task, phase, callTimeoutMs })`. Under the
checkpoint lock, atomically:

1. If the run is durably **stopped**, or any relevant limit is exhausted (`max-codex-calls`,
   `max-attempts-per-task`, `max-attempts-per-phase`, `max-active-wall`), it **refuses** and makes **no
   state change** (`{ granted: false, reasons }`).
2. Otherwise it **consumes** one call + one task-attempt + one phase-attempt and **holds** a slice of the
   remaining active wall as an **open segment** (`{ granted: true, reservationId, childTimeoutMs }`).

`childTimeoutMs = min(callTimeoutMs, remainingActiveWall)` where
`remainingActiveWall = maxActiveWallMs − activeWallMs − Σ(open reserved slices)`. Because the
read-modify-write is serialized by the mkdir lock, **concurrent reservations across real processes can
never oversubscribe** — the (cap+1)th reservation always sees the counter at the cap and is refused.

### Settle, crash, reconcile

- `settle(file, reservationId, { actualWallMs, tokens })` — the child completed. Charges the **measured**
  wall **clamped to the reserved slice** (a call can never spend more wall than it reserved), removes the
  open segment, and accumulates any observed tokens. A missing measurement charges the full reserved slice
  (conservative).
- **Crash** — the child died without settling; its open segment persists in the checkpoint.
- `reconcileOpenSegments(file)` — called on **resume**. Every still-open segment is **conservatively
  charged its full reserved slice** (assume it ran to its timeout) and removed. This only ever **adds** to
  spend, so a crash-then-resume can never under-count, and resume can never erase spend.

### Paused-authorization time

Active wall is the **sum of charged reservation slices** — idle/paused time is inherently never counted.
`pauseForAuthorization(file)` is permitted **only at a durable safe boundary** (no open reservations) —
because we may only exclude time we can prove no child was consuming; it refuses (exit `BLOCKED`)
otherwise. `resumeFromAuthorization(file, { elapsedMs })` records the excluded paused time (`pausedMs`)
without charging it against `maxActiveWallMs`.

## Progress fingerprint & the durable stop

`progressFingerprint({ integrationHead, completedUnits, completedPhases, resolvedFindings,
validationSignature })` is a deterministic, order-independent hash of the run's real progress surface.

`evaluate(file, { fingerprint?, escalation? })` is the single budget-gate decision. It records the barrier
(when a fingerprint is given) and returns a stop decision when **any** of:

- an **exhausted limit** — `max-codex-calls`, `max-active-wall`, `max-attempts-per-task:<task>`,
  `max-attempts-per-phase:<phase>`;
- **`maxNoProgressBarriers`** consecutive **unchanged** fingerprints (`max-no-progress-barriers`);
- a **named escalation trigger** from the immutable set (an unknown trigger is refused, exit `USAGE`).

On stop it writes `budget.stopped` **durably** and returns
`{ stop: true, converged: false, exitCode: EXIT.BUDGET (5), reasons, safeBoundary }`. The budget gate
**never** asserts `converged: true` — convergence is `pipeline-state`'s job; the budget gate can only
force a non-converged stop.

Once stopped:
- `reserve` refuses (`{ granted: false, stopped: true }`);
- `assertNotStopped(file)` throws (exit `BUDGET`), the gate the coordinator uses to block **any**
  downstream execution, publication, or done-finalization.

The coordinator must honor a stop **at a safe boundary** — reconcile any open segments first
(`safeBoundary` reports whether reservations are still open) — then exit 5 with `converged: false` and run
no further work.

## Exit codes (from `cli-contract.mjs`)

A budget/no-progress/escalation stop is `EXIT.BUDGET === 5`. Config/immutability/unknown-trigger errors are
`EXIT.USAGE === 2`. A missing budget block or an unknown reservation is `EXIT.CHECKPOINT === 6`. A pause
refused mid-flight is `EXIT.BLOCKED === 4`.
