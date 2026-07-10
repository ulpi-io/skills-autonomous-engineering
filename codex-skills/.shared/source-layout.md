# Source layout contract — dual Claude + Codex discovery isolation

This file is the **binding contract** for how the two distribution surfaces of this collection
discover skills from a single source tree, and for how the packaged marketplace artifact must
preserve that topology. It is normative: `scripts/validate-skills.mjs` (surfaces `claude`, `codex`,
`all`) and the Codex packaging/discovery tests enforce the rules stated here. If code and this file
disagree, that is a bug to reconcile — the rules below are the intended behavior.

> `.shared/` is a **dotted** directory. Neither surface treats it as a skill or an adapter: Claude
> never scans under `codex-skills/`, and Codex skill discovery skips dot-prefixed entries. It exists
> only to hold cross-cutting contracts like this one.

## The two discovery surfaces

### Claude surface — immediate canonical ROOT skills

- Claude Code discovers each skill from an **immediate child directory of the plugin/repo root**
  that contains a `SKILL.md` (e.g. `auto-build/SKILL.md`, `converge-loop/SKILL.md`). These 18 root
  directories are the **canonical methodology** — the single source of truth every Codex adapter
  ultimately delegates back to.
- The plugin manifest for this surface is `.claude-plugin/plugin.json` with `"skills": "./"`, meaning
  "scan the root for skill directories."
- The validator's Claude surface skips the non-skill roots (`scripts/`, `hooks/`, `docs/`,
  `.claude-plugin/`, `codex-skills/`, `site/`, `examples/`, …); everything else at root is a skill and
  must satisfy the full `SKILL.md` contract.

### Codex surface — the isolated `codex-skills/` tree

- Codex discovers skills **only** from the path named by `.codex-plugin/plugin.json`'s `skills`
  pointer, which is fixed to **`./codex-skills/`**. Codex adapters live one directory deep
  (`codex-skills/<adapter>/`) and are validated by the `codex` surface: each adapter needs an
  `openai.yaml` (`name` == dir, `description`, `delegate`) whose `delegate` resolves to a real
  canonical Claude skill at `<delegate>/SKILL.md`. An optional `codex-skills/manifest.json` carries an
  `adapters` array.
- Adapters are a **later layer**. Until they land, `codex-skills/` legitimately holds only this
  `.shared/` contract, so the `codex` surface validates as an **empty-but-valid** adapter tree (zero
  adapters, no manifest required) — and that must stay green.

## Isolation invariants (the reason the two trees never collide)

1. **No default root `skills/` directory.** This repo/plugin MUST NOT contain a top-level `skills/`
   directory. Claude Code auto-scans a `skills/` folder *in addition to* declared paths (outside the
   narrow marketplace-root exception, which source isolation must not rely on). A root `skills/` would
   silently double-expose adapters to Claude discovery and collide skill IDs across surfaces. The
   Claude surface uses root dirs directly; the Codex surface uses `codex-skills/`; neither is named
   `skills/`.
2. **No cross-surface source paths.** The Codex `skills` pointer is `./codex-skills/` — never `./`
   (which would expose the canonical Claude roots to Codex) and never a path into the root skill dirs.
   Symmetrically, the Claude manifest never points into `codex-skills/`. A cross-surface source path
   fails validation.
3. **Relative, non-escaping component paths only.** Every component pointer in a manifest
   (`skills`, and if ever added `mcpServers` / `apps` / `hooks`) is repo-root-relative and stays
   **inside** the plugin root. A path that escapes the root (`../…`, absolute, or symlink-out) fails
   validation.
4. **No component field without a real companion.** A manifest declares a component pointer **only**
   when the target actually exists. `.codex-plugin/plugin.json` declares `skills: ./codex-skills/`
   (present) and nothing else — no `mcpServers`, `apps`, or `hooks` are declared until their companion
   files exist. A dangling component pointer fails validation.
5. **Complete author + interface metadata; strict semver.** `.codex-plugin/plugin.json` carries a
   strict `x.y.z` `version`, a full `author` object (`name`, `email`, `url`), and a complete
   `interface` object (display/short/long description, developer, category, capabilities, website,
   default prompts). A missing interface field or an unsupported top-level manifest field fails
   validation.

## Artifact topology preservation

The packaged Codex marketplace artifact (built by the packaging task) MUST preserve this exact
topology:

- `.agents/plugins/marketplace.json` at the marketplace root and
  `plugins/autonomous-engineering/` for the plugin.
- The plugin's `.codex-plugin/plugin.json` retains the same strict `version` and `skills:
  ./codex-skills/` pointer as source.
- The `codex-skills/` adapters (once present: exactly one per canonical skill) ship under the
  plugin, and the **canonical root skill directories ship as delegate targets that are NOT
  Codex-discovered** (they back the adapters; Codex only enumerates `codex-skills/`).
- **No default `skills/` directory** appears anywhere in the artifact.

Any of the following fails the artifact/topology check nonzero: a default artifact `skills/`
directory, a missing delegate, an escaping path, a stale catalog, an invalid marketplace source, or
any drift between artifact and source topology.
