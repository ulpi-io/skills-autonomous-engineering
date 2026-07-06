---
name: auto-spec
version: 0.1.0
description: |
  Turn a raw feature request into a grounded, TESTABLE spec — autonomously. It recons the real repo and
  domain to ground every claim, drafts a spec (objectives, user-visible behavior, acceptance criteria,
  explicit non-goals, constraints, interfaces, risks), then runs a completeness-critic loop that
  adversarially hunts for gaps, ambiguity, and untestable criteria and fixes them until the spec is
  stable. Every acceptance criterion it emits is measurable (you could write a test for it); every
  requirement is grounded in the repo or flagged as an assumption — no invented requirements, no phantom
  paths. It writes `.ulpi/spec/<name>.md` and is the DEFINE phase that feeds auto-plan. Composes
  fan-out-work (recon), adversarial-verify (the critic), converge-loop (until-stable), and
  checkpoint-resume.
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
argument-hint: "<what to build — the feature/product/change request>"
arguments:
  - request
when_to_use: |
  Use at the start of any new feature, product, or significant change, when you need a written spec before
  planning or code — especially when the request is broad and needs grounding + tightening. Do NOT use to
  plan HOW to build (that's auto-plan) or to write code; and do NOT invent a spec for a request so vague
  it needs a product decision first — ask the few blocking questions, then spec.
---

<EXTREMELY-IMPORTANT>
A spec is a contract; a vague or invented one poisons everything downstream. Non-negotiable:
1. GROUND EVERY REQUIREMENT. Each requirement is tied to the actual repo/domain or explicitly marked an
   ASSUMPTION. Never invent requirements, file paths, endpoints, or constraints to fill a gap — a phantom
   in the spec becomes a phantom in the plan and the code.
2. EVERY ACCEPTANCE CRITERION MUST BE TESTABLE. If you can't state how it would be verified (a test, a
   measurable threshold, an observable behavior), it isn't an acceptance criterion — sharpen it or cut it.
3. SCOPE HAS EXPLICIT NON-GOALS. A spec that only says what's in-scope invites scope creep. State what is
   deliberately OUT.
4. SURFACE, DON'T GUESS. Genuine ambiguity that changes what gets built is a STOP-and-ask (bounded
   questions), not a silent assumption dressed as a requirement.
5. FAIL CLOSED ON COMPLETENESS. The critic loop exits only when no material gap/ambiguity/untestable
   criterion remains OR it stalls — and a stalled critic reports the open gaps, never a "looks complete"
   it didn't earn.
</EXTREMELY-IMPORTANT>

# Auto Spec

## Overview

Produce the spec a strong engineer would write before touching code: grounded in what actually exists,
precise about behavior, testable in its criteria, honest about scope and risk — arrived at autonomously
through recon + draft + an adversarial completeness loop. The output is a spec downstream phases can plan
and test against without re-interviewing the user.

## Phase 0: Intake — capture the request, detect blocking ambiguity

- Capture `$request` verbatim as the source of scope. The request IS the scope; don't silently narrow or
  widen it.
- Judge whether it's answerable from the repo + reasonable inference, or whether a genuine product
  decision blocks it (a fork where building the wrong branch is expensive). Only for the latter, ask a
  FEW targeted questions (`AskUserQuestion`) — never a long interview, never scope questions you could
  answer by reading the repo.
- Open a `checkpoint-resume` run.

**Success criteria:** the request is captured; at most a few genuinely-blocking questions asked; recon
can proceed.

## Phase 1: Recon — ground the spec in reality

Before drafting, learn what exists (fan out with `fan-out-work` for a large repo):

- the relevant existing code, modules, data models, and interfaces the change touches;
- prior art / patterns in the repo to stay consistent with;
- constraints that are real: the stack, existing contracts, invariants in `CLAUDE.md`/docs, data shapes,
  auth/security boundaries;
- the domain facts the request assumes;
- **`.ulpi/learnings.md` if present** — prior runs' verified lessons (`auto-learn`): constraints and
  failure patterns already paid for belong in the spec's constraints/risks, not rediscovered.

Record what's grounded vs. what's an assumption — the draft will mark assumptions explicitly.

**Success criteria:** a grounded picture of the current state and constraints the spec must respect.

## Phase 2: Draft the spec

Write `.ulpi/spec/<name>.md` covering (omit a section only when truly N/A, and say so):

- **Objective** — the problem and the outcome, in one or two sentences.
- **Users & context** — who this is for and when it's used.
- **Behavior / user stories** — what the system does, from the user's view; the happy path AND the error
  and edge paths.
- **Acceptance criteria** — a checklist, each item TESTABLE (a condition you could assert). These become
  the plan's per-task criteria and the tests' targets.
- **Scope & non-goals** — explicitly in and explicitly OUT.
- **Constraints & interfaces** — stack, contracts, data shapes, public interfaces affected, backward-compat.
- **Assumptions & open questions** — everything not grounded, named as such.
- **Risks** — security, data, irreversibility, performance — with the mitigation direction.

**Success criteria:** a complete first draft; every acceptance criterion is phrased testably; assumptions
are marked, not hidden as facts.

## Phase 3: The completeness-critic loop (converge until stable)

Run `converge-loop` in until-dry mode with an adversarial critic as the finder — this is what makes the
spec strong:

- each round, `adversarial-verify`-style critics attack the draft: missing behavior/edge/error case? an
  acceptance criterion that isn't testable? an ungrounded requirement? contradictory or ambiguous
  wording? a non-goal that should be stated? an unstated assumption?
- apply the smallest fix per finding (tighten a criterion, add the missing case, mark the assumption, cut
  the invented requirement);
- re-critique; exit when a round finds no material gap (dry) OR it stalls. A stalled loop reports the
  remaining open gaps — it does not claim completeness.

Use `AskUserQuestion` only if a surfaced gap is a real product decision; otherwise the critic resolves it
against the repo.

**Success criteria:** no material gap/ambiguity/untestable criterion remains, or the open ones are
explicitly listed as open questions.

## Phase 4: Finalize

Write the stabilized spec to `.ulpi/spec/<name>.md`, close the checkpoint, and report where it lives + the
open questions (if any). This spec is the input to `auto-plan`.

**Success criteria:** the spec file is written and self-consistent; open questions (if any) are flagged
for the user.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The request is clear enough, skip the spec." | Clear-to-you scatters into ten interpretations at build time. The spec is the shared contract that prevents that. |
| "I'll just assume the obvious behavior." | An unmarked assumption is an invented requirement. Mark it as an assumption or ask — don't smuggle it in as fact. |
| "'Works well' is a fine acceptance criterion." | Untestable criteria can't gate anything. If you can't write a test for it, it's a wish, not a criterion. |
| "I don't need non-goals, the scope is obvious." | Unstated non-goals are the entry point for scope creep. Name what's out. |
| "The critic found nothing new, one round is enough." | One round rarely exhausts the gaps. Loop until a round is genuinely dry, then stop. |
| "I'll reference a config/endpoint that probably exists." | A phantom path in the spec becomes a phantom in the code. Ground it or mark it unknown. |

## Red Flags

- Requirements, paths, or endpoints in the spec that don't exist in the repo and aren't marked assumptions.
- Acceptance criteria you couldn't write a test for.
- A spec with in-scope items but no non-goals.
- The critic loop ran exactly once.
- Long clarification interviews for things readable in the repo.
- A "complete" verdict with unresolved contradictions still in the text.

## Guardrails

- Never invent requirements/paths/constraints; ground them or mark them assumptions.
- Never emit an untestable acceptance criterion.
- Never omit explicit non-goals.
- Never resolve a real product decision silently — ask (briefly) or flag it open.
- Never report the spec complete while the critic still finds material gaps.

## When To Load References

- `fan-out-work` (skill) — parallel recon across a large codebase in Phase 1.
- `adversarial-verify` (skill) — the completeness critics in Phase 3.
- `converge-loop` (skill) — the until-stable critic loop (termination + anti-thrash).
- `checkpoint-resume` (skill) — durable spec-run state.

## Output Contract

Report:

1. the spec file path (`.ulpi/spec/<name>.md`) and a one-line objective
2. acceptance criteria count (all testable) and the explicit non-goals
3. assumptions made + open questions surfaced for the user
4. critic-loop outcome (rounds to stable, or the honest remaining gaps)
