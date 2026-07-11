---
name: auto-ship
version: 0.1.1
description: |
  Use when a change is already built, tested, and reviewed and you want it taken to shippable — release gates
  run, changelog/version/docs prepared, PR opened or a rollout staged. Triggers on "ship it", "cut a release",
  "open the PR", "prepare the deploy". Explicit-user-only; never deploys anything irreversible without human
  sign-off.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
  - Workflow
disable-model-invocation: true
user-invocable: true
effort: high
argument-hint: "[what to ship — a branch/feature] (default: the current branch)"
arguments:
  - target
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: |
            for p in "${CLAUDE_PLUGIN_ROOT:-/nonexistent}/auto-ship/scripts/guard-ship-irreversibles.sh" \
                     "${CLAUDE_PROJECT_DIR:-.}/.claude/skills/auto-ship/scripts/guard-ship-irreversibles.sh" \
                     "${CLAUDE_PROJECT_DIR:-.}/.agents/skills/auto-ship/scripts/guard-ship-irreversibles.sh" \
                     "$HOME/.claude/skills/auto-ship/scripts/guard-ship-irreversibles.sh" \
                     "$HOME/.agents/skills/auto-ship/scripts/guard-ship-irreversibles.sh"; do
              [ -f "$p" ] && AUTO_GUARD_ALWAYS=1 exec bash "$p"
            done; exit 0
when_to_use: |
  Use when a change is built, tested, and reviewed and you want it prepared for release — gates run,
  release artifacts written, PR opened / rollout staged. Do NOT use to build or fix (auto-build) or to
  review (auto-review); and never let it perform an irreversible deploy without explicit human sign-off.
  It touches release/deploy surfaces — it is explicit-user-only.
---

<EXTREMELY-IMPORTANT>
Shipping is where fabricated-clean verdicts and skipped gates do real damage. Non-negotiable:
1. GATES FAIL CLOSED. A configured gate that did not actually run (final validate didn't execute, review
   was skipped, an audit died) is a BLOCKER, never "clean". "Ready to ship" means every gate ran and
   passed — not that some were skipped.
2. THE FINAL VALIDATE IS LOAD-BEARING. Run the whole-suite validate on the integrated release state; a
   red or unrun validate blocks the ship, full stop. "Should pass" is not a pass — run it, read the exit.
3. HUMAN SIGN-OFF ON IRREVERSIBLE STEPS. Deploys, destructive migrations, publishing a release, anything
   you can't cleanly roll back → STOP and get explicit approval. Preparing artifacts is autonomous;
   pulling the irreversible trigger is not.
4. ROLLBACK BEFORE ROLLOUT. Anything risky ships behind a rollback path (feature flag, revert plan,
   staged rollout, migration back-out). No rollback path → not ready.
5. RELEASE NOTES ARE GROUNDED. The changelog/notes describe the ACTUAL changes (from the diff/commits),
   not aspirational or invented ones. Never fabricate a clean verdict or a change that didn't happen.
6. FASTER IS SAFER, IN SMALL INCREMENTS. Prefer small, flagged, reversible releases over a big-bang deploy.
</EXTREMELY-IMPORTANT>

# Auto Ship

## Overview

Get a change from "verified" to "released" the disciplined way: run the pre-launch gate honestly (fail
closed on anything that didn't run or didn't pass), assemble grounded release artifacts, open the PR or
stage the rollout with a rollback path, and hand the irreversible deploy decision to a human. The value is
a ship that's provably ready — not one that looks ready because gates were skipped.

## Phase 0: Preflight — scope, state, gate the "ready" claim

- Resolve scope (`$target` — the current branch by default) and the changes to ship (diff + commits).
- Confirm the state: a clean tree on the right branch, the build's checkpoint (if from `auto-build`) shows
  no blocked/dep_blocked tasks.
- Open a `checkpoint-resume` run; declare the ship budget/escalation points with `budget-guard`.

**Success criteria:** the change set + branch are known; upstream build state is clean (or gaps noted).

## Phase 1: The pre-launch gate (fail closed)

Run the standing readiness gate; a gate that didn't run or didn't pass is a BLOCKER:

- **Final validate** — the whole-suite typecheck+lint+test on the integrated state. RED or unrun → block.
- **Review clean** — confirmed-blocker findings from `auto-review` are resolved (or run it now). Open
  blockers → block.
- **Security** — untrusted input / auth / data handling reviewed; no exposed secrets; deps audited.
- **Observability** — logs/metrics/traces exist for the new critical paths (you can answer "is it working
  in prod?").
- **Rollback** — a rollback path exists for anything risky (flag, revert, staged rollout, migration
  back-out).
- **Docs** — user-visible/API changes documented; ADR recorded for notable decisions.

Use `adversarial-verify` on the aggregate "ready to ship" claim: skeptics try to find a gate that's
green-in-name-only. Report each gate's real status (ran + passed / failed / didn't run).

**Success criteria:** every gate's true status is known; any unrun/failed gate is surfaced as a blocker,
not hidden.

## Phase 2: Prepare the release artifacts

With gates green, assemble the release (autonomous — no irreversible action yet):

- **Atomic commits** — clean, scoped commit history (already per-task from `auto-build`); no `git add -A`
  grab-bags.
- **Version bump** — per the project's scheme (semver); grounded in the change's nature (fix/feat/breaking).
- **Changelog / release notes** — generated from the ACTUAL commits/diff, user-facing and honest; breaking
  changes called out with migration notes.
- **Docs** — finalize any user/API docs the change requires.

**Success criteria:** version, changelog, and docs are prepared and grounded in the real changes.

## Phase 3: Open the PR / stage the rollout — human-gated deploy

- **PR path** (default): push the branch and open a PR via `gh` with the generated title/body (summary,
  test evidence, gate results, rollback plan). This is safe/reversible — autonomous.
- **Rollout path** (if deploying): present the staged plan — feature flag first, incremental exposure,
  monitoring to watch, and the rollback trigger. The DEPLOY itself is gated: STOP and get explicit human
  sign-off (`AskUserQuestion`) before any irreversible step. After deploy (if approved), confirm the
  monitoring signal and keep the rollback ready.

**Success criteria:** the PR is open (or the rollout staged); no irreversible step taken without explicit
approval; rollback is in place.

## Phase 4: Report

Close the checkpoint and report: gate results (each ran+passed, or the blocker), release artifacts
prepared, the PR link / rollout status, the rollback path, and anything awaiting human sign-off.

**Success criteria:** an honest ship report; nothing irreversible done unilaterally; blockers (if any)
clearly listed.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Review was skipped but the code looks fine — ship it." | A skipped gate is a blocker, not a pass. Run it or don't call it ready. |
| "The validate will pass, no need to run it before shipping." | "Will pass" is not "passed". The final validate is load-bearing — run it and read the exit code. |
| "This deploy is low-risk, I'll just do it." | Irreversible steps need human sign-off regardless of your confidence. Prepare autonomously; deploy on approval. |
| "We can add the rollback plan later." | Later is after it broke. No rollback path means not ready to ship. |
| "I'll write nice release notes covering what we intended." | Notes describe what actually changed, from the diff — not intentions. Ground them. |
| "Big-bang deploy is simpler than a flag." | Big-bang maximizes blast radius. Small, flagged, reversible is faster to recover — which is safer. |

## Red Flags

- "Ready to ship" while a gate didn't actually run (validate/review/audit skipped but counted clean).
- A final validate that was assumed green, not executed.
- An irreversible deploy/migration/publish done without explicit sign-off.
- Risky change shipped with no rollback path.
- Release notes mentioning changes not in the diff (or omitting breaking changes).
- A grab-bag commit (`git add -A`) in the release history.

## Enforcement (deterministic, not prose)

While this skill is active, a skill-scoped PreToolUse hook runs `scripts/guard-ship-irreversibles.sh`
on every Bash call: plain `git push --force` (without `--force-with-lease`) and `git push --delete`
are BLOCKED at the tool layer — the "human sign-off on irreversible steps" contract is enforced by
machinery. The deploy itself remains human-gated by process (Phase 3).

## Guardrails

- Never treat a skipped/unrun gate as clean; fail closed.
- Never call the final validate passed without running it.
- Never take an irreversible step (deploy/migrate/publish) without explicit human approval.
- Never ship risky change without a rollback path.
- Never write release notes that aren't grounded in the actual changes.
- Prefer small, flagged, reversible releases over big-bang.

## When To Load References

- `adversarial-verify` (skill) — stress the aggregate "ready to ship" claim to catch green-in-name gates.
- `auto-review` (skill) — run/finish the review gate if it hasn't been.
- `checkpoint-resume` (skill) — durable ship-run state.
- `budget-guard` (skill) — the escalation contract for the human-gated deploy.

## Output Contract

Report:

1. pre-launch gate — each gate's true status (ran+passed / failed / didn't run → blocker)
2. release artifacts — version bump, changelog/notes (grounded), docs
3. PR link or staged rollout plan + the rollback path
4. anything awaiting human sign-off (irreversible steps) and any remaining blockers
