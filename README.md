# @ulpi/skills-autonomous-engineering

**Let your agent run engineering work unattended — without it cheating, spinning, or losing work.**

Every AI agent can loop. The failure modes are what kill you: it "fixes" the suite by skipping the red
test, grinds for three hours past the point of progress, `git add -A`s unrelated work into a commit it
later force-pushes, and reports "done" for gates that never ran. This collection makes those failure
modes **mechanically impossible**, not just discouraged.

## 30 seconds of it

```text
> /auto-test src/auth

⏺ Baseline: 47 tests, 2 failing · coverage gaps: 7 untested behaviors (token expiry,
  refresh race, 5 error paths). Checkpoint: .ulpi/runs/auto-test-....json

⏺ Writing test: "rejects expired token with 401"… mutation check: broke verifyToken()
  → test FAILED (good — it actually tests something). Restored → green. Kept.

⏺ Writing test: "refresh() is idempotent"… mutation check: broke refresh() → test still
  PASSED. Tautology — rejected, rewriting with state assertions…

⏺ Fixing failing test 1/2: root cause is a real bug in session.ts:41 (clock injected
  nowhere) — surfacing it, NOT rewriting the assertion to match the wrong output.

✗ Edit blocked by guard-test-integrity: this edit weakens the test signal (skip/only/
  suppression in a test file) — that fakes the done-condition.   ← the hook, not a promise

⏺ Converged: 54 tests green, 7 behaviors covered (all mutation-verified), 1 real bug
  surfaced, 0 tests skipped/weakened. Iterations 4/6, ~38k tokens of 150k budget.
```

That last part is the point: the agent **tried** to take the shortcut every agent takes, and the
skill's own PreToolUse hook — a tested shell script that travels with it — blocked the tool call.
The loop is bounded (iterations + budget + no-progress), the run is resumable from its checkpoint
after any interruption, and "done" fails closed (a red suite is reported red).

## The pipeline

```
 DEFINE        PLAN         BUILD          CLEAN         PROVE        GATE         MEASURE        SHIP
┌────────┐  ┌────────┐  ┌───────────┐  ┌──────────┐  ┌─────────┐  ┌─────────┐  ┌───────────┐  ┌────────┐
│ testable│→ │ DAG of │→ │ worktree  │→ │ simplify,│→ │ tests + │→ │ verified│→ │ benchmark-│→ │ fail-  │
│ spec    │  │ atomic │  │ per task, │  │ behavior-│  │ mutation│  │ findings│  │ gated     │  │ closed │
│         │  │ tasks  │  │ one commit│  │ preserved│  │ -checked│  │ only    │  │ accepts   │  │ gates  │
└────────┘  └────────┘  └───────────┘  └──────────┘  └─────────┘  └─────────┘  └───────────┘  └────────┘
 /auto-spec  /auto-plan   /auto-build   /auto-simplify  /auto-test   /auto-review  /auto-performance  /auto-ship
     ▲                                                                                             │
     │                                 every run then closes with:                                 ▼
     │        ┌───────────────────────────────────┐      ┌─────────────────────────────────────────┐
     └────────│ LEARN /auto-learn                 │─────▶│ MAP /auto-map (real runs)               │
  .ulpi/      │ harvest checkpoint → verify →     │      │ refresh the tiered context map so every │
  learnings   │ route lessons; the next run reads │      │ future session knows the shipped code   │
  feed the    │ them BEFORE planning              │      └─────────────────────────────────────────┘
  next run    └───────────────────────────────────┘

              chain it all with ONE plan approval:  /autonomous-pipeline "<feature>"
```

| You want to… | Run | What actually makes it safe |
|---|---|---|
| Turn an idea into a testable spec | `/auto-spec` | completeness-critic loop; no invented requirements |
| Break a spec into buildable tasks | `/auto-plan` | DAG self-review: acyclic, ordered, disjoint write scopes |
| Build the whole plan unattended | `/auto-build` | one approval; per-task commit; bulk-staging **blocked by hook** |
| Cover code with tests that mean something | `/auto-test` | mutation-checked tests; suite-gaming **blocked by hook** |
| Review without false positives | `/auto-review` | every finding survives a 3-skeptic refutation panel |
| Make it faster, provably | `/auto-performance` | no benchmark delta + green tests → reverted |
| Ship with honest gates | `/auto-ship` | unran gate = blocker; force-push **blocked by hook** |
| Keep any loop from running away | `converge-loop` + `budget-guard` | declared termination set; compiles into native `/goal` |
| Make every session start knowing the repo | `/auto-map` | disclosure-tiered context map (root ≤150 lines + path-scoped rules + nested folder maps), every claim verified against the code |
| Stop repeating last run's mistakes | `/auto-learn` | harvests the run's checkpoint into verified learnings; the next plan reads them before deciding |

## Install

**skills.sh** (universal — Claude Code, Codex, Cursor, and ~70 more):

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering            # everything
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill auto-test   # one skill
```

**Claude Code plugin** (adds the plugin-level hooks: session resume-announcer + live-run guards):

```
/plugin marketplace add ulpi-io/skills-autonomous-engineering
/plugin install autonomous-engineering@ulpi-autonomous-engineering
```

## How routing actually works (verified, not assumed)

- **Claude Code** reads each skill's `description` + `when_to_use` (≤1,536 chars combined — CI-enforced
  here, because past that it silently truncates and routing degrades) for model-invocation, and every
  skill is a `/skill-name` slash command. Skills must be *installed* — any of the five layouts the
  guard resolvers also cover: project `.claude/skills/` or `.agents/skills/`, user `~/.claude/skills/`
  or `~/.agents/skills/`, or a plugin — a raw clone is not discovered.
- **Codex** supports the same SKILL.md anatomy natively (`name` + `description` are its entire routing
  surface) and is in skills.sh's universal install group. Codex-tuned briefs are phase 2.
- **Enforcement travels with the skill**: guard hooks are declared in skill frontmatter (skill-scoped —
  they fire only while that skill is active) and resolve to real, tested scripts in the skill's
  `scripts/` dir across all five install layouts, failing open if absent.
- **Native goal/loop**: on Claude Code, each skill's termination set compiles into `/goal` (whose
  independent verifier model checks the done-condition) and `/loop` — see
  `converge-loop/references/native-goal-loop.md`.

## Deterministic enforcement

Prompt contracts bend under pressure; these don't. While the owning skill is active, its PreToolUse
hook **blocks the tool call** (reason shown to the model):

| Guard | Cardinal sin it makes impossible |
|---|---|
| `auto-test/scripts/guard-test-integrity.sh` | Gaming the suite green — adding `.only`/`.skip`/`xit`/suppressions to test files |
| `auto-build/scripts/guard-git-hygiene.sh` | Breaking per-task rollback — `git add -A/.`, `commit -a`, `reset --hard`, `clean -f` |
| `auto-ship/scripts/guard-ship-irreversibles.sh` | Unilateral irreversibles — plain `push --force`, `push --delete` |
| `checkpoint-resume/scripts/checkpoint.mjs` | Destroying run state — refuses re-init over a live run, demoting `done` units, false `finalize done` |

All behavior-tested in CI (`scripts/test-guards.sh` — 52 cases incl. resolver, fail-open, live-run
staleness scoping, multi-line/quoted/global-option command parsing, and the 2-minute
`.ulpi/allow-test-weaken` approval window — and
`scripts/test-checkpoint.sh` — the full contract incl. durable `item` persistence, `gc` retention, and
zero lost writes under 20-way concurrency). Runs are resumable at ANY point (phase- and task-granular
checkpoints), and when a Codex integration is installed you can delegate build/review/verify roles to it
per run (never assumed; degrades to native with an honest register note).

## What makes these "autonomous" (and not "runaway")

Every skill honors the same contract — it's the whole point of the collection:

- **Bounded, never infinite** — every loop declares a termination set (done-condition, iteration cap,
  token budget, no-progress stop) and stops the instant one fires.
- **Fails closed** — a gate that didn't run is never reported clean; a loop that ran out of budget says so
  and returns the open items. No fabricated green verdicts.
- **Verifies before acting** — findings that drive edits are adversarially verified (skeptics try to
  refute) first.
- **Durable + resumable** — long runs write a live status file and skip already-done work on resume.
- **Escalates, doesn't guess** — user-owned decisions (irreversible/ambiguous) stop and ask.

## Skills

### Phases

| Skill | What it does |
|-------|-------------|
| [auto-spec](#auto-spec) | Request → grounded, testable spec — repo recon, draft, completeness-critic loop until stable |
| [auto-plan](#auto-plan) | Spec → self-reviewed DAG task plan; validates acyclicity + topological order |
| [auto-build](#auto-build) | Walk the DAG: engineer-in-worktree → integrate → per-task review → bounded fix loop; checkpointed |
| [auto-simplify](#auto-simplify) | Loop-until-dry cleanup; each change adversarially verified behavior-preserving |
| [auto-test](#auto-test) | Find coverage gaps → write tests → **loop-until-green**; every test mutation-verified; de-flake |
| [auto-review](#auto-review) | Multi-dimension review → adversarial-verify → confirmed findings → optional fix loop |
| [auto-performance](#auto-performance) | Profile → hotspots → optimize → **benchmark-gated** accept (never an unmeasured "win") |
| [auto-ship](#auto-ship) | Fail-closed pre-launch gate → release artifacts → PR / staged rollout; human-gated deploy |

### Autonomy layer

| Skill | What it does |
|-------|-------------|
| [autonomous-pipeline](#autonomous-pipeline) | Chains all 8 phases end-to-end — one approval, checkpointed, CI-watching, returns a findings register |
| [auto-map](#auto-map) | Verified, disclosure-tiered context architecture: lean root + path-scoped rules + nested folder maps, anti-lie gate as code |
| [auto-learn](#auto-learn) | The self-improvement loop: harvest run artifacts → verify → route to the right memory layer → feed the next run |
| [watch-and-act](#watch-and-act) | Wait on an external signal (CI/deploy/queue) on a cache-aware cadence and act on change |
| [schedule-recurring-agent](#schedule-recurring-agent) | Stand up a recurring cron routine — idempotent brief, bounded per run, with a teardown condition |

### Primitives

| Skill | What it does |
|-------|-------------|
| [converge-loop](#converge-loop) | The bounded self-correcting loop — until-green / until-dry, with anti-thrash, no-progress, budget stops |
| [adversarial-verify](#adversarial-verify) | N-skeptic majority-refute gate before acting on any finding |
| [checkpoint-resume](#checkpoint-resume) | Durable live status file; skip-done, session-independent resume |
| [fan-out-work](#fan-out-work) | Generic map(-reduce) over a discovered work-list — capped, isolated, faithfully aggregated |
| [budget-guard](#budget-guard) | Termination + token-budget discipline every run declares: caps, done-conditions, escalation points |

---

## Phases

### auto-spec

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill auto-spec
```

Turns a raw request into a grounded, **testable** spec. Recons the real repo to ground every requirement,
drafts the spec (objectives, behavior, acceptance criteria, explicit non-goals, constraints, risks), then
runs a completeness-critic loop that hunts for gaps, ambiguity, and untestable criteria until it's stable.
No invented requirements, no phantom paths; every acceptance criterion is something you could write a test
for. Writes `.ulpi/spec/<name>.md`.

### auto-plan

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill auto-plan
```

Decomposes a spec into a DAG of small, independently-verifiable tasks — each with acceptance criteria, a
disjoint write scope, and a slice-scoped validate — wires the dependency edges, and layers them
topologically so nothing is built before its dependencies land. Then adversarially self-reviews the graph
(acyclicity, ordering, phantom paths, task independence) until it's clean. Writes
`.ulpi/plans/<name>.json`.

### auto-build

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill auto-build
```

Implements a whole plan in one approved pass. Requires a clean git baseline, takes a single plan approval,
then walks the DAG layer by layer: each task is built test-first in an isolated worktree, integrated onto
the working branch, reviewed on its slice, fixed in a bounded loop, and committed individually — so any
point is a clean rollback. Follows the dependency graph strictly (never builds on a broken base),
checkpoints every task for exact resume, and stops-and-asks on unfixable/ambiguous/irreversible steps.

### auto-simplify

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill auto-simplify
```

Reduces a change's complexity **without changing behavior** — provably. Finds simplification
opportunities (duplication, dead code, over-abstraction, tangled conditionals), and for each applies the
smallest clarifying edit, then proves behavior is preserved (tests green + an adversarial semantic check)
before keeping it — looping until dry. Respects Chesterton's Fence; reverts anything it can't prove neutral.

### auto-test

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill auto-test
```

Raises a codebase's test health to a green, **meaningful** suite. Finds coverage gaps, writes real tests,
and runs a loop-until-green until the suite passes — de-flaking along the way. Every added test is
mutation-verified (break the code, the test must fail — rejects tautologies), and the run is checkpointed.
Fails closed: never games the suite green by skipping/weakening tests.

### auto-review

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill auto-review
```

Reviews a change across every dimension at once (correctness, security, performance, maintainability, test
adequacy, API/contract), then keeps only the findings that survive an adversarial refutation — so false
positives never reach you or drive a fix. Survivors come back severity-labeled and actionable; on `--fix`,
a bounded loop resolves the confirmed blockers. Fails closed on any dimension that didn't run.

### auto-performance

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill auto-performance
```

Makes code **measurably** faster without breaking it. Establishes a metric and baseline benchmark first,
profiles to the real hotspots (not guesses), then per hotspot applies a change and re-benchmarks —
accepting it only if the improvement is statistically real AND passes a correctness-regression check;
otherwise reverts. Stops at the target or diminishing returns. Never accepts an unmeasured "win".

### auto-ship

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill auto-ship
```

Takes verified work to shippable with fail-closed gates and a human sign-off on anything irreversible.
Runs the pre-launch gate (final validate, review, security, observability, rollback) — a gate that didn't
run is a blocker, not "clean" — then prepares grounded release artifacts (atomic commits, changelog,
version, docs) and opens the PR or stages the rollout. The deploy itself is human-gated.

---

## Autonomy layer

### autonomous-pipeline

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill autonomous-pipeline
```

The top-level entry point: one request → spec → plan → build → simplify → test → review → performance →
ship, as a single autonomous pass with **one** human approval (the plan) and hard-gated escalation for
anything irreversible. Fail-closed gates between phases, a durable pipeline checkpoint (resume at the exact
phase/task), a whole-run budget, and a verified findings register at the end. It runs one pass and stops —
no autonomous whole-lifecycle recursion; a fix round is the user's call.

### watch-and-act

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill watch-and-act
```

Waits on an external signal the harness can't notify you about — a CI run, a deploy, a queue, an endpoint
— on a cache-aware cadence (short enough to stay in the prompt cache when actively watching, long enough
not to burn cache when idle; never ~300s), bounded by a deadline. Acts on the transition and stops on
success/failure/timeout. Explicitly does **not** poll harness-tracked background work (that re-invokes you
automatically).

### schedule-recurring-agent

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill schedule-recurring-agent
```

Stands up a recurring cron routine for standing work — issue triage, CVE watch, PR babysitting, nightly
audits. Writes a self-contained, **idempotent** brief (each run wakes with no memory, so it must dedup
against prior work), picks a cadence matched to how often the work arrives, bounds each run, and defines
reporting, escalation, and a teardown condition. Manages the routine lifecycle via the cron tools.

---

## Primitives

### converge-loop

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill converge-loop
```

The beating heart of every loop here. Runs a bounded, self-correcting loop: act → check a signal → decide
to continue or stop. Two modes — **until-green** (run a validate, diagnose, fix minimally, re-run until it
passes) and **until-dry** (find items, act, re-find until N consecutive rounds surface nothing new). Every
loop carries a termination set (max iterations, budget, no-progress/anti-thrash) so it converges or
reports honestly; it never spins.

### adversarial-verify

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill adversarial-verify
```

Before an agent acts on a finding, prove it by trying to disprove it. Spawns N independent skeptics each
prompted to **refute** the claim (optionally each through a distinct lens — correctness / security /
reproduction / regression / measurement), and keeps the claim only if a majority fails to refute it. Turns
"plausible" into "verified"; fails closed on ties.

### checkpoint-resume

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill checkpoint-resume
```

Makes any long run durable and resumable. Writes a live `.ulpi/runs/<id>.json` status file — overall +
per-unit — updated as work lands. On resume it reads the file and **skips every unit already done**,
rebuilding only the rest. Session-independent (not cache-dependent). Status writes are non-fatal
observability, never a gate.

### fan-out-work

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill fan-out-work
```

Covers a large work-list in parallel without the usual parallel sins. Scouts the items inline, runs each
through its stages concurrently (pipeline by default) with concurrency caps and worktree isolation for
writers, and aggregates faithfully — a failed item is a reported null, an intentional cap is logged.
Never silently truncates; `items discovered = covered + failed + dropped`.

### budget-guard

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill budget-guard
```

The discipline that keeps an autonomous run from becoming a runaway. Before any unattended loop/workflow
starts, it forces five stop conditions to exist — a done-condition, a hard cap, a token/tool/wall-clock
budget, a no-progress rule, and named escalation triggers — then holds the run to them and stops the
instant one fires. The difference between "autonomous" and "unbounded".
