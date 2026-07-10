#!/usr/bin/env node
// checkpoint.mjs — the runnable side of the checkpoint-resume skill.
// Zero-dependency Node CLI for the durable status file (.ulpi/runs/<id>.json):
//   init, patch a unit/phase, query, upsert/resolve findings, record validation, compute resume, finalize.
//
// This is a THIN arg-parser over ./lib/checkpoint-store.mjs — the CLI and any in-process engine share
// ONE locked, atomic store (no second implementation to drift). All writes are ATOMIC (tmp + rename)
// and INCREMENTAL, and every command is NON-FATAL by design at the call site: `node checkpoint.mjs ... || true`.
//
// Every mutation is TIMESTAMPED (ISO-8601, UTC): the doc carries createdAt/updatedAt/finishedAt; each
// unit carries createdAt/updatedAt + startedAt/finishedAt; each phase carries startedAt/updatedAt/
// finishedAt; each register item carries `at`. A legible reader lives at ./run-status.mjs.
//
// Usage:
//   node checkpoint.mjs init <file> --task "<desc>" [--units "a,b,c"] [--id <id>] [--launch '<json>']
//                                   [--required-phases "p,q"] [--require-validation]
//   node checkpoint.mjs unit <file> <unit-id> <pending|in_progress|done|blocked|dep_blocked> [--note "<why>"] [--deps "x,y"]
//   node checkpoint.mjs phase <file> <phase> <pending|running|done|blocked|skipped>
//   node checkpoint.mjs get <file> [--summary]
//   node checkpoint.mjs resume <file>          # prints JSON { skip: [...], eligible: [...], dep_blocked: {unit: rootDep} }
//   node checkpoint.mjs item <file> --json '<object-or-array>'   # idempotent finding upsert (stable ids); prints assigned ids
//   node checkpoint.mjs resolve <file> --ids "id1,id2"          # move stable ids from openItems → durable resolvedItems
//   node checkpoint.mjs validation <file> <green|red> [--note "<why>"]   # record the run's FINAL validation result
//   node checkpoint.mjs finalize <file> <done|needs_attention|aborted> [--result "<summary>"]
//   node checkpoint.mjs gc <dir> [--keep-days 7]   # archive TERMINAL runs older than N days (never touches running)
//
// Exit codes: 0 ok · 1 usage/parse error · 2 refused (clobber live run / demote done unit / finalize-done with open work)

import * as store from './lib/checkpoint-store.mjs';
import { CheckpointError } from './lib/checkpoint-store.mjs';

function fail(msg, code = 1) { throw new CheckpointError(msg, code); }

function opt(args, name, dflt = undefined) {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) fail(`option ${name} is missing its value`);
  return v;
}

const csv = (s) => (s || '').split(',').map(x => x.trim()).filter(Boolean);

function main() {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (!cmd || !file) fail('usage: checkpoint.mjs <init|unit|phase|get|resume|item|resolve|validation|finalize|gc> <file|runs-dir> ...');

  switch (cmd) {
    case 'init': {
      const task = opt(rest, '--task');
      if (task === undefined) fail('init requires --task "<desc>"');
      const id = opt(rest, '--id');
      const units = csv(opt(rest, '--units', ''));
      const requiredPhases = csv(opt(rest, '--required-phases', ''));
      const requireValidation = rest.includes('--require-validation');
      let launch;
      const launchRaw = opt(rest, '--launch');
      if (launchRaw !== undefined) { try { launch = JSON.parse(launchRaw); } catch (e) { fail(`--launch is not valid JSON: ${e.message}`); } }
      const runId = store.init(file, { task, id, units, requiredPhases, requireValidation, launch });
      console.log(runId);
      break;
    }

    case 'unit': {
      const [unitId, status] = rest;
      const note = opt(rest, '--note');
      const depsRaw = opt(rest, '--deps');
      store.unit(file, unitId, status, {
        ...(note !== undefined ? { note } : {}),
        ...(depsRaw !== undefined ? { deps: csv(depsRaw) } : {}),
      });
      break;
    }

    case 'phase': {
      const [phaseName, status] = rest;
      store.phase(file, phaseName, status);
      break;
    }

    case 'get': {
      const doc = store.readDoc(file);
      if (rest.includes('--summary')) {
        const units = Object.entries(doc.units || {});
        const by = s => units.filter(([, u]) => u.status === s).map(([k]) => k);
        console.log(JSON.stringify({
          id: doc.id, status: doc.status, task: doc.task, currentPhase: doc.currentPhase ?? null,
          total: units.length, done: by('done').length,
          blocked: by('blocked'), dep_blocked: by('dep_blocked'), in_progress: by('in_progress'),
          updatedAt: doc.updatedAt,
        }, null, 2));
      } else {
        console.log(JSON.stringify(doc, null, 2));
      }
      break;
    }

    case 'resume': {
      console.log(JSON.stringify(store.resume(file), null, 2));
      break;
    }

    case 'item': {
      const raw = opt(rest, '--json');
      if (raw === undefined) fail('item requires --json \'<object-or-array>\'');
      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) { fail(`item --json is not valid JSON: ${e.message}`); }
      const ids = store.item(file, parsed);
      if (ids.length) console.log(JSON.stringify(ids));
      break;
    }

    case 'resolve': {
      const idsRaw = opt(rest, '--ids');
      let ids;
      if (idsRaw !== undefined) {
        ids = csv(idsRaw);
      } else {
        const j = opt(rest, '--json');
        if (j === undefined) fail('resolve requires --ids "id1,id2" (or --json \'["id1",...]\')');
        let parsed;
        try { parsed = JSON.parse(j); } catch (e) { fail(`resolve --json is not valid JSON: ${e.message}`); }
        ids = Array.isArray(parsed) ? parsed : [parsed];
      }
      const moved = store.resolve(file, ids);
      console.log(JSON.stringify(moved));
      break;
    }

    case 'validation': {
      const [status] = rest;
      const note = opt(rest, '--note');
      store.validation(file, status, note !== undefined ? { note } : {});
      break;
    }

    case 'finalize': {
      const [status] = rest;
      const result = opt(rest, '--result');
      store.finalize(file, status, result !== undefined ? { result } : {});
      break;
    }

    case 'gc': {
      const keepDays = Number(opt(rest, '--keep-days', '7'));
      const { archived, dir, reason } = store.gc(file, { keepDays });
      if (reason) console.log(`${archived} archived (${reason})`);
      else console.log(`${archived} archived to ${dir}/archive (terminal runs older than ${keepDays}d)`);
      break;
    }

    default:
      fail(`unknown command '${cmd}'`);
  }
}

try { main(); }
catch (e) {
  console.error(`checkpoint: ${e.message}`);
  process.exit(e instanceof CheckpointError ? e.code : 1);
}
