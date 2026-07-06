# @ulpi/skills-autonomous-engineering

**Autonomous engineering skills for AI coding agents** — the software delivery lifecycle as a set of
loop- and workflow-driven phases that run themselves: bounded, self-correcting, checkpoint-resumable,
and honest about when they're done. Works with [skills.sh](https://skills.sh) across Claude Code,
Cursor, Cline, Windsurf, and 15+ other agents (Claude-Code-first — it exploits the `Agent`, `Workflow`,
`/loop`, and `/schedule` primitives).

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering
```

Or install individual skills:

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill converge-loop
```

## The pipeline

```
 auto-spec → auto-plan → auto-build → auto-simplify → auto-test → auto-review → auto-performance → auto-ship
                                            ▲                                                          │
                                            └───────────────── autonomous-pipeline ───────────────────┘
                                              (chains all 8 unattended, checkpointed, CI-watching)
```

## Skills

### Phases

| Skill | What it does |
|-------|-------------|
| [auto-spec](#auto-spec) | Request → grounded, testable spec — repo/domain recon, draft, completeness-critic loop until stable |
| [auto-plan](#auto-plan) | Spec → self-reviewed DAG task plan; validates acyclicity + topological order |
| [auto-build](#auto-build) | Walk the DAG: engineer-in-worktree → integrate → per-task review → bounded fix loop; checkpointed |
| [auto-simplify](#auto-simplify) | Loop-until-dry cleanup (reuse/dedup/altitude) over the diff; each change adversarially verified behavior-preserving |
| [auto-test](#auto-test) | Find coverage gaps → write tests → **loop-until-green**; de-flake |
| [auto-review](#auto-review) | Multi-dimension review → adversarial-verify → confirmed findings → optional fix loop |
| [auto-performance](#auto-performance) | Profile → hotspots → optimize → **benchmark-gated** accept (never accept an unmeasured "win") |
| [auto-ship](#auto-ship) | Final go-live gate → commit → PR → changelog; fail-closed gates |

### Autonomy layer

| Skill | What it does |
|-------|-------------|
| [autonomous-pipeline](#autonomous-pipeline) | Chains all 8 phases unattended with checkpoints between them and CI watching |
| [watch-and-act](#watch-and-act) | Poll an external signal (CI/deploy/queue) on a cache-aware cadence and act on change |
| [schedule-recurring-agent](#schedule-recurring-agent) | Set up a recurring cron cloud routine for an autonomous task |

### Primitives

| Skill | What it does |
|-------|-------------|
| [converge-loop](#converge-loop) | The bounded self-correcting loop — until-green / until-dry, with anti-thrash, no-progress, and budget stops |
| [adversarial-verify](#adversarial-verify) | N-skeptic majority-refute verification gate before acting on any finding |
| [checkpoint-resume](#checkpoint-resume) | Durable live status file; skip-done, session-independent resume for long runs |
| [fan-out-work](#fan-out-work) | Generic map(-reduce) over a discovered work-list via the Workflow tool |
| [budget-guard](#budget-guard) | Termination + token-budget discipline every loop loads: done-conditions, caps, escalation points |

---

<!-- Per-skill detail sections are filled in as each skill lands. Wave 1: converge-loop,
     checkpoint-resume, adversarial-verify, auto-test. -->

## converge-loop

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill converge-loop
```

The beating heart of every autonomous loop in this collection. Runs a **bounded, self-correcting
loop**: act → check a signal → decide to continue or stop. Two modes — **until-green** (run a validate
command, diagnose, fix minimally, re-run until it passes) and **until-dry** (find items, act, re-find
until N consecutive rounds surface nothing new). Every loop carries a termination set — max iterations,
token budget, and no-progress/anti-thrash detection — so it converges or reports honestly; it never
spins.

## adversarial-verify

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill adversarial-verify
```

Before an autonomous agent acts on a finding (a bug, a fix, a claim), prove it. Spawns N independent
skeptics each prompted to **refute** the claim (optionally each through a distinct lens —
correctness / security / does-it-reproduce), and keeps the claim only if a majority fails to refute it.
Turns "plausible" into "verified" and stops false findings from driving mutations.

## checkpoint-resume

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill checkpoint-resume
```

Makes any long-running autonomous task durable and resumable. Writes a live `.ulpi/runs/<id>.json`
status file — overall status, per-unit progress — updated as work lands. On resume it reads the file
and **skips every unit already done**, rebuilding only the rest. Session-independent (no reliance on an
agent cache), so a stopped, crashed, or handed-off run picks up exactly where it left off.

## auto-test

```bash
npx skills add https://github.com/ulpi-io/skills-autonomous-engineering --skill auto-test
```

Autonomously raises a codebase's test health. Finds coverage gaps and missing regression tests, writes
them, and runs a **loop-until-green** (`converge-loop`) until the suite passes — de-flaking along the
way. Every added test is adversarially verified to actually exercise the target (not a tautology), and
the run is checkpointed so it resumes cleanly. Composes `converge-loop`, `adversarial-verify`, and
`checkpoint-resume`.
