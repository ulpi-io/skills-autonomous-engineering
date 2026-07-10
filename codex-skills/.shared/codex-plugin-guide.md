# The Codex plugin — install, verify, and run it honestly

This is the operator guide for running `@ulpi/skills-autonomous-engineering` on **Codex**. It is
implemented-only: every capability below names the **exact file that implements it** and a **deterministic
test** that already passes, so nothing here is a promise. Codex is a **first-class surface**, not a
"phase 2" — the plugin (18 adapters, a pinned `codex exec` executor, Codex-event guard hooks, a
reproducible marketplace packager, and a gated live smoke) ships today.

> **Honesty rule.** A capability appears as runnable ONLY when a real file implements it under Codex and a
> real test proves it. When Codex lacks a capability, the honest outcome is stated verbatim —
> `blocked`, `gateNotRun`, `created:false`, or a **draft/ready brief** — never an emulated success. The
> binding capability contract is `codex-skills/.shared/codex-runtime.md`; the discovery/topology contract
> is `codex-skills/.shared/source-layout.md`. If prose and those maps disagree, the maps (and the code +
> test they link) win.

---

## 1. Know your surface first — app / CLI / no-automation

Codex is not one thing. The plugin's install, hooks, and live smoke assume a surface that can **install a
plugin** and **execute hooks**. Decide which you are on before you run anything:

| Surface | Can install the plugin? | Runs hooks? | What this guide gives you |
|---|---|---|---|
| **Codex CLI** (`codex exec`) | Yes — `codex plugin marketplace add` / `plugin add` | Yes (Codex hook events) | The full path: install → verify → new-session discovery → hooks → live smoke |
| **Codex app** (desktop/IDE) | Yes, via the same marketplace/plugin commands its runtime exposes | Yes | Same lifecycle; the executor/smoke sections are CLI-driven and run from a terminal |
| **No-automation surface** (a hosted/web Codex with no plugin install and/or no hook execution) | **No** | **No** | Treat every creation/registration as **`created:false` / draft output** — the SKILL.md methodology still applies, read manually; nothing is silently "installed" |

**Missing-capability rule (non-negotiable).** On a surface that cannot create/register something, the
honest output is `created:false` (or a **ready/draft brief**), never a fabricated success:

- **Plugin install** on a no-automation surface → NOT installed; you apply the canonical `SKILL.md`
  methodology by hand. The guide never claims an install that did not happen.
- **Scheduling** (`schedule-recurring-agent`) → Codex has **no** supported scheduler capability
  (`RemoteTrigger` / `CronCreate` are **Claude-Code-only**), so `create` returns
  `created:false, registered:false, reason:'no-capability'` plus a ready brief. Implemented in
  `schedule-recurring-agent/scripts/validate-job.mjs`; proven by `bash scripts/test-scheduled-job.sh`.
- **Any Claude-only mechanism** (`Workflow()`, `ScheduleWakeup`, native `/goal`+`/loop`) → not
  Codex-runnable; the adapter routes to its implemented Codex substitute or returns the honest degraded
  outcome. See the Claude-only table in `codex-skills/.shared/codex-runtime.md`.

---

## 2. Install — isolated marketplace add/list, then plugin add + verify

The plugin is built into a **reproducible marketplace artifact** by
`scripts/package-codex-plugin.mjs` (`--out <dir>`; writes ONLY under `--out`, never mutating the source
repo; prints a stable `digest=sha256:<hex>`). Its topology mirrors source exactly — the 18 Codex adapters
under `codex-skills/`, sealed by `codex-skills/catalog.json`, plus the canonical delegate skill dirs that
back them. Proven by `bash scripts/test-codex-package.sh`.

Install and verify, **in an isolated Codex home** so your real config is never touched:

```bash
# 0. Build the marketplace artifact from a source checkout.
node scripts/package-codex-plugin.mjs --out /tmp/ulpi-codex-market

# 1. Add the marketplace SOURCE, then LIST it to confirm it registered.
codex plugin marketplace add /tmp/ulpi-codex-market
codex plugin marketplace list                       # expect the marketplace name in the output

# 2. Add the plugin by <plugin>@<marketplace>, then LIST to VERIFY the install.
codex plugin add autonomous-engineering@<marketplace-name>
codex plugin list                                   # expect: autonomous-engineering, its version,
                                                    #         its install root, and 18 catalog entries
```

**Isolation you should insist on.** The bundled smoke driver pins `CODEX_HOME` to a fresh temp dir and
`HOME` to a temp work dir for every Codex invocation, and points `--cd` at a throwaway git fixture — the
user's real config is **never read or written**, and the packager writes only under its `--out`. When you
install by hand, do the same: run against a scratch `CODEX_HOME` first and only promote to your real home
once `plugin list` shows the expected version + 18 entries. **This plugin NEVER silently edits your
user-global Codex config** — no capability here writes to `~/.codex` or your global settings behind your
back; installation is the explicit `marketplace add` / `plugin add` you run, and hook trust is your call
(§4).

---

## 3. New-session discovery

Skills become invocable in a **new Codex session** after the plugin is added — a running session does not
retroactively gain them. Codex discovers skills **only** from the path named by
`.codex-plugin/plugin.json`'s `skills` pointer (fixed to `./codex-skills/`); dot-prefixed entries like
`.shared/` are skipped, so they are never mistaken for skills. In a fresh session each installed skill is
addressed by its plugin-qualified identifier:

```
$autonomous-engineering:<skill>      e.g. $autonomous-engineering:auto-review
```

Each adapter is **thin** — it holds no methodology of its own; it applies the canonical root `SKILL.md`
via its `delegate` and runs it under the Codex runtime map. A missing/dangling delegate **fails
validation**. Discovery + topology are proven by `node scripts/validate-skills.mjs --surface codex` and
`node scripts/test-dual-plugin-discovery.mjs` (both surfaces discover their own tree with no cross-surface
leak).

---

## 4. Hook review & trust — review first, never auto-trust

The plugin wires **Codex-event guard hooks** in `hooks/hooks.json`:

- `PreToolUse` matcher `Bash` → `auto-build/scripts/guard-git-hygiene.sh` +
  `auto-ship/scripts/guard-ship-irreversibles.sh`
- `PreToolUse` matcher `Edit|Write|apply_patch` → `auto-test/scripts/guard-test-integrity.sh`
  (Codex edits arrive via `apply_patch`; a test-integrity violation is **blocked, exit 2**, before the
  write lands)
- `SessionStart` → `hooks/session-start-announce.sh` (read-only resume announce)
- `Stop` → `hooks/honest-stop.sh` (non-blocking `{"systemMessage":…}` notice by default; escalates to
  the Codex `{"decision":"block","reason":…}` schema only under `ULPI_STOP_STRICT=1`)

**Trust is the operator's decision, and it fails safe.** Untrusted plugin hooks are **skipped and warned
about** — never run silently. The live smoke proves this first: it asserts hooks are `skipped-untrusted`
by default and permits `--dangerously-bypass-hook-trust` **only** after matching vetted hook + artifact
hashes; it never bypasses approvals or the sandbox. **Review each hook script before you trust it**, then
opt in explicitly. Hook behavior is proven by `bash scripts/test-codex-hooks.sh` (and
`bash scripts/test-guards.sh`).

---

## 5. The live smoke — real Codex, gated, never a fabricated clean

Before you rely on the plugin end-to-end, run the **live smoke** against the real `codex` CLI. It drives
the whole lifecycle — package → `marketplace add`/`list` → `plugin add`/`list` (asserting the exact
plugin/version/install-root + 18 catalog entries) → a NEW ephemeral read-only session invoking a skill
against an output schema — and returns **redacted** evidence:

```bash
node scripts/smoke-codex-plugin.mjs --live
node scripts/smoke-codex-plugin.mjs --live --codex-bin /path/to/codex   # explicit binary
node scripts/smoke-codex-plugin.mjs --live --repo . --work-dir /tmp/ulpi-smoke --keep
```

**Gated preflight — no fabricated green.** `--live` requires the pinned Codex version
(`PINNED_CODEX_VERSION = 0.44.0`, kept in lock-step with the executor) AND an operable CLI. An
unavailable CLI, an auth failure, or a version mismatch returns a nonzero **`gateNotRun`** — it is
**never** reported as clean. The default (no `--live`) run is the zero-network fake used in CI, exercising
the same isolation, add/list, session argv/env, cleanup, failure propagation, and secret redaction with a
self-contained fake `codex`; proven by `node scripts/test-codex-smoke.mjs`.

The pinned `codex exec` executor itself is `autonomous-pipeline/scripts/lib/codex-executor.mjs` — a
drifted/missing binary, non-zero exit, timeout, leaked descendant, missing output file, malformed JSON, or
off-schema final message all resolve to a typed **`blocked`** result, never a fabricated green and never a
fallback to a bypass flag. Proven by `node scripts/test-codex-executor.mjs`; its argv contract by
`node scripts/test-cli-contract.mjs`.

---

## 6. Capability → path → test (the honest map, condensed)

For the full per-capability contract (executor argv, worktrees, budgets, approvals, convergence, and the
Claude-only column) read `codex-skills/.shared/codex-runtime.md`. The plugin-lifecycle essentials:

| Claim | Implemented path | Deterministic test |
|---|---|---|
| Marketplace artifact (reproducible, topology-preserving) | `scripts/package-codex-plugin.mjs` | `bash scripts/test-codex-package.sh` |
| 18 Codex adapters, sealed inventory | `codex-skills/catalog.json` | `node scripts/validate-skills.mjs --surface codex` |
| Plugin manifest + discovery pointer | `.codex-plugin/plugin.json` | `node scripts/test-dual-plugin-discovery.mjs` |
| Pinned `codex exec` executor | `autonomous-pipeline/scripts/lib/codex-executor.mjs` | `node scripts/test-codex-executor.mjs` |
| Codex-event guard hooks (`apply_patch` gate, honest Stop) | `hooks/hooks.json` | `bash scripts/test-codex-hooks.sh` |
| Live plugin smoke (gated, redacted) | `scripts/smoke-codex-plugin.mjs` | `node scripts/test-codex-smoke.mjs` |
| Scheduling degrades to `created:false` + brief | `schedule-recurring-agent/scripts/validate-job.mjs` | `bash scripts/test-scheduled-job.sh` |

Every path above exists in this repo and every test passes; `scripts/test-codex-docs.sh` mechanically
re-checks that this guide and the README only cite paths + tests that actually exist.
