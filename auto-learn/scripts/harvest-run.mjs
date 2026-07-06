#!/usr/bin/env node
// harvest-run.mjs — auto-learn's Phase 0 as CODE: mechanical learning-candidate extraction from a
// checkpoint file. No judgment here — that's Phase 1's adversarial gate — just faithful evidence
// collection: every candidate cites the artifact field it came from.
//
// Extracts:
//   blocked units        → each blocked/dep_blocked unit with its note (dep_blocked cites the root)
//   gate failures        → register/openItems entries with kind:'gate' (a phase that died or failed)
//   degradations         → kind:'delegation_degraded' (a codex role that ran native)
//   thrash signals       → units whose notes mention fix-loop exhaustion / repeated attempts
//   open findings        → remaining openItems grouped by phase (what the run could not close)
//
// Usage: node harvest-run.mjs <checkpoint.json> [--json]
// Exit:  0 = harvested (possibly zero candidates) · 2 = unreadable checkpoint

import { readFileSync } from 'node:fs';

const [file, ...rest] = process.argv.slice(2);
if (!file) { console.error('usage: harvest-run.mjs <checkpoint.json> [--json]'); process.exit(2); }
let doc;
try { doc = JSON.parse(readFileSync(file, 'utf8')); }
catch (e) { console.error(`cannot read/parse ${file}: ${e.message}`); process.exit(2); }

const candidates = [];
const add = (signal, detail, evidence) => candidates.push({ signal, detail, evidence });

for (const [id, u] of Object.entries(doc.units || {})) {
  if (u.status === 'blocked') add('blocked_unit', `unit '${id}' blocked: ${u.note || '(no note)'}`, `units.${id}`);
  if (u.status === 'dep_blocked') add('dep_blocked_unit', `unit '${id}' never ran — dependency chain root did not land (${u.note || 'see resume output'})`, `units.${id}`);
  if (/fix loop|attempt|retry|thrash/i.test(u.note || '')) add('thrash_signal', `unit '${id}' shows repeated-attempt note: ${u.note}`, `units.${id}.note`);
}
for (const it of doc.openItems || []) {
  if (it?.kind === 'gate') add('gate_failure', `[${it.phase}] ${it.why || it.issue || JSON.stringify(it).slice(0, 120)}`, 'openItems');
  else if (it?.kind === 'delegation_degraded') add('degradation', it.why || 'codex role degraded to native', 'openItems');
  else if (it) add('open_finding', `[${it.phase || '?'}] ${it.issue || it.why || JSON.stringify(it).slice(0, 120)}`, 'openItems');
}
if (doc.status === 'aborted') add('aborted_run', `run aborted: ${doc.result || '(no result recorded)'}`, 'status');

const out = {
  checkpoint: file, id: doc.id, status: doc.status,
  units: Object.keys(doc.units || {}).length,
  candidates: candidates.length,
  bySignal: candidates.reduce((a, c) => ((a[c.signal] = (a[c.signal] || 0) + 1), a), {}),
  items: candidates,
};
if (rest.includes('--json')) console.log(JSON.stringify(out, null, 2));
else if (!candidates.length) console.log(`no learning candidates in ${doc.id || file} — a clean run teaches by staying clean`);
else console.log(candidates.map(c => `[${c.signal}] ${c.detail} (${c.evidence})`).join('\n'));
process.exit(0);
