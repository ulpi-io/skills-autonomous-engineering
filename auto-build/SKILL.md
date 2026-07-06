---
name: auto-build
version: 0.1.0
description: |
  Implement a whole DAG plan autonomously — one approved pass, one clean rollback point per task, never
  building on a broken base. It requires a spec + plan and a clean git baseline, takes a SINGLE human
  approval of the plan, then walks the DAG layer by layer: for each task it implements on an isolated
  worktree branch test-first (RED → GREEN), integrates the slice onto the working branch, reviews the
  integrated change, runs a bounded fix loop until the task passes, and commits it individually — so any
  point is a clean rollback. It follows the dependency graph strictly (a task builds only once its deps
  integrate), checkpoints every task so it resumes exactly where it stopped, and STOPS-and-asks on
  unfixable failures, ambiguity, or irreversible steps rather than pushing through. This is the BUILD
  phase. Composes fan-out-work (per layer), converge-loop (per-task fix), adversarial-verify (per-task
  review), checkpoint-resume, and budget-guard.
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
argument-hint: "<plan path, or the feature to build (will look for .ulpi/plans/*); 'resume' to continue>"
arguments:
  - plan
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: |
            for p in "${CLAUDE_PLUGIN_ROOT:-/nonexistent}/auto-build/scripts/guard-git-hygiene.sh" \
                     "${CLAUDE_PROJECT_DIR:-.}/.claude/skills/auto-build/scripts/guard-git-hygiene.sh" \
                     "${CLAUDE_PROJECT_DIR:-.}/.agents/skills/auto-build/scripts/guard-git-hygiene.sh" \
                     "$HOME/.claude/skills/auto-build/scripts/guard-git-hygiene.sh" \
                     "$HOME/.agents/skills/auto-build/scripts/guard-git-hygiene.sh"; do
              [ -f "$p" ] && AUTO_GUARD_ALWAYS=1 exec bash "$p"
            done; exit 0
when_to_use: |
  Use once a spec + plan exist and you want plan+build collapsed into one approved, autonomous pass that
  implements every task test-driven and individually committed. Do NOT use without a plan (run auto-plan
  first), to write a spec/plan (auto-spec/auto-plan), or on a protected branch without confirmation. It
  spawns many agents across rounds — it is explicit-user-only.
---

<EXTREMELY-IMPORTANT>
This drives real, unattended code writing across many tasks. Non-negotiable:
1. ONE HUMAN GATE: approve the plan. After an unambiguous approval, run autonomously — but that approval
   is the ONLY blanket authorization. Irreversible/ambiguous/unfixable situations still STOP and ask.
2. CLEAN BASELINE FIRST. Require a clean git tree (only expected planning artifacts uncommitted). Per-task
   commits must never absorb unrelated local work, or the clean-rollback guarantee breaks.
3. ONE SLICE AT A TIME, EACH ITS OWN COMMIT. Implement, test, integrate, review, fix, commit — per task.
   Stage only that task's files (never `git add -A` blindly). Any commit is a clean rollback point.
4. FOLLOW THE DAG — NEVER BUILD ON A BROKEN BASE. A task builds only once ALL its `dependsOn` are actually
   INTEGRATED on the working branch. A task whose dependency never landed is `dep_blocked` (pointed at the
   root), never built anyway.
5. TEST-DRIVEN, FAIL CLOSED. Every task earns a failing-then-passing test and a green slice-scoped
   validate before it's `done`. Never mark a task done on a red validate; never weaken/skip tests to go
   green (that's faking the gate).
6. STOP AND ASK — do not push through — on: a test/build that won't go green without an obvious fix; a
   spec ambiguity or a decision the spec doesn't cover; or a high-risk/irreversible step (auth/permission
   changes, destructive migrations, payments, deletions, deploys, anything touching secrets, anything you
   can't `git revert`).
7. ISOLATE PARALLEL WRITERS. Tasks in a layer run in separate worktrees; integration is a serialized
   merge onto the working branch that also removes each merged worktree. Never two agents writing the
   working tree at once.
8. RESUME IS DURABLE. On resume, read the checkpoint and rebuild only tasks not `done` — never redo
   integrated work, never overwrite the checkpoint with a fresh pending doc.
</EXTREMELY-IMPORTANT>

# Auto Build

## Overview

Collapse plan → build into a single approved, autonomous pass that implements every task the disciplined
way — test-first, integrated, reviewed, individually committed — while the DAG guarantees nothing is built
before its dependencies land and the checkpoint guarantees a stop is always resumable. It removes the human
stepping *between* tasks, not the verification: every task still earns a passing test and its own commit.

## Phase 0: Preflight — spec, plan, clean baseline, working branch

- Resolve the plan (`$plan`, or newest `.ulpi/plans/*`); validate its shape (tasks with id / write scope /
  validate, acyclic `layers` that respect `dependsOn`). No plan → route to `auto-plan`. Malformed/cyclic
  plan → STOP (it would build on a broken base).
- Confirm `root` is a git work tree with a committed `workingBranch`; never build on a protected branch
  without explicit confirmation.
- Require a CLEAN baseline: `git status --porcelain` shows only expected planning artifacts
  (`.ulpi/spec/*`, `.ulpi/plans/*`). Anything else → stop and ask the user to commit/stash.
- **Read `.ulpi/learnings.md` if present** and fold relevant entries into the engineer briefs — a
  lesson the machine already paid for (a flaky service, a validate footgun, a boundary that bites)
  must reach the agent actually doing the work.
- Declare the run's budget/caps with `budget-guard` (max fix iterations per task, concurrency cap,
  token/wall-clock ceiling). Create the `checkpoint-resume` file with one unit per task. On **resume**,
  load the existing checkpoint and skip `done` tasks.

**Success criteria:** a valid plan, a clean git baseline on a confirmed branch, budget + checkpoint set.

## Phase 1: One approval gate

Present the full plan (tasks, layers, what each touches). Wait for an UNAMBIGUOUS affirmative ("approve",
"go", "yes"); treat hedges ("looks reasonable", "I guess") as NOT approved. This is the single human gate.
If the plan was just generated, commit it as one preparatory commit so it doesn't bleed into task 1.

**Success criteria:** explicit approval recorded; planning artifacts committed separately.

## Phase 2: Walk the DAG — layer by layer

For each layer in topological order (barrier between layers), build its tasks — in parallel across
worktrees, capped by `fan-out-work`. Per task, run the build contract (`references/build-contract.md`):

1. **Gate on deps** — all `dependsOn` integrated? else `dep_blocked` (point at the root), skip.
2. **Implement (isolated)** — a fresh worktree + task branch; RED (a failing test for the behavior) →
   GREEN (minimal code) → REFACTOR; stay inside the task's write scope.
3. **Integrate** — a serialized merge of the task branch onto the working branch, removing the merged
   worktree. Integration is merge-only; it does not run the whole-workspace validate.
4. **Review** — `adversarial-verify` the integrated slice against ITS acceptance criteria (slice-scoped:
   an unmet whole-codebase invariant a LATER task owns is an observation, not a block on this slice).
   Skippable only if the user disabled per-task review.
5. **Fix loop** — `converge-loop` (bounded, `MAX_FIX`≈3) on findings inside the task's write scope until
   the slice's validate is green; else mark `blocked` with the reason (don't spin).
6. **Commit + checkpoint** — one commit for the task's files + its status; mark the unit `done`.

Update the checkpoint as each task reaches its terminal state.

**Success criteria:** every task in the layer is `done`, `blocked`, or `dep_blocked` — each integrated
task test-passing and individually committed; the barrier holds before the next layer.

## Phase 3: Stop-and-ask triggers (throughout)

Halt the autonomous pass and ask the user — do not push through — when:

- a task's test/build won't go green without an obvious fix (surface the failure + diagnosis);
- the spec is ambiguous or a task needs a decision the spec doesn't cover;
- a task is high-risk/irreversible (see rule 6) — get explicit sign-off before continuing.

After the user resolves it, re-invoke to resume from the next pending task.

**Success criteria:** risky/ambiguous/unfixable situations reach the user, not a guessed-through commit.

## Phase 4: Final validate + report

Once the DAG is walked, run the whole-workspace `validate` ONCE on the integrated tree — the load-bearing
end-state gate (slices can each pass yet break the merged tree). Then report per Output Contract: tasks
done/blocked/dep_blocked, tests added, commits, the final validate result, and anything escalated. Fail
closed: a red final validate is never reported as a clean build.

**Success criteria:** the integrated tree's validate result is known and reported honestly; the checkpoint
reflects the final state.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Approval means I can push through anything now." | Approval authorizes the PLAN, not irreversible surprises. Destructive/ambiguous steps still stop and ask. |
| "I'll `git add -A` to save time." | That absorbs unrelated work into a task's commit and breaks clean rollback. Stage only the task's files. |
| "Dependency isn't integrated yet, but I'll build anyway and reconcile later." | That's building on a broken base. `dep_blocked` it; don't construct on a missing migration/route/symbol. |
| "The slice validate is red but it's a pre-existing failure." | Then classify it as pre-existing and say so — don't silently mark the task done on red, and don't discard correct work either. |
| "This task is drowning the review in whole-codebase gaps." | Per-task review is slice-scoped. Attribute end-state gaps to the owning task as observations; don't block the current slice. |
| "One big commit at the end is simpler." | It destroys per-task rollback and hides which task broke what. One commit per task. |

## Red Flags

- A task marked `done` with a red slice validate, or with a test skipped/weakened to pass.
- `git add -A` / commits mixing multiple tasks' files.
- A task built while a `dependsOn` is still pending/blocked.
- An irreversible action taken inside the pass with no stop-and-ask.
- Two agents writing the working tree without worktree isolation.
- A resume that rebuilt already-integrated tasks (checkpoint ignored/overwritten).
- A red final workspace validate reported as a clean build.

## Enforcement (deterministic, not prose)

While this skill is active, a skill-scoped PreToolUse hook runs `scripts/guard-git-hygiene.sh` on
every Bash call: `git add -A/./--all`, `commit -a/--all`, `reset --hard`, and `clean -f` are BLOCKED
at the tool layer (token-parsed — `--amend` and commit-message contents never false-positive). The
clean-rollback contract is enforced by machinery, not by asking nicely. Rules 2–3 above are therefore
not aspirational.

## Guardrails

- One human gate (plan approval); everything irreversible/ambiguous/unfixable still escalates.
- Clean baseline required; one commit per task; stage only that task's files.
- Follow the DAG; never build on un-integrated dependencies; never ship/mark-done on a red validate.
- Test-driven every task; never weaken/skip tests to go green.
- Isolate parallel writers; serialize integration; prune merged worktrees.
- Durable resume: skip `done`, never overwrite the checkpoint.
- Fail closed on the final validate.

## When To Load References

- `references/build-contract.md` — the per-task contract: worktree/branch, RED→GREEN→REFACTOR, integrate
  (merge + worktree removal), slice-scoped review, the bounded fix loop, and the task-exit gate.
- `converge-loop` (skill) — the bounded per-task fix loop.
- `adversarial-verify` (skill) — the per-task slice review.
- `fan-out-work` (skill) — parallel, capped, isolated per-layer task execution.
- `checkpoint-resume` (skill) — durable per-task state + skip-done resume.
- `budget-guard` (skill) — the run-level caps and escalation contract.

## Output Contract

Report:

1. plan built + working branch; the single approval recorded
2. per task: done / blocked / dep_blocked (with reasons), tests added, the commit
3. the final whole-workspace validate result (green/red — honest)
4. anything escalated to the user (unfixable / ambiguous / irreversible)
5. checkpoint file path (durable, resumable record)
