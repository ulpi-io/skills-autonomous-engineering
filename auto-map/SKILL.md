---
name: auto-map
version: 0.1.0
disable-model-invocation: true
user-invocable: true
description: |
  Generate and refresh the project's CONTEXT ARCHITECTURE — a disclosure-tiered map so the agent starts
  every session knowing the repo without paying for what it doesn't need. Platform-aware by explicit
  contract (claude|codex|dual): for Claude a lean root CLAUDE.md (loads always), path-scoped
  .claude/rules/*.md (load only when touching matching files), nested CLAUDE.md throughout the tree
  (loaded on demand — zero cost until then); for Codex the root + nested AGENTS.md tree instead — never
  inventing a memory location the platform lacks, never touching private agent memory. Deep references
  are LINKED, never imported. Every claim is VERIFIED against the real repo before it ships (commands
  actually run; paths actually exist) — the map cannot lie. Use to initialize project context, refresh
  it after meaningful changes, or as the pipeline's final phase so the map reflects what just shipped.
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
argument-hint: "[scope — full refresh (default), a dir, or 'verify'] [--platform claude|codex|dual]"
arguments:
  - scope
  - platform
when_to_use: |
  Use when a project lacks a real context map (CLAUDE.md for Claude, AGENTS.md for Codex), after
  architecture-level changes (new packages, moved modules, changed commands), as the closing phase of an
  autonomous-pipeline run, or with 'verify' to READ-ONLY audit an existing map for drift. Do NOT run
  proactively after routine edits (it mutates durable project memory), and do NOT use it to write coding
  rules — it maps what IS, it doesn't legislate. On an unsupported platform, or when a file's
  generated-vs-human ownership is ambiguous, it STOPS before mutating rather than guessing.
---

<EXTREMELY-IMPORTANT>
This skill mutates durable project memory — the files every future session trusts. Non-negotiable:
1. VERIFIED, NEVER INVENTED. Every path, export, route, and command in the map is checked against the
   repo before writing; every build/test command is actually EXECUTED (or explicitly marked unverified).
   A stale or invented map is worse than none — it poisons every future session.
2. DISCLOSURE-TIERED BY CONSTRUCTION. Root CLAUDE.md ≤150 lines (loads every session). Topic depth goes
   in path-scoped `.claude/rules/*.md` (loads only when matching files are touched) and a nested
   `CLAUDE.md` in EVERY significant directory — every repo, not just monorepos (loads on demand the
   moment Claude reads a file there). Deep references are LINKED as literal
   backtick paths with "read when needed" — NEVER `@`-imported: @imports load at launch and silently
   defeat the entire tiering (they do not reduce context).
3. UPDATE, DON'T CLOBBER. Preserve existing human-written instructions; refresh the generated sections
   (marked with generation stamps). Never delete a rule you didn't generate.
4. BUDGETED. Root ≤150 lines; each rules file ≤120; each nested CLAUDE.md ≤100. Over budget → move
   content DOWN a tier, don't squeeze the font.
5. EXPLICIT-USER-ONLY or composed by a user-invoked workflow (the pipeline's map phase). Never
   self-initiated after routine edits.
6. PLATFORM CONTRACT — WRITE ONLY WHERE THE PLATFORM READS. Resolve `claude|codex|dual` before any
   mutation. Claude mode owns the CLAUDE.md tree + `.claude/rules/*.md`. Codex mode owns the root +
   nested `AGENTS.md` tree ONLY: it NEVER writes `CLAUDE.md`, NEVER writes `.claude/rules`, NEVER
   invents a `.codex/rules` (Codex has no path-scoped-rules tier — that depth folds DOWN into the
   nearest nested `AGENTS.md`), and NEVER touches private Codex memory. `dual` writes BOTH trees, same
   verified content. An unrecognized/unsupported platform STOPS before any write. `verify` mode is
   READ-ONLY on every platform. Byte-identical preservation and stamped-region-only refresh are
   absolute: if a file's generated-vs-human ownership is ambiguous (existing content, no stamps, or
   overlapping regions), STOP and surface it — never rewrite on a guess.
</EXTREMELY-IMPORTANT>

# Auto Map

## Overview

Build the project's context architecture the way Claude Code actually loads context — a small
always-loaded core, path-triggered topic depth, and an on-demand map in every significant folder — instead of one fat file
(or worse, `@`-imports that pay full context tax at launch while looking modular). Then prove every
claim before shipping it. The result: every future session starts oriented, pays only for the tier it
touches, and can trust what the map says.

## Phase 0: Resolve platform, detect shape, inventory the existing map

- **Resolve the platform contract first (`claude|codex|dual`).** Take it from `--platform` if given;
  else infer from the running agent and the repo's existing memory files (a live `CLAUDE.md`/`.claude/`
  tree ⇒ claude; an `AGENTS.md` tree ⇒ codex; both ⇒ dual). If the platform is unrecognized/unsupported,
  STOP and say so — do not fall back to a default and write the wrong files. This decides the WRITE
  TARGETS for the whole run (see `references/map-templates.md` → "Platform target map"):
  - **claude** → root `CLAUDE.md` (or `.claude/CLAUDE.md`), `.claude/rules/*.md`, nested `CLAUDE.md`.
  - **codex** → root `AGENTS.md`, nested `AGENTS.md` ONLY. No `CLAUDE.md`, no `.claude/rules`, no
    invented `.codex/rules`, no private Codex memory. Tier-1 cross-cutting depth folds into the nearest
    nested `AGENTS.md`.
  - **dual** → both trees, identical verified content.
- Detect single-app vs monorepo (workspaces in package.json / pnpm-workspace / Cargo workspace / go.work
  / multiple app roots) and the primary stack(s).
- Inventory what exists on the RESOLVED platform's targets: root map, rules (claude only), nested maps.
  Classify each section as human-written (preserve BYTE-IDENTICALLY) vs generated (refresh — look for
  the generation stamp comment). A file with content but no stamps is treated as fully human-written:
  if its ownership is ambiguous, STOP before touching it (see EXTREMELY-IMPORTANT #6).
- `verify` mode: skip to Phase 3 and audit the existing map only — READ-ONLY, no writes.

**Success criteria:** platform resolved (or run STOPPED as unsupported); shape + stack known;
preserve-vs-refresh classification done with any ambiguous-ownership files flagged, not guessed.

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

**Platform mapping of the tiers.** The tiers above are the CLAUDE.md layout. On the resolved platform:
- **codex** — Tier 0 → root `AGENTS.md`; Tier 2 → nested `AGENTS.md` (same significant-directory list,
  same ≤100-line budget); Tier 1 has NO Codex home, so its cross-cutting depth folds DOWN into the
  nearest nested `AGENTS.md` (or, if that would blow the budget, a linked Tier-3 `docs/*.md`). Never
  emit `.claude/rules` or a fabricated `.codex/rules`. Tier 3 links work identically (backtick paths).
- **dual** — write both the CLAUDE.md tree and the AGENTS.md tree from the SAME verified inventory, so
  the two never drift; the stamp records which platform each generated region belongs to.
All budgets, generation stamps, evidence paths, and `(verified: <date>)`/`(unverified)` command markers
apply to `AGENTS.md` output exactly as they do to `CLAUDE.md` — the format is identical; only the
filename and the tier count differ.

**Success criteria:** all tiers written within budget on the resolved platform; nothing duplicated
across tiers; no `@`-imports of generated content; every generated region stamped; human-written
content preserved BYTE-IDENTICALLY (only stamped regions were rewritten).

## Phase 3: Verify the map against reality (the anti-lie gate — it is CODE)

Run the bundled verifier — the gate is a script, not a request to be careful:

```bash
node <skill-dir>/scripts/verify-map.mjs <project-root> --run-commands --expect-dirs "<sig-dirs>"
```

It mechanically enforces: tier budgets (comment-stripped line counts), zero `@`-imports outside code
spans, every backtick-claimed path exists, every command line executes (or carries an explicit
`(verified: <date>)`/`(unverified)` marker), generation stamps present, and a nested CLAUDE.md for
every expected significant directory. Exit 1 = the map lies; fix and re-run until 0. On top of the
script, `adversarial-verify` the SEMANTIC claims the script can't check (does the invariant prose
match the code's actual behavior; do named exports/routes exist — grep each symbol).

The bundled verifier audits the `CLAUDE.md` tree. For **codex/dual** output, apply the SAME checks to
each `AGENTS.md` — identical budgets, no launch-time imports, every backtick path exists, stamps
present, command markers verified — via the semantic audit (an `AGENTS.md` is read wholesale, so the
budget and marker rules transfer directly). `verify` mode is strictly READ-ONLY on every platform: run
the script + semantic audit and REPORT drift; it never rewrites, and it never auto-fixes ambiguous
ownership — it surfaces it.

**Success criteria:** zero unverified claims shipped silently; drift enumerated with evidence; verify
mode made no writes.

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
| "On Codex I'll just write a `.codex/rules` mirror of `.claude/rules`." | Codex has no path-scoped-rules tier — inventing one writes files nothing reads. Fold that depth into the nearest nested `AGENTS.md`. |
| "Platform's unclear, I'll write CLAUDE.md as the safe default." | Writing the wrong memory location poisons the wrong agent and litters the repo. Unrecognized platform → STOP and ask, don't default. |

## Red Flags

- A root CLAUDE.md over ~150 lines, or `@`-imports pointing at generated reference docs.
- Map claims with no evidence path; commands never executed during generation.
- A regenerated file that lost human-written sections, or a byte-diff in a region you didn't stamp.
- Major directories with no nested map (the agent works there blind), or everything crammed into the root file instead of the on-demand tiers.
- The map describing intended architecture rather than actual code.
- In Codex mode: a written `CLAUDE.md`, a `.claude/rules` file, a `.codex/rules` you invented, or any touch of private Codex memory — all contract violations (root + nested `AGENTS.md` only).
- A write that happened despite an unsupported platform or ambiguous ownership, or any mutation during `verify`.

## Guardrails

- Never invent or leave unverified claims unmarked; never ship a command you didn't run.
- Never `@`-import generated content; tiers must load on demand or not at all.
- Never clobber human-written instructions; refresh only stamped generated sections — human content stays BYTE-IDENTICAL.
- Never exceed tier budgets — move content down a tier instead.
- Never run proactively; explicit user intent or a user-invoked composing workflow only.
- Never write outside the resolved platform's targets: in Codex mode never write `CLAUDE.md`, `.claude/rules`, an invented `.codex/rules`, or private Codex memory — root + nested `AGENTS.md` only.
- Never write on an unsupported platform or on ambiguous file ownership — STOP and surface it. Never mutate anything in `verify` mode.

## When To Load References

- `references/map-templates.md` — the CRAFT: per-tier templates (CLAUDE.md AND Codex `AGENTS.md`), the
  Platform target map (claude|codex|dual → exact write targets), the generation-stamp format that makes
  update-don't-clobber implementable, the git-churn significant-directory heuristic, and the per-stack
  discovery table. Load in Phases 0–2 before writing anything.
- `scripts/verify-map.mjs` — the anti-lie gate as code (Phase 3 and `verify` mode). CI-tested — 13 contract cases in the collection test suite prove it catches every class of lying map.
- `fan-out-work` (skill) — parallel per-package discovery on large repos (Phase 1).
- `adversarial-verify` (skill) — the anti-lie gate over the map's claims (Phase 3).
- `autonomous-pipeline` (skill) — composes this as its closing map-refresh phase on real runs.

## Output Contract

Report:

1. resolved platform (claude|codex|dual), project shape + the significant-directory list, and every tier written/updated with line counts vs budgets (incl. each nested `CLAUDE.md`/`AGENTS.md`)
2. commands verified by execution (and any marked unverified, with why)
3. claims fixed/flagged in the verify gate; drift found (verify mode — no writes)
4. human-written content preserved BYTE-IDENTICALLY (confirmation), generation stamps updated; any run STOPPED for unsupported platform or ambiguous ownership, with the reason
