#!/usr/bin/env node
// validate-job.mjs — schedule-recurring-agent's recurring-job GATE as CODE (D1: a mechanically
// checkable guardrail must NOT ship as prose-only). A recurring agent acts unattended, repeatedly,
// forever — so the job spec that stands it up is validated deterministically, and its creation is
// HONEST about what the running platform can actually do.
//
// Two modes:
//
//   validate <job.json> [--json]
//     Enforce the recurring-job SCHEMA. A job MUST declare all of:
//       key        — a stable, safe idempotency/registration key ([A-Za-z0-9][A-Za-z0-9_-]*)
//       repo       — where it operates (no reliance on session context)
//       cadence    — { timezone, cron|expression } — a TIMEZONE-anchored recurrence
//       prompt     — a self-contained brief a memory-less run executes (non-empty, >= 20 chars)
//       dedup      — the idempotency rule (marker/state/since-query) so repeats don't re-file/re-spam
//       perRunCap  — a POSITIVE per-run bound (maxItems|maxTokens|maxMinutes|maxActions, or a number)
//       reporting  — the channel each run reports through (incl. "nothing to do")
//       escalation — the stop-and-ask rule for irreversible/ambiguous/high-volume work
//       teardown   — the off-switch (job done, N empty runs, a date, user cancel)
//     Missing/empty any of these → exit 2 (violations listed). Exit 0 = a schedulable job.
//
//   create <job.json> [--json] [--capability <name>] [--authorize] [--existing <registry.json>]
//     Stand the job up — HONESTLY. Order is load-bearing:
//       1. validate the schema (invalid → exit 2, created:false; nothing registered)
//       2. LIST/DEDUP FIRST against the registry — a job whose key already exists is a correct
//          idempotent NO-OP (created:false, reason:duplicate, existing id echoed; exit 0). This runs
//          BEFORE any capability check, so a re-run never stacks a duplicate routine.
//       3. CAPABILITY LADDER — a verifiable automation id is minted ONLY when a SUPPORTED capability
//          (RemoteTrigger | CronCreate — both Claude-Code-only) AND explicit --authorize are present.
//          Missing capability (e.g. on Codex) or missing authorization → created:false, exit 3, and a
//          READY BRIEF for manual/other-platform registration. It NEVER fabricates a RemoteTrigger/
//          CronCreate registration on a platform that has neither — it degrades and says so.
//       4. On success the automation id (`<capability>:<key>`) is appended to the registry when one is
//          supplied, so a subsequent list/create sees it — the id is VERIFIABLE, not invented.
//
// Exit codes:  0 = ok (created, or a correct dedup no-op, or a valid schema)
//              1 = usage / unreadable input
//              2 = schema INVALID (missing/empty required fields)
//              3 = NOT created: no supported capability, or not authorized (honest degrade)
//
// Zero external deps (node: builtins only). Node 22+.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const EXIT = { OK: 0, USAGE: 1, INVALID: 2, UNCREATABLE: 3 };

// The ONLY capabilities that actually register a recurring agent — both are Claude-Code-native.
// A platform without one of these (Codex, plain CLIs) cannot register; it degrades to a ready brief.
const SUPPORTED = new Set(['RemoteTrigger', 'CronCreate']);

// A safe, stable key: it becomes part of an automation id and a dedup lookup — keep it inert.
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// ── tiny arg parser ───────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { mode: null, file: null, json: false, capability: 'none', authorize: false, existing: null };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--authorize') out.authorize = true;
    else if (a === '--capability') out.capability = argv[++i];
    else if (a === '--existing') out.existing = argv[++i];
    else if (a.startsWith('--capability=')) out.capability = a.slice('--capability='.length);
    else if (a.startsWith('--existing=')) out.existing = a.slice('--existing='.length);
    else if (a.startsWith('--')) { /* ignore unknown flags */ }
    else pos.push(a);
  }
  out.mode = pos[0] || null;
  out.file = pos[1] || null;
  if (out.capability == null || out.capability === '') out.capability = 'none';
  return out;
}

// ── value predicates ──────────────────────────────────────────────────────────────────────────────
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// Any concrete, non-empty content anywhere in the value (string, number, or a nested object/array).
function hasContent(v) {
  if (isStr(v)) return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.some(hasContent);
  if (isObj(v)) return Object.values(v).some(hasContent);
  return false;
}

// perRunCap must declare at least one POSITIVE bound — an unbounded run can grind or fan out.
function isBoundedCap(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0;
  if (isObj(v)) return ['maxItems', 'maxTokens', 'maxMinutes', 'maxActions', 'max'].some(
    (k) => typeof v[k] === 'number' && Number.isFinite(v[k]) && v[k] > 0);
  return false;
}

// ── schema validation ───────────────────────────────────────────────────────────────────────────
function validateJob(job) {
  const problems = [];
  const warnings = [];
  const p = (m) => problems.push(m);
  const w = (m) => warnings.push(m);

  if (!isObj(job)) { p('job must be a JSON object'); return { problems, warnings }; }

  // key — stable + safe
  if (!isStr(job.key)) p('missing required field: key (a stable idempotency/registration key)');
  else if (!SAFE_KEY.test(job.key.trim())) p(`key must match ${SAFE_KEY} (safe, stable) — got "${job.key}"`);

  // repo — no reliance on session context
  if (!isStr(job.repo)) p('missing required field: repo (where the job operates)');

  // cadence — TIMEZONE-anchored recurrence
  if (!isObj(job.cadence)) {
    p('missing required field: cadence ({ timezone, cron|expression })');
  } else {
    if (!isStr(job.cadence.timezone)) p('cadence.timezone is required (a timezone-anchored cadence)');
    if (!isStr(job.cadence.cron) && !isStr(job.cadence.expression)) p('cadence.cron (or cadence.expression) is required');
  }

  // prompt — self-contained brief
  if (!isStr(job.prompt)) p('missing required field: prompt (a self-contained brief)');
  else if (job.prompt.trim().length < 20) p('prompt is too thin to be self-contained (>= 20 chars) — a memory-less run needs full context');
  else if (/\b(as before|like last time|previous run|previous session|continue from|you (?:already )?remember)\b/i.test(job.prompt))
    w('prompt hints at prior-run memory — each run wakes memory-less; rely on the dedup rule, not recall');

  // dedup — the idempotency rule
  if (!hasContent(job.dedup)) p('missing required field: dedup (the idempotency rule — marker/state/since-query)');

  // perRunCap — a positive bound
  if (job.perRunCap === undefined || job.perRunCap === null) p('missing required field: perRunCap (a per-run bound)');
  else if (!isBoundedCap(job.perRunCap)) p('perRunCap must declare a positive bound (maxItems|maxTokens|maxMinutes|maxActions, or a positive number)');

  // reporting — the channel
  if (!hasContent(job.reporting)) p('missing required field: reporting (the channel each run reports through)');

  // escalation — the stop-and-ask rule
  if (!hasContent(job.escalation)) p('missing required field: escalation (the stop-and-ask rule for irreversible/ambiguous work)');

  // teardown — the off-switch
  if (!hasContent(job.teardown)) p('missing required field: teardown (the off-switch condition)');

  return { problems, warnings };
}

// A ready brief for HONEST degrade — everything a human or another platform needs to register the job
// manually. It carries NO automation id and makes NO registration claim.
function readyBrief(job) {
  return {
    key: job.key,
    repo: job.repo,
    cadence: job.cadence,
    dedup: job.dedup,
    perRunCap: job.perRunCap,
    reporting: job.reporting,
    escalation: job.escalation,
    teardown: job.teardown,
    prompt: job.prompt,
  };
}

// ── registry (list + dedup + persist) ───────────────────────────────────────────────────────────
function loadRegistry(path) {
  if (!path) return [];
  if (!existsSync(path)) return [];
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new Error(`cannot read/parse registry ${path}: ${e.message}`); }
  return Array.isArray(data) ? data : (Array.isArray(data?.jobs) ? data.jobs : []);
}

function persistRegistry(path, record) {
  const list = loadRegistry(path);
  list.push(record);
  writeFileSync(path, JSON.stringify(list, null, 2) + '\n');
}

// ── create ────────────────────────────────────────────────────────────────────────────────────────
function create(job, opts) {
  // 1. schema first — an invalid job is never registered, never deduped.
  const { problems, warnings } = validateJob(job);
  if (problems.length) {
    return { result: { created: false, registered: false, reason: 'invalid-schema', problems, warnings }, exit: EXIT.INVALID };
  }

  // 2. LIST + DEDUP FIRST — before any capability check, so a re-run can never stack a duplicate.
  const registry = loadRegistry(opts.existing);
  const dupe = registry.find((r) => r && r.key === job.key);
  if (dupe) {
    return {
      result: {
        created: false, registered: false, reason: 'duplicate', key: job.key,
        existingId: dupe.id || null,
        note: `a routine with key "${job.key}" already exists — idempotent no-op, nothing new registered`,
      },
      exit: EXIT.OK,
    };
  }

  // 3. CAPABILITY LADDER — mint a verifiable id ONLY with a supported capability AND explicit authorization.
  const cap = opts.capability;
  if (!SUPPORTED.has(cap)) {
    return {
      result: {
        created: false, registered: false, reason: 'no-capability', capability: cap, key: job.key,
        note: `no supported scheduler capability on this platform — RemoteTrigger and CronCreate are Claude-Code-only; nothing was registered. Returning a ready brief for manual registration.`,
        brief: readyBrief(job),
      },
      exit: EXIT.UNCREATABLE,
    };
  }
  if (!opts.authorize) {
    return {
      result: {
        created: false, registered: false, reason: 'not-authorized', capability: cap, key: job.key,
        note: `capability ${cap} is available but the user has NOT authorized creation (pass --authorize); nothing was registered. Returning a ready brief.`,
        brief: readyBrief(job),
      },
      exit: EXIT.UNCREATABLE,
    };
  }

  // 4. create — verifiable id, persisted to the registry when one was supplied.
  const automationId = `${cap}:${job.key}`;
  const record = { key: job.key, id: automationId, capability: cap };
  if (opts.existing) persistRegistry(opts.existing, record);
  return {
    result: {
      created: true, registered: true, capability: cap, key: job.key, automationId,
      persisted: !!opts.existing,
      note: `registered via ${cap} as ${automationId}`,
      warnings,
    },
    exit: EXIT.OK,
  };
}

// ── output ────────────────────────────────────────────────────────────────────────────────────────
function emitJson(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function emitHumanValidate(res) {
  if (res.problems.length === 0) {
    console.log('✓ job schema is valid — schedulable');
    for (const wm of res.warnings) console.error(`  warn: ${wm}`);
    return;
  }
  console.error(`✗ job schema INVALID — ${res.problems.length} problem(s):`);
  for (const pm of res.problems) console.error(`  - ${pm}`);
  for (const wm of res.warnings) console.error(`  warn: ${wm}`);
}

function emitHumanCreate(r) {
  if (r.created) { console.log(`✓ created: ${r.automationId} (registered:true via ${r.capability})`); return; }
  console.error(`✗ not created (created:false, registered:false) — reason: ${r.reason}`);
  if (r.note) console.error(`  ${r.note}`);
  if (Array.isArray(r.problems)) for (const pm of r.problems) console.error(`  - ${pm}`);
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode !== 'validate' && opts.mode !== 'create') {
    console.error('usage: validate-job.mjs <validate|create> <job.json> [--json] [--capability <name>] [--authorize] [--existing <registry.json>]');
    process.exit(EXIT.USAGE);
  }
  if (!opts.file) { console.error('missing <job.json>'); process.exit(EXIT.USAGE); }

  let job;
  try { job = JSON.parse(readFileSync(opts.file, 'utf8')); }
  catch (e) { console.error(`cannot read/parse ${opts.file}: ${e.message}`); process.exit(EXIT.USAGE); }

  if (opts.mode === 'validate') {
    const res = validateJob(job);
    const exit = res.problems.length ? EXIT.INVALID : EXIT.OK;
    if (opts.json) emitJson({ valid: res.problems.length === 0, problems: res.problems, warnings: res.warnings });
    else emitHumanValidate(res);
    process.exit(exit);
  }

  // create
  let out;
  try { out = create(job, opts); }
  catch (e) { console.error(e.message); process.exit(EXIT.USAGE); }
  if (opts.json) emitJson(out.result);
  else emitHumanCreate(out.result);
  process.exit(out.exit);
}

main();
