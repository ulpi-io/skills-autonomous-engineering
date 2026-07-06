---
name: auto-map
version: 0.1.0
description: |
  Generate and refresh the project's CONTEXT ARCHITECTURE — a disclosure-tiered map so Claude starts
  every session knowing the repo without paying for what it doesn't need: a lean root CLAUDE.md (loads
  always), path-scoped .claude/rules/*.md (load only when touching matching files), nested per-package
  CLAUDE.md for monorepos (load on demand), and linked-not-imported deep references. Every claim is
  VERIFIED against the real repo before it ships (commands actually run; paths actually exist) — the map
  cannot lie. Use to initialize project context, refresh it after meaningful changes, or as the
  pipeline's final phase so the map always reflects what just shipped.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
user-invocable: true
effort: high
argument-hint: "[scope — full refresh (default), a package/dir, or 'verify' to audit the existing map]"
arguments:
  - scope
when_to_use: |
  Use when a project lacks a real CLAUDE.md context map, after architecture-level changes (new packages,
  moved modules, changed commands), as the closing phase of an autonomous-pipeline run, or with 'verify'
  to audit an existing map for drift. Do NOT run proactively after routine edits (it mutates durable
  project memory), and do NOT use it to write coding rules — it maps what IS, it doesn't legislate.
---

<EXTREMELY-IMPORTANT>
This skill mutates durable project memory — the files every future session trusts. Non-negotiable:
1. VERIFIED, NEVER INVENTED. Every path, export, route, and command in the map is checked against the
   repo before writing; every build/test command is actually EXECUTED (or explicitly marked unverified).
   A stale or invented map is worse than none — it poisons every future session.
2. DISCLOSURE-TIERED BY CONSTRUCTION. Root CLAUDE.md ≤150 lines (loads every session). Topic depth goes
   in path-scoped `.claude/rules/*.md` (loads only when matching files are touched) and nested
   per-package CLAUDE.md (loads on demand when working there). Deep references are LINKED as literal
   backtick paths with "read when needed" — NEVER `@`-imported: @imports load at launch and silently
   defeat the entire tiering (they do not reduce context).
3. UPDATE, DON'T CLOBBER. Preserve existing human-written instructions; refresh the generated sections
   (marked with generation stamps). Never delete a rule you didn't generate.
4. BUDGETED. Root ≤150 lines; each rules file ≤120; each nested CLAUDE.md ≤100. Over budget → move
   content DOWN a tier, don't squeeze the font.
5. EXPLICIT-USER-ONLY or composed by a user-invoked workflow (the pipeline's map phase). Never
   self-initiated after routine edits.
</EXTREMELY-IMPORTANT>

# Auto Map

## Overview

Build the project's context architecture the way Claude Code actually loads context — a small
always-loaded core, path-triggered topic depth, and on-demand package maps — instead of one fat file
(or worse, `@`-imports that pay full context tax at launch while looking modular). Then prove every
claim before shipping it. The result: every future session starts oriented, pays only for the tier it
touches, and can trust what the map says.

## Phase 0: Detect shape, inventory the existing map

- Detect single-app vs monorepo (workspaces in package.json / pnpm-workspace / Cargo workspace / go.work
  / multiple app roots) and the primary stack(s).
- Inventory what exists: root `CLAUDE.md` / `.claude/CLAUDE.md`, `.claude/rules/*.md`, nested
  `*/CLAUDE.md`, `AGENTS.md`. Classify each section as human-written (preserve) vs generated (refresh —
  look for the generation stamp comment).
- `verify` mode: skip to Phase 3 and audit the existing map only.

**Success criteria:** shape + stack known; preserve-vs-refresh classification done.

## Phase 1: Discover the real project (fan out on large repos)

Inventory from the code, not from memory: build/test/lint commands (from package scripts, Makefile,
CI); directory layout and module boundaries; public surfaces (routes, CLI entries, exported packages);
data models and stores; integration points (queues, external APIs); repo-provided capabilities
(`.claude/skills/`, `.mcp.json`); and the SIGNIFICANT-directory list for Tier 2
(module boundaries by structure, size, and git churn — the folders where work actually happens). Use
`fan-out-work` with one agent per package/major directory when the repo is large.

**Success criteria:** a verified inventory — every item carries the evidence path it was read from.

## Phase 2: Write the tiers (smallest always-on core, depth on demand)

- **Tier 0 — root `CLAUDE.md` (≤150 lines, loads every session):** what the project is (2-3 lines),
  the commands (build/test/lint — verified by execution), the layout map (one line per top dir),
  load-bearing invariants, and POINTERS to the deeper tiers as literal backtick paths ("architecture
  detail: `docs/architecture.md` — read when needed"). HTML comments for maintainer notes (stripped
  from context). Generation-stamped sections.
- **Tier 1 — `.claude/rules/<topic>.md` with `paths:` frontmatter:** CROSS-CUTTING conventions scoped
  by glob (testing.md, security.md, api-design.md) that load only when Claude touches matching files.
  Rules carry the "how we do things" that spans folders; per-folder identity lives in Tier 2's nested
  CLAUDE.md files, not here.
- **Tier 2 — nested `CLAUDE.md` THROUGHOUT the tree (every repo, not just monorepos):** every
  SIGNIFICANT directory gets its own small `CLAUDE.md` — what this folder is, its key files and their
  roles, local invariants ("handlers here never touch the DB directly"), how to test this area, and
  what it must not import. Claude Code loads these ON DEMAND the moment it reads a file in that
  directory — so Claude always understands the folder it is working in, paying zero context until it
  goes there. Significant = module boundaries: `src/api/`, `src/components/`, `src/db/`+migrations,
  `services/*`, workers, infra — and in a monorepo, every workspace package (subsuming a separate
  monorepo variant). Rule of thumb: if an engineer would pause to orient before editing there, it gets
  a map; a folder of three leaf files does not.
- **Tier 3 — deep references (`docs/*.md` or existing docs):** linked from higher tiers in backticks,
  never imported.

**Success criteria:** all tiers written within budget; nothing duplicated across tiers; no `@`-imports
of generated content; human-written content preserved verbatim.

## Phase 3: Verify the map against reality (the anti-lie gate)

`adversarial-verify` every claim: paths exist (`test -e` each referenced path), commands run (execute
build/test/lint — a command that fails is fixed or marked `(unverified)`), exports/routes match the
code (grep each named symbol), and NO `@import` of a generated file slipped in. In `verify` mode,
report drift (claims vs reality) without rewriting unless asked.

**Success criteria:** zero unverified claims shipped silently; drift enumerated with evidence.

## Phase 4: Report

Report tiers written/updated (with line counts vs budgets), commands verified by execution, claims
fixed or flagged, and human content preserved. In pipeline composition, this is the last phase of a
real (non-aborted) run — the map then describes the code that just shipped.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "One big CLAUDE.md is simpler." | It loads whole every session, and past ~200 lines adherence drops. Tier it: pay only for what the session touches. |
| "@import the details for organization." | Imports load AT LAUNCH — full context tax with modular cosmetics. Link in backticks; nested files load on demand. |
| "The path probably still exists." | "Probably" poisons every future session. `test -e` it or drop it. |
| "The build command is obviously npm test." | Run it. A map command that fails on first use destroys trust in the whole map. |
| "Regenerate everything, it's cleaner." | You'd delete the human's hard-won instructions. Refresh generated sections; preserve the rest. |
| "Refresh the map after every edit." | Durable-memory churn and noise. Map after MEANINGFUL change — or as the pipeline's closing phase. |

## Red Flags

- A root CLAUDE.md over ~150 lines, or `@`-imports pointing at generated reference docs.
- Map claims with no evidence path; commands never executed during generation.
- A regenerated file that lost human-written sections.
- Major directories with no nested CLAUDE.md (Claude works there blind), or everything crammed into the root file instead of the on-demand tiers.
- The map describing intended architecture rather than actual code.

## Guardrails

- Never invent or leave unverified claims unmarked; never ship a command you didn't run.
- Never `@`-import generated content; tiers must load on demand or not at all.
- Never clobber human-written instructions; refresh only stamped generated sections.
- Never exceed tier budgets — move content down a tier instead.
- Never run proactively; explicit user intent or a user-invoked composing workflow only.

## When To Load References

- `fan-out-work` (skill) — parallel per-package discovery on large repos (Phase 1).
- `adversarial-verify` (skill) — the anti-lie gate over the map's claims (Phase 3).
- `autonomous-pipeline` (skill) — composes this as its closing map-refresh phase on real runs.

## Output Contract

Report:

1. project shape + the significant-directory list, and every tier written/updated with line counts vs budgets (incl. each nested CLAUDE.md)
2. commands verified by execution (and any marked unverified, with why)
3. claims fixed/flagged in the verify gate; drift found (verify mode)
4. human-written content preserved (confirmation), generation stamps updated
