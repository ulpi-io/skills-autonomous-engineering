#!/usr/bin/env node
// watch-state.mjs — durable, atomic, resumable state for watch-and-act's CROSS-TURN external-signal
// polling. A watch only needs this when polling must survive a turn boundary (a native wait/monitor
// capability, ScheduleWakeup, or simply "check again next time I wake"): the harness re-invokes you in a
// FRESH process with no memory of when you started or how many times you've polled, so the ORIGINAL bound
// (absolute deadline + poll cap) and the running count MUST live on disk and be read-then-bumped each
// cycle — otherwise a deadline/max-poll stop can never fire honestly and the loop never ends.
//
// It reuses the checkpoint-resume STORE primitives (atomic tmp+rename write, mkdir lock, ISO stamps) so it
// never reimplements durable IO. State lives in ONE `.json` file with `kind:"watch"`.
//
// Guarantees (each maps to a watch-and-act guardrail):
//   * init REFUSES harness-tracked work (a background Agent/Task/Workflow re-invokes you on completion —
//     watching it is pure waste) and REQUIRES an external target + an absolute future deadline + a poll cap
//     + a valid (non-dead-zone) interval;
//   * every real `observe` ATOMICALLY bumps the poll count and appends the observed evidence;
//   * a terminal outcome (success | failure | deadline | exhausted) is DURABLE — `observe` refuses to
//     restart it and `init` refuses to clobber it, so a fresh turn can never silently re-open a closed watch;
//   * a fresh process reads the bound from disk (preserving it), and `next` NEVER blocks: with no wake
//     capability it returns a resumable PENDING report (honest degradation) instead of hanging the run.
//
// Commands (state file path is the first positional; may be relative to cwd):
//   init   <file> --target <signal> --deadline <ISO-8601> --max-polls <n> --interval <sec> [--id <id>]
//                 [--harness-tracked]        # the flag is a TRIPWIRE: it always REFUSES (exit 2)
//   observe <file> --state <pending|success|failure> [--evidence <text>]
//   next    <file> [--wake <native|schedule|none>]   # default none → resumable PENDING report, never blocks
//   status  <file>                                     # read-only: dump the durable doc
//
// Exit codes: 0 ok · 1 usage/parse (bad or missing input) · 2 state refusal (harness-tracked / restart a
// terminal watch / clobber an existing watch). Mirrors the checkpoint store's {1:usage, 2:refusal} scale.
//
// Zero external deps (node: builtins + the sibling checkpoint store). Node 22+.

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readDoc, writeDoc, withLock, now, CheckpointError } from '../../checkpoint-resume/scripts/lib/checkpoint-store.mjs';

const SCHEMA_VERSION = 1;
const TERMINAL = new Set(['success', 'failure', 'deadline', 'exhausted']);
const OBSERVE_STATES = new Set(['pending', 'success', 'failure']);
const WAKE_KINDS = new Set(['native', 'schedule', 'none']);

function fail(msg, code = 1) { throw new CheckpointError(msg, code); }

// ── validation (all run BEFORE any filesystem write on init) ─────────────────────────────────────────
function validateDeadline(d) {
  if (typeof d !== 'string' || d.trim() === '') fail('init requires --deadline <absolute ISO-8601 timestamp> (the hard stop)');
  const s = d.trim();
  // An absolute instant carries a date/time separator; a bare number or a relative "+30m" is not a bound.
  if (!/[T:-]/.test(s)) fail(`--deadline '${s}' is not an absolute timestamp — pass an ISO-8601 instant (e.g. 2026-07-10T12:00:00Z), not a duration`);
  const t = Date.parse(s);
  if (!Number.isFinite(t)) fail(`--deadline '${s}' is not a parseable ISO-8601 timestamp`);
  if (t <= Date.now()) fail(`--deadline '${s}' is in the past — the bound must be in the future`);
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function validateMaxPolls(n) {
  const v = Number(n);
  if (n === undefined || n === '' || !Number.isInteger(v) || v < 1) fail(`--max-polls must be a positive integer (the poll cap) — got ${JSON.stringify(n)}`);
  return v;
}

function validateInterval(n) {
  const v = Number(n);
  if (n === undefined || n === '' || !Number.isInteger(v) || v < 1) fail(`--interval must be a positive integer number of seconds — got ${JSON.stringify(n)}`);
  // The cadence discipline (see SKILL.md): ≤270s stays in the ~5-min prompt cache when actively watching;
  // ≥1200s is a real idle heartbeat. The (270, 1200) band is the ~300s trap — it pays the cache miss
  // without amortizing it. Refuse it so a watcher can't be stood up on the worst cadence.
  if (v > 270 && v < 1200) fail(`--interval ${v}s is in the cache dead-zone (the ~300s trap: pays the prompt-cache miss without amortizing it). Use <=270s when actively watching or >=1200s when idle.`);
  return v;
}

// ── operations ───────────────────────────────────────────────────────────────────────────────────────
export function init(file, { target, deadline, maxPolls, intervalSec, harnessTracked, id } = {}) {
  // TRIPWIRE first: harness-tracked work has its OWN completion signal — refuse before validating anything.
  if (harnessTracked) fail('refusing to watch HARNESS-TRACKED work — a background Agent/Task/Workflow re-invokes you on completion; watching it is pure waste. Only watch signals the harness cannot see (CI/deploy/queue/endpoint).', 2);
  if (typeof target !== 'string' || target.trim() === '') fail('init requires --target <external signal> (what, precisely, to watch)');
  const dl = validateDeadline(deadline);
  const cap = validateMaxPolls(maxPolls);
  const iv = validateInterval(intervalSec);
  mkdirSync(dirname(file), { recursive: true });
  return withLock(file, () => {
    // A terminal OR live watch is durable — refuse to clobber/restart it. Deleting the file is the only
    // way to explicitly discard a watch; init must never silently re-open a closed one.
    if (existsSync(file)) {
      let cur = null; try { cur = readDoc(file); } catch { cur = null; }
      if (cur && cur.kind === 'watch') {
        fail(`${file} is an existing watch (status=${cur.status}) — refusing to clobber/restart it (its outcome is durable). Delete the file only to explicitly discard the watch.`, 2);
      }
    }
    const stamp = now();
    const doc = {
      schemaVersion: SCHEMA_VERSION, kind: 'watch',
      id: id ?? `watch-${stamp.replace(/[:.]/g, '').replace('T', '-')}`,
      target: target.trim(),
      status: 'watching',
      deadline: dl, maxPolls: cap, intervalSec: iv,
      pollCount: 0, observations: [], result: null, terminalAt: null,
      createdAt: stamp, updatedAt: stamp,
    };
    writeDoc(file, doc);
    return doc;
  });
}

function loadWatch(file) {
  if (!existsSync(file)) fail(`no watch state at ${file} — run 'init' first`);
  const doc = readDoc(file);
  if (!doc || doc.kind !== 'watch') fail(`${file} is not a watch-state file (missing kind:"watch")`);
  doc.observations ??= [];
  return doc;
}

export function observe(file, { state, evidence } = {}) {
  if (!OBSERVE_STATES.has(state)) fail(`observe requires --state <pending|success|failure> — got ${JSON.stringify(state)}`);
  return withLock(file, () => {
    const doc = loadWatch(file);
    // A terminal watch is DURABLE — never silently restart it.
    if (TERMINAL.has(doc.status)) {
      fail(`watch '${doc.id}' is already terminal (status=${doc.status}) — refusing to restart a durable watch; its outcome is final.`, 2);
    }
    const stamp = now();
    // ATOMIC read-modify-write: bump the count and append the real evidence together.
    doc.pollCount = (doc.pollCount || 0) + 1;
    doc.observations.push({ at: stamp, state, ...(evidence !== undefined ? { evidence } : {}) });
    if (state === 'success') { doc.status = 'success'; doc.result = evidence ?? null; doc.terminalAt = stamp; }
    else if (state === 'failure') { doc.status = 'failure'; doc.result = evidence ?? null; doc.terminalAt = stamp; }
    else {
      // pending: apply the bound AFTER counting this real observation. The bound comes from DISK, so a
      // fresh process enforces the ORIGINAL deadline/cap, not a re-derived one.
      if (Date.parse(doc.deadline) <= Date.now()) { doc.status = 'deadline'; doc.terminalAt = stamp; }
      else if (doc.pollCount >= doc.maxPolls) { doc.status = 'exhausted'; doc.terminalAt = stamp; }
    }
    writeDoc(file, doc);
    return doc;
  });
}

const OUTCOME_ACTION = { success: 'proceed', failure: 'diagnose-or-escalate', deadline: 'report-timeout', exhausted: 'report-exhausted' };

// READ-ONLY. Computes the next action from the DURABLE state. NEVER blocks: with no wake capability it
// returns a resumable PENDING report (honest degradation) rather than hanging the run forever.
export function next(file, { wake } = {}) {
  const w = wake ?? 'none';
  if (!WAKE_KINDS.has(w)) fail(`--wake must be one of native|schedule|none — got ${JSON.stringify(wake)}`);
  const doc = loadWatch(file);
  const base = { id: doc.id, target: doc.target, pollCount: doc.pollCount, maxPolls: doc.maxPolls, deadline: doc.deadline, statusFile: file };
  if (TERMINAL.has(doc.status)) {
    return { ...base, status: doc.status, terminal: true, resumable: false, result: doc.result, action: OUTCOME_ACTION[doc.status] };
  }
  const pollsRemaining = Math.max(0, doc.maxPolls - doc.pollCount);
  if (w === 'none') {
    return {
      ...base, status: 'pending', terminal: false, resumable: true, wake: 'none',
      pollsRemaining, intervalSec: doc.intervalSec, action: 'resume-when-woken',
      note: `no wake capability available — watch state is durable at ${file}; re-run 'observe' when you next wake, then 'next' again. NOT blocking.`,
    };
  }
  return {
    ...base, status: 'pending', terminal: false, resumable: true, wake: w,
    pollsRemaining, intervalSec: doc.intervalSec, action: 'schedule-next-poll',
    note: `schedule the next observation in ${doc.intervalSec}s via ${w === 'native' ? 'the native wait/monitor capability' : 'ScheduleWakeup'}.`,
  };
}

export function status(file) { return loadWatch(file); }

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────
const VALUE_FLAGS = new Set(['target', 'deadline', 'max-polls', 'interval', 'id', 'state', 'evidence', 'wake']);
function parseArgs(argv) {
  const pos = [], opt = {}, bool = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (VALUE_FLAGS.has(k)) opt[k] = argv[++i];
      else bool[k] = true;
    } else pos.push(a);
  }
  return { pos, opt, bool };
}

function fileArg(pos) {
  if (!pos.length || typeof pos[0] !== 'string' || pos[0] === '') fail('missing <state-file> path (first positional argument)');
  return pos[0];
}

export function main(argv, out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n')) {
  const [cmd, ...rest] = argv;
  const { pos, opt, bool } = parseArgs(rest);
  switch (cmd) {
    case 'init':
      out(init(fileArg(pos), { target: opt.target, deadline: opt.deadline, maxPolls: opt['max-polls'], intervalSec: opt.interval, harnessTracked: !!bool['harness-tracked'], id: opt.id }));
      return 0;
    case 'observe':
      out(observe(fileArg(pos), { state: opt.state, evidence: opt.evidence }));
      return 0;
    case 'next':
      out(next(fileArg(pos), { wake: opt.wake }));
      return 0;
    case 'status':
      out(status(fileArg(pos)));
      return 0;
    default:
      fail(`unknown command '${cmd ?? ''}' — expected init | observe | next | status`);
  }
}

// ── script tail ──────────────────────────────────────────────────────────────────────────────────────
const invokedDirectly = (() => {
  try { return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href; }
  catch { return false; }
})();
if (invokedDirectly) {
  try { process.exitCode = main(process.argv.slice(2)) || 0; }
  catch (e) {
    const code = e && e.name === 'CheckpointError' ? e.code : 1;
    process.stderr.write(`watch-state: ${(e && e.message) || e}\n`);
    process.exitCode = Number.isInteger(code) ? code : 1;
  }
}
