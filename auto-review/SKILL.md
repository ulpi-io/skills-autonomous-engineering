---
name: auto-review
version: 0.1.0
description: |
  Review a change across every dimension at once, then keep only the findings that survive an adversarial
  check — autonomously. It fans out independent reviewers over the diff (correctness, security,
  performance, maintainability/readability, test adequacy, API/contract & compatibility), dedups their
  findings, and puts each through a majority-refute verification so false positives never reach you or
  drive a fix. Survivors come back severity-labeled and actionable (file:line, why, suggested fix), and —
  if you ask — a bounded fix loop resolves the confirmed blockers. It fails closed: a dimension that
  didn't actually run is reported as a gap, never as "clean". This is the REVIEW phase. Composes
  fan-out-work (dimensions), adversarial-verify (confirm findings), converge-loop (optional fix), and
  checkpoint-resume.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Grep
  - Glob
  - Agent
  - Workflow
disable-model-invocation: true
user-invocable: true
effort: high
argument-hint: "[scope — a diff/branch/PR, or path] (default: the current branch diff)"
arguments:
  - scope
when_to_use: |
  Use before merging any change, or to audit a module/branch — when you want a multi-axis review whose
  findings are verified real, not a raw model dump full of false positives. Do NOT use to write the code
  (auto-build) or to make behavior-neutral cleanups (auto-simplify); and pass '--fix' intent only when you
  want the confirmed blockers resolved in place, otherwise it reports and stops.
---

<EXTREMELY-IMPORTANT>
An unverified review is noise that wastes attention and drives bad fixes. Non-negotiable:
1. EVERY FINDING IS VERIFIED BEFORE IT COUNTS. Each raw finding passes through adversarial verification
   (skeptics try to REFUTE it with the actual code) — only survivors are reported or fixed. A plausible-
   but-wrong finding must never reach the user or trigger an edit.
2. FAIL CLOSED ON COVERAGE. A review dimension that didn't actually run (agent died/empty) is reported as
   a GAP, never silently treated as "no findings there". "Clean" means every dimension ran and found
   nothing surviving — not that some dimensions were skipped.
3. SEVERITY IS HONEST AND CALIBRATED. Label findings (Blocker / Concern / Nit / FYI). Don't inflate a nit
   into a blocker or bury a real blocker as a nit. The severity drives what the user must act on.
4. FIXES ARE OPT-IN AND SCOPED. Only apply fixes when asked; fix only CONFIRMED blockers/concerns, each a
   minimal change, re-verified. Never smuggle unrelated refactors into a review-fix.
5. NEVER FABRICATE A CLEAN VERDICT. Surviving findings are surfaced as-is. A review that found real issues
   is reported with them, never rounded up to "looks good".
</EXTREMELY-IMPORTANT>

# Auto Review

## Overview

Get a staff-engineer-grade review that's both broad (every dimension in parallel) and trustworthy (every
finding survived a refutation attempt). The parallelism gives coverage; the adversarial gate gives
signal — you get a short list of verified, severity-labeled, actionable findings instead of a long list
you have to triage for hallucinations.

## Inputs

- `$scope`: the diff/branch/PR or path to review (default: the current branch diff). Append the
  literal `--fix` to authorize resolving CONFIRMED blockers in place after the review.

## Phase 0: Scope and baseline

- Resolve scope (`$scope` — the branch/PR diff by default; a path/module otherwise). Get the actual diff
  (`git diff <base>...HEAD`) and the changed files.
- Note the change size — an oversized diff (≫ a few hundred lines) is itself a finding (hard to review,
  should be split); say so.
- Open a `checkpoint-resume` run.

**Success criteria:** the exact diff + changed files are known; change-size noted.

## Phase 1: Fan out the review dimensions

Launch one reviewer per dimension over the diff (`fan-out-work`), each an independent lens with the actual
code in hand:

- **correctness** — logic errors, edge/error paths, off-by-one, null/empty, concurrency/races, wrong
  assumptions;
- **security** — trust boundaries, injection, authz, secrets, unsafe deserialization, untrusted input;
- **performance** — obvious hotspots, N+1s, needless allocations, blocking calls (measurement-gated
  claims — flag, don't assert a speedup);
- **maintainability/readability** — naming, structure, duplication, complexity, intent clarity;
- **test adequacy** — are the new behaviors covered by meaningful, non-vacuous tests? gaps?
- **API/contract & compatibility** — public interface changes, backward compatibility, error semantics,
  Hyrum's-Law surface.

Each reviewer returns structured findings (file:line, issue, severity, suggested fix, a concrete failure
scenario).

**Success criteria:** every dimension ran (or its failure is recorded as a gap); raw findings collected.

## Phase 2: Dedup + adversarially verify (the signal gate)

- **Dedup** the raw findings across dimensions (same file:line + same issue → one), keeping the highest
  severity and merging rationale.
- **Verify each** with `adversarial-verify`: skeptics get the real code and try to REFUTE the finding
  (does the bug actually occur? build the input; is the "vulnerability" reachable?). Scale skeptics to
  severity (a blocker gets a stronger panel). Only survivors are kept; refuted findings go to a rejection
  ledger (reported, so you see what was filtered).

**Success criteria:** a deduped list of VERIFIED findings, each severity-labeled; rejected findings logged.

## Phase 3: Report — or, if asked, fix the blockers (bounded)

- **Report** (default): the verified findings by severity, each with file:line, why, and a suggested fix;
  plus coverage (which dimensions ran) and the rejection ledger. Fail closed — name any dimension that
  didn't run.
- **Fix** (only on `--fix` intent): run `converge-loop` over the CONFIRMED blockers/concerns — one minimal
  fix per finding, re-verify the finding is resolved and no regression introduced, until the confirmed set
  is clear or the loop bounds out. Nits/FYIs are not auto-fixed. Update the checkpoint per finding.

**Success criteria:** the user gets verified findings (and, if requested, the confirmed blockers resolved
in place with no regressions); coverage and rejections are honest.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The model listed 30 findings, report them all." | Many are false positives. Unverified findings waste attention and drive bad edits. Verify first; report survivors. |
| "One reviewer pass covers everything." | A single lens misses the axes it isn't looking through. Fan out the dimensions; each catches what the others can't. |
| "This dimension's agent came back empty — no issues there." | Empty may mean it didn't run. Fail closed: an empty/dead dimension is a gap, not a clean bill. |
| "It's probably exploitable, mark it a blocker." | "Probably" isn't a finding. Have skeptics build the actual reachable path, or downgrade it. |
| "While fixing, I'll also refactor this nearby code." | A review-fix touches only the confirmed finding. Unrelated refactors belong in their own change. |
| "Found real issues but the code mostly looks good — call it approved." | A change with surviving blockers is not approved. Report the blockers; don't round up. |

## Red Flags

- Findings reported without any verification step.
- A "clean" verdict where one or more dimensions silently didn't run.
- Severity inflation (nits as blockers) or burial (blockers as nits).
- Fixes applied for unconfirmed or nit-level findings, or bundled with unrelated refactors.
- A huge diff reviewed without noting it should be split.
- The rejection ledger hidden (you can't see what was filtered and why).

## Guardrails

- Never report or fix an unverified finding — adversarial-verify first.
- Never treat a non-running dimension as clean; fail closed and name the gap.
- Never inflate/bury severity; label honestly.
- Never auto-fix beyond confirmed blockers/concerns; keep fixes minimal and re-verified.
- Never fabricate an approving verdict over surviving findings.

## When To Load References

- `references/review-workflow.js` — the RUNNABLE Workflow for Phases 1–2: one reviewer per dimension →
  dedup (a genuine barrier) → majority-refute skeptic panel per finding → returns `{ clean, confirmed,
  unverified, rejected, coverage }` — fail-closed on any dimension that didn't run AND on any skeptic
  panel that died below quorum (those findings come back `unverified`, kept open, never dropped). Launch via the Workflow tool
  with `{ root, diffCmd }`; prefer it over hand-orchestrating the fan-out.
- `fan-out-work` (skill) — parallel per-dimension review over the diff.
- `adversarial-verify` (skill) — the per-finding refutation gate (Phase 2) — the core signal mechanism.
- `converge-loop` (skill) — the optional bounded fix loop for confirmed blockers.
- `checkpoint-resume` (skill) — durable review/fix state.

## Output Contract

Report:

1. scope + diff size (flag if it should be split); dimensions that ran (coverage — fail closed on gaps)
2. verified findings by severity (Blocker / Concern / Nit / FYI): file:line, issue, failure scenario,
   suggested fix
3. rejection ledger — findings refuted by verification (so filtering is visible)
4. if `--fix`: confirmed blockers resolved (each re-verified, no regressions) vs. left for the user
