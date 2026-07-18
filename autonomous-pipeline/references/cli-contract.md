# CLI Contract — Codex executor + pipeline grammar + exit codes

The single source of truth for the Codex-native pipeline coordinator's external contracts is
`../scripts/lib/cli-contract.mjs` (zero-dependency, pure, no I/O, no `process.exit`). This document is
the human-readable spec; the module is the machine-enforced one, and
`../../scripts/test-cli-contract.mjs` pins both. If they ever disagree, the module + its tests win.

Everything here is **fail-closed**: an unknown flag, a duplicate flag, a positional token, an unsafe
id/ref/path, a malformed config, a schema-invalid plan, or a contaminated stdout stream is a hard
error — never a silently-accepted default.

---

## (a) Codex executor argv

`buildCodexArgv({ sandbox, cd, schemaFile, outputLastMessage })` returns the **exact** argv as a
`string[]` — **never a shell string**. The prompt is passed **only via stdin** (the trailing `-`); it
is never an argv element and never interpolated into a command line.

Pinned shape (global flags **before** `exec`, exec flags **after**):

```
codex
  --ask-for-approval never
  --sandbox <read-only|workspace-write>
  --cd <absolute-worktree>
exec
  --ephemeral
  --ignore-user-config
  --json
  --output-schema <schemaFile>
  --output-last-message <file>
  -                              # prompt read from STDIN
```

### Rejections (all throw `CliContractError` with `code = 2`)

| Rejected | Why |
|---|---|
| `--sandbox danger-full-access` | escalates to unrestricted filesystem/network |
| any sandbox other than `read-only` / `workspace-write` | only these two tiers are pinned |
| `--dangerously-bypass-approvals-and-sandbox` | defeats the approval + sandbox gate |
| `--add-dir` | widens the filesystem scope beyond the worktree |
| `--search` | reaches the network |
| `--skip-git-repo-check` | defeats the git-repo safety check |
| `--ignore-rules` | defeats ignore-file safety |
| any shell wrapper / string interpolation | argv is an array; `$`, `` ` ``, `;`, `|`, `&`, `<>()`, quotes, globs, whitespace, backslash, control chars, or a leading `-` in any value are rejected |
| relative `--cd` or a `..` traversal segment | the worktree path must be absolute and contained |
| a value that smuggles a forbidden flag (e.g. `cd: "--add-dir"`) | leading-`-` values are rejected; a final scan asserts no forbidden flag survived |
| unknown option keys | only `sandbox`, `cd`, `schemaFile`, `outputLastMessage` are accepted |

The exhaustive deny set is exported as `FORBIDDEN_CODEX_FLAGS`.

---

## (b) Pipeline CLI grammar

Exactly **five** public forms exist (`PIPELINE_COMMANDS`). `parseCli(argv)` returns a normalized
object or throws `CliContractError` (`code = 2`).

```
approve   --plan <canonical-json> --config <run-config-json> [--json]
start     --run <id>  [--json]
resume    --run <id>  [--json]
status    --run <id>  [--json]
authorize --run <id>  --action <ship|deploy|publish|remote-merge> [--json]
```

Grammar rules (each a hard error):

- **Unknown command** → not one of the five.
- **Unknown flag** → not declared for that command.
- **Duplicate flag** → the same flag appears twice.
- **Positional ambiguity** → any bare (non-`--`) token.
- **Missing required flag** → every value flag of a command is required.
- **Flag with no value** → a value flag at end-of-argv or `--json=<value>` (boolean takes no value).
- **Unsafe `--run` id** → must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, no `..`.
- **Unsafe `--plan` / `--config` path** → must be an absolute, non-interpolated, non-traversing path.
- **Unauthorized `--action`** → must be one of `AUTHORIZE_ACTIONS`.

Both `--flag value` and `--flag=value` are accepted; `--json` is a boolean switch defaulting to `false`.

### Payload validators

- `parseRunConfig(text)` → parses JSON, requires a plain object; malformed JSON or a non-object throws
  (`code = 2`).
- `parseCanonicalPlan(text)` → parses JSON, requires an object with `tasks: []` and `layers: []`;
  malformed or schema-invalid throws (`code = 2`).

### Binding scope at `approve`

`approve` performs a second, pre-mutation gate over the parsed plan. Executable pipeline plans carry:

- `selectedScope: [{ id, title, source }]` — the itemized intake selection and scope authority;
- `tasks[].scopeItems: [id, ...]` — task coverage mappings;
- `scopeDrops: [{ scopeId, reason, acknowledgedByUser: true, acknowledgement }]` — only after the user
  separately acknowledges that exact drop. General plan approval is not acknowledgement evidence.

The coordinator recomputes `scopeCoverage = { total, covered, dropped, uncovered, errors }` before it
creates a checkpoint or mints a capability. It refuses with exit `3` on `scope-missing`, `scope-invalid`,
`scope-drop-unacknowledged`, or `scope-uncovered`. A successful approve returns and durably stores the
coverage object; the plan hash binds it to the capability. The approval UI/report renders **SCOPE
COVERAGE: N of M selected-scope items covered** plus every drop and UNCOVERED id.

### One-object-on-stdout JSON rule

In `--json` mode the CLI emits **exactly one final JSON object on stdout**; all diagnostics go to
**stderr**. `emit(obj)` returns a single-line JSON object (no embedded newline).
`assertSingleStdoutObject(stdout)` verifies a captured stdout is exactly one JSON object — a mixed-in
log line, a second object, or an array/scalar payload is rejected.

---

## (c) Exit-code table

Pinned in `EXIT` (named) and `EXIT_TABLE` (code → meaning). Exit `1` is **deliberately reserved** for
an unexpected crash / uncaught throw and carries no pinned meaning.

| Code | Name | Meaning |
|---|---|---|
| 0 | `SUCCESS` | success / converged |
| 2 | `USAGE` | usage / config / schema error |
| 3 | `PREFLIGHT` | preflight / drift / approval-refusal |
| 4 | `BLOCKED` | blocked / non-converged gate |
| 5 | `BUDGET` | budget / no-progress / escalation |
| 6 | `CHECKPOINT` | checkpoint / control I/O or corruption |
| 7 | `DRIFT` | target drift / integration / publication conflict |

`CliContractError` carries the appropriate pinned code on `.code`; callers translate that to the
process exit status.
