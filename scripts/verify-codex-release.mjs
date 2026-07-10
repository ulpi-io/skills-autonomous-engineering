#!/usr/bin/env node
// verify-codex-release.mjs — the deterministic release verifier for the versioned Codex artifact
// release (TASK-041 + TASK-050). It is called BOTH by the release workflow (self-audit + the
// digest-matched evidence gate) AND by scripts/test-release-workflow.mjs (fixtures proving every
// hardening class fails closed). It has two independent, composable modes:
//
//   --workflow <file>   STATIC hardening audit of a release workflow. Asserts: triggered ONLY by a
//                       protected version tag; minimal permissions (no write / write-all); an
//                       immutable 40-hex SHA pin on every action; checkout persist-credentials:false;
//                       a protected environment; Codex credentials scoped to the SAME live-smoke step
//                       only; the package/verify/live-smoke/evidence/upload chain ordered so upload is
//                       UNREACHABLE without matched live evidence; no skippable/masked gate; no
//                       post-package checkout edit; provenance/hash recorded; and it NEVER touches
//                       ~/.agents/plugins/marketplace.json.
//
//   --artifact <dir>    RUNTIME parity + provenance audit of a built artifact. With --tag it asserts
//     [--tag v]         tag == marketplace-catalog version == artifact-manifest version. With --digest
//     [--digest s]      it asserts a sha256 provenance hash is present. With --smoke-report <f> it
//     [--smoke-report]  asserts the live smoke was status:ok and its artifactSha256 EQUALS the built
//     [--provenance-out]digest (no stale digest), records commit/version/sha256/codexVersion, and (on a
//                       clean pass) writes the provenance JSON to --provenance-out.
//
// Any violation prints typed evidence (`VIOLATION <CODE>: …`) to stderr and exits nonzero. A clean run
// prints the provenance/OK summary and exits 0. Import surface for tests: auditWorkflow, parseSteps,
// verifyArtifact.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── small YAML-ish helpers (dependency-free; scoped to the shapes this workflow uses) ───────────────
function stripInlineComment(s) {
  let inS = false, inD = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD && (k === 0 || s[k - 1] === ' ')) return s.slice(0, k).trimEnd();
  }
  return s;
}
function scalar(v) {
  const s = stripInlineComment(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

// Parse the job `steps:` sequence into ordered step records with ABSOLUTE line ranges. Assumes the
// house indentation: `    steps:` (4), `      - ` step dash (6), step keys (8), nested maps (10).
export function parseSteps(text) {
  const lines = text.split('\n');
  const si = lines.findIndex((l) => /^ {4}steps:\s*$/.test(l));
  const steps = [];
  if (si < 0) return steps;
  let cur = null;
  let idx = 0;
  let i = si + 1;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (/^ {6}- /.test(l)) {
      if (cur) { cur.endLine = i - 1; steps.push(cur); }
      cur = { index: idx++, startLine: i, endLine: i, rawLines: [], name: '', id: '', uses: '', ifVal: null, continueOnError: false };
      cur.rawLines.push(l);
      continue;
    }
    if (cur && (l.trim() === '' || /^ {8}/.test(l))) { cur.rawLines.push(l); continue; }
    if (l.trim() === '' || /^\s*#/.test(l)) continue; // stray blank / comment between steps
    break; // dedent below step content and not a new dash → steps block ended
  }
  if (cur) { cur.endLine = i - 1; steps.push(cur); }
  for (const s of steps) {
    s.raw = s.rawLines.join('\n');
    const norm = s.rawLines.map((ln, k) => (k === 0 ? ln.replace(/^ {6}- /, '        ') : ln));
    for (const ln of norm) {
      let m;
      if ((m = /^ {8}name:\s*(.*)$/.exec(ln))) s.name = scalar(m[1]);
      else if ((m = /^ {8}id:\s*(.*)$/.exec(ln))) s.id = scalar(m[1]);
      else if ((m = /^ {8}uses:\s*(.*)$/.exec(ln))) s.uses = scalar(m[1]);
      else if ((m = /^ {8}if:\s*(.*)$/.exec(ln))) s.ifVal = scalar(m[1]);
      else if ((m = /^ {8}continue-on-error:\s*(.*)$/.exec(ln))) s.continueOnError = /true/i.test(m[1]);
    }
  }
  return steps;
}

// Raw text of the block under a top-level `key:` (indent 0) until the next indent-0 key.
function topBlock(lines, key) {
  const start = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (start < 0) return null;
  const inline = lines[start].slice(lines[start].indexOf(':') + 1).trim();
  const body = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') { body.push(lines[i]); continue; }
    if (/^\S/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return { inline, text: body.join('\n') };
}

const SHA_PIN = /@[0-9a-f]{40}$/;

// ── the static workflow audit ───────────────────────────────────────────────────────────────────────
// Returns an array of { code, message }. Empty array === fully hardened.
export function auditWorkflow(text) {
  const v = [];
  const push = (code, message) => v.push({ code, message });
  const lines = text.split('\n');
  // Comment-stripped view (same indices) for whole-file scans, so documentation prose that legitimately
  // NAMES a forbidden pattern (e.g. "never touches ~/.agents/…") is not mistaken for a real command.
  const code = lines.map(stripInlineComment);
  const steps = parseSteps(text);

  // 1) TRIGGER — protected version tag ONLY.
  const on = topBlock(lines, 'on');
  if (!on) push('TRIGGER_NOT_TAG', 'no `on:` trigger block');
  else {
    const t = on.text;
    if (!/\btags:/.test(t)) push('TRIGGER_NOT_TAG', 'trigger has no `tags:` filter — release must fire only on a version tag');
    if (/\bbranches:/.test(t)) push('TRIGGER_NOT_TAG', 'trigger includes `branches:` — a branch push must not release');
    if (/pull_request/.test(t)) push('TRIGGER_NOT_TAG', 'trigger includes `pull_request` — a PR must not release');
    if (/workflow_dispatch/.test(t)) push('TRIGGER_NOT_TAG', 'trigger includes `workflow_dispatch` — manual dispatch bypasses the tag gate');
    if (/\bschedule:/.test(t)) push('TRIGGER_NOT_TAG', 'trigger includes `schedule:` — a cron must not release');
  }

  // 2) PERMISSIONS — a minimal top-level block, and no write / write-all anywhere.
  if (!topBlock(lines, 'permissions')) push('MISSING_PERMISSIONS', 'no top-level `permissions:` block — the default token scope is too broad');
  code.forEach((l, i) => {
    const m = /^(\s*)permissions:\s*(.*)$/.exec(l);
    if (!m) return;
    const ind = m[1].length;
    if (/\bwrite(-all)?\b/.test(m[2])) push('EXCESSIVE_PERMISSION', `inline permissions grants write at line ${i + 1}: ${l.trim()}`);
    for (let j = i + 1; j < code.length; j++) {
      const c = code[j];
      if (c.trim() === '') continue;
      if ((c.match(/^( *)/)[0].length) <= ind) break;
      if (/\bwrite(-all)?\b/.test(c)) push('EXCESSIVE_PERMISSION', `permissions block grants write at line ${j + 1}: ${c.trim()}`);
    }
  });

  // 3) ENVIRONMENT — the release job runs under a protected environment (fresh authorization).
  if (!lines.some((l) => /^ {4}environment:/.test(l))) push('MISSING_ENVIRONMENT', 'the release job declares no protected `environment:` — no fresh per-run authorization');

  // 4) IMMUTABLE PINS — every `uses:` is an exact 40-hex commit SHA.
  for (const s of steps) {
    if (!s.uses) continue;
    if (!SHA_PIN.test(s.uses)) push('MUTABLE_ACTION_REF', `step '${s.name || s.id}' pins a mutable ref: ${s.uses} (require owner/repo@<40-hex-sha>)`);
  }

  // 5) CHECKOUT — persist-credentials:false so the git token is not left on disk for later steps.
  for (const s of steps) {
    if (!/actions\/checkout/.test(s.uses)) continue;
    if (!/persist-credentials:\s*false/.test(s.raw)) push('PERSIST_CREDENTIALS', `checkout step '${s.name || s.id}' does not set persist-credentials:false`);
  }

  // role resolution
  const pkg = steps.find((s) => /package-codex-plugin\.mjs/.test(s.raw));
  const verify = steps.find((s) => /verify-codex-release\.mjs/.test(s.raw) && /--artifact/.test(s.raw));
  const smoke = steps.find((s) => /smoke-codex-plugin\.mjs/.test(s.raw) && /--live/.test(s.raw));
  const evidence = steps.find((s) => /--smoke-report/.test(s.raw));
  const upload = steps.find((s) => s.id === 'upload');

  // 6) LIVE SMOKE present and CREDENTIALS SCOPED to it alone.
  if (!smoke) push('MISSING_LIVE_SMOKE', 'no same-run `smoke-codex-plugin.mjs --live` step against the built artifact');
  else if (!/secrets\./.test(smoke.raw)) push('MISSING_LIVE_CREDENTIAL', `live-smoke step '${smoke.name || smoke.id}' references no Codex secret — it cannot authenticate and would gateNotRun`);
  code.forEach((l, i) => {
    if (!/secrets\./.test(l)) return;
    if (!smoke || i < smoke.startLine || i > smoke.endLine) push('CREDENTIAL_SCOPE_LEAK', `credential reference outside the live-smoke step at line ${i + 1}: ${l.trim()}`);
  });

  // 7) PACKAGE / VERIFY / EVIDENCE present.
  if (!pkg) push('MISSING_PACKAGE_STEP', 'no `package-codex-plugin.mjs` packaging step');
  if (!verify) push('MISSING_VERSION_PARITY_GATE', 'no `verify-codex-release.mjs --artifact … --tag …` version-parity gate');
  if (!evidence) push('MISSING_DIGEST_MATCH', 'no digest-matched evidence step (verify-codex-release.mjs --smoke-report …) binding the live smoke to the built digest');
  else {
    if (!/--digest/.test(evidence.raw)) push('MISSING_DIGEST_MATCH', 'the evidence step does not pass --digest — it cannot detect a stale digest');
    if (!/--provenance-out/.test(evidence.raw)) push('MISSING_PROVENANCE', 'the evidence step records no provenance (--provenance-out) before upload');
  }

  // 8) UPLOAD unreachable without matched live evidence.
  if (!upload) push('UPLOAD_UNGATED', 'no `id: upload` publish step');
  else {
    if (!upload.ifVal || !/steps\.\w+\.outputs\.matched/.test(upload.ifVal)) push('UPLOAD_UNGATED', `upload step is not gated on matched live evidence (if: ${upload.ifVal || '<none>'})`);
    if (upload.ifVal && /(always|failure|cancelled)\s*\(/.test(upload.ifVal)) push('UPLOAD_UNGATED', `upload step if:${upload.ifVal} forces execution even on failure/cancel`);
    if (pkg && verify && smoke && evidence) {
      const ok = pkg.index < verify.index && verify.index < smoke.index && smoke.index < evidence.index && evidence.index < upload.index;
      if (!ok) push('UPLOAD_UNGATED', 'the package→verify→live-smoke→evidence→upload steps are out of order — a gate could be bypassed');
    }
  }

  // 9) NO SKIPPABLE / MASKED GATE — non-upload steps must always run (no `if:`, no continue-on-error).
  for (const s of steps) {
    if (s.id === 'upload') continue;
    if (s.continueOnError) push('SKIPPABLE_GATE', `step '${s.name || s.id}' sets continue-on-error — a red gate would be masked`);
    if (s.ifVal) push('SKIPPABLE_GATE', `gate step '${s.name || s.id}' has an if: (${s.ifVal}) — it could be skipped while upload still runs`);
  }

  // 10) NO POST-PACKAGE CHECKOUT EDIT — the tree is frozen once packaged.
  if (pkg) {
    for (const s of steps) {
      if (s.index <= pkg.index) continue;
      if (/actions\/checkout/.test(s.uses)) push('POST_PACKAGE_CHECKOUT_EDIT', `step '${s.name || s.id}' re-checks-out after packaging — the packaged tree must be frozen`);
      if (/\bgit\s+(checkout|commit|add|reset|restore|apply|rm|stash|clean)\b/.test(s.raw)) push('POST_PACKAGE_CHECKOUT_EDIT', `step '${s.name || s.id}' mutates the git tree after packaging`);
    }
  }

  // 11) NEVER touch the user-global marketplace.
  code.forEach((l, i) => {
    if (/(~|\$HOME|\$\{HOME\})\/\.agents\/plugins\/marketplace\.json/.test(l)) push('MARKETPLACE_GLOBAL_MUTATION', `references the user-global marketplace at line ${i + 1}: ${l.trim()}`);
  });

  return v;
}

// ── the runtime artifact / parity / provenance audit ─────────────────────────────────────────────────
const SHA256 = /^sha256:[0-9a-f]{64}$/;
function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

export function verifyArtifact(opts) {
  const { artifactDir, provenanceOut } = opts;
  const v = [];
  const push = (code, message) => v.push({ code, message });
  const norm = (x) => (x == null ? null : String(x).replace(/^v/, ''));
  const tag = norm(opts.tag);
  const digest = opts.digest || null;

  let catalogVersion = null, artifactVersion = null, pluginName = null, catalogCount = null;

  const mkPath = join(artifactDir, '.agents', 'plugins', 'marketplace.json');
  if (!existsSync(mkPath)) push('ARTIFACT_INCOMPLETE', `missing curated marketplace source: ${mkPath}`);
  else {
    let mk;
    try { mk = readJson(mkPath); } catch (e) { push('ARTIFACT_INCOMPLETE', `marketplace.json unreadable: ${e.message}`); }
    const pl = mk && Array.isArray(mk.plugins) ? mk.plugins[0] : null;
    if (!pl) push('ARTIFACT_INCOMPLETE', 'marketplace.json has no plugins[0]');
    else { catalogVersion = pl.version != null ? String(pl.version) : null; pluginName = pl.name || null; }
  }

  if (pluginName) {
    const manPath = join(artifactDir, 'plugins', pluginName, '.codex-plugin', 'plugin.json');
    if (!existsSync(manPath)) push('ARTIFACT_INCOMPLETE', `missing artifact manifest: ${manPath}`);
    else {
      try { artifactVersion = String(readJson(manPath).version); } catch (e) { push('ARTIFACT_INCOMPLETE', `artifact manifest unreadable: ${e.message}`); }
    }
    const catPath = join(artifactDir, 'plugins', pluginName, 'codex-skills', 'catalog.json');
    if (existsSync(catPath)) { try { const c = readJson(catPath); catalogCount = Array.isArray(c.skills) ? c.skills.length : (c.count ?? null); } catch { /* soft */ } }
  }

  // parity: tag == catalog (marketplace) == artifact manifest
  if (tag != null) {
    if (catalogVersion != null && artifactVersion != null &&
        !(tag === catalogVersion && tag === artifactVersion && catalogVersion === artifactVersion)) {
      push('VERSION_PARITY', `version drift — tag=${tag} catalog=${catalogVersion} artifact=${artifactVersion} must all match`);
    }
  }

  // provenance hash present
  if (!digest || !SHA256.test(digest)) push('MISSING_PROVENANCE', `no valid sha256 provenance digest (got ${digest == null ? '<none>' : digest})`);

  // live evidence binding
  let commit = null, codexVersion = null, smokeStatus = null;
  if (opts.smokeReport != null) {
    let rep = opts.smokeReport;
    if (typeof rep === 'string') {
      if (existsSync(rep)) { try { rep = readJson(rep); } catch (e) { push('LIVE_SMOKE_NOT_OK', `smoke report unreadable: ${e.message}`); rep = null; } }
      else { push('LIVE_SMOKE_NOT_OK', `smoke report file missing: ${rep}`); rep = null; }
    }
    if (rep) {
      smokeStatus = rep.status || null;
      if (rep.status !== 'ok') push('LIVE_SMOKE_NOT_OK', `live smoke did not pass (status=${rep.status}${rep.reason ? `: ${rep.reason}` : ''}) — cannot release`);
      const ev = rep.evidence || {};
      commit = ev.commit || null;
      codexVersion = ev.codexVersion || null;
      if (digest && SHA256.test(digest)) {
        if (!ev.artifactSha256) push('MISSING_PROVENANCE', 'live smoke evidence carries no artifactSha256 to match against the built digest');
        else if (ev.artifactSha256 !== digest) push('DIGEST_MISMATCH', `stale digest — built ${digest} but the live smoke exercised ${ev.artifactSha256}`);
      }
      if (tag != null && ev.manifestVersion != null && String(ev.manifestVersion) !== tag) {
        push('VERSION_PARITY', `live smoke manifestVersion ${ev.manifestVersion} != tag ${tag}`);
      }
      if (!commit) push('MISSING_PROVENANCE', 'live smoke evidence records no commit — provenance is incomplete');
    }
  }

  const provenance = {
    commit,
    version: tag,
    sha256: digest,
    catalogVersion,
    artifactVersion,
    catalogCount,
    codexVersion,
    smokeStatus,
    generatedAt: new Date().toISOString(),
  };
  if (provenanceOut && v.length === 0) writeFileSync(provenanceOut, `${JSON.stringify(provenance, null, 2)}\n`);
  return { violations: v, provenance };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────
function parseArgv(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => argv[++i];
    if (a === '--workflow') o.workflow = take();
    else if (a === '--artifact') o.artifact = take();
    else if (a === '--tag') o.tag = take();
    else if (a === '--digest') o.digest = take();
    else if (a === '--smoke-report') o.smokeReport = take();
    else if (a === '--provenance-out') o.provenanceOut = take();
    else { process.stderr.write(`✗ unknown argument: ${a}\n`); process.exit(2); }
  }
  return o;
}

function isMain() {
  try { return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]; }
  catch { return false; }
}

if (isMain()) {
  const o = parseArgv(process.argv.slice(2));
  if (!o.workflow && !o.artifact) { process.stderr.write('usage: verify-codex-release.mjs --workflow <file> | --artifact <dir> [--tag v] [--digest s] [--smoke-report f] [--provenance-out f]\n'); process.exit(2); }
  const all = [];
  if (o.workflow) {
    if (!existsSync(o.workflow)) { process.stderr.write(`✗ workflow not found: ${o.workflow}\n`); process.exit(2); }
    for (const viol of auditWorkflow(readFileSync(o.workflow, 'utf8'))) all.push(viol);
  }
  let provenance = null;
  if (o.artifact) {
    const res = verifyArtifact({
      artifactDir: o.artifact, tag: o.tag, digest: o.digest,
      smokeReport: o.smokeReport, provenanceOut: o.provenanceOut,
    });
    provenance = res.provenance;
    for (const viol of res.violations) all.push(viol);
  }
  if (all.length) {
    for (const viol of all) process.stderr.write(`VIOLATION ${viol.code}: ${viol.message}\n`);
    process.stderr.write(`✗ verify-codex-release: ${all.length} violation(s) — release BLOCKED\n`);
    process.exit(1);
  }
  if (provenance) {
    process.stdout.write(`✓ release verified — commit=${provenance.commit ?? 'n/a'} version=${provenance.version ?? 'n/a'} sha256=${provenance.sha256 ?? 'n/a'}\n`);
    process.stdout.write(`${JSON.stringify(provenance, null, 2)}\n`);
  } else {
    process.stdout.write('✓ workflow hardening audit passed — 0 violations\n');
  }
  process.exit(0);
}
