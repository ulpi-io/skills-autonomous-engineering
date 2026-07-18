#!/usr/bin/env node
// test-workflow-journal.mjs — contract for the optional Claude Code live-workflow overlay.
//
// CAPTURED FORMAT PROVENANCE: CAPTURED_REAL_SAMPLE is the first four lines copied byte-for-byte on
// 2026-07-18 from a real local Claude Code journal (file mtime 2026-06-27T16:55:21Z) at
// ~/.claude/projects/<redacted-project>/<redacted-session>/subagents/workflows/
// wf_ccf7b76c-b64/journal.jsonl. Project/session components are redacted only to keep workstation paths
// out of the public fixture. The observed started/result envelopes are unchanged, not invented.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeProjectSlug, readWorkflowStatus, WORKFLOW_STALE_MS,
} from '../checkpoint-resume/scripts/lib/workflow-journal.mjs';

const CAPTURED_REAL_SAMPLE = [
  '{"type":"started","key":"v2:c6cd7f708940cafa3568e1d8c24d173ee854ca90cca765e9623f84a47bbe1040","agentId":"af8b3321747c8e6e5"}',
  '{"type":"started","key":"v2:13c2524fb2fe8a1d64c9c3b3953c0f41ea53aad8f6971123f60813153e5daa7d","agentId":"ad6c4670508aa9a62"}',
  '{"type":"started","key":"v2:321e7451ca5bd675f143aaf3fe818dc6fe8998a19e83ab3a5029a4871b279154","agentId":"adf99cd477a6820ce"}',
  '{"type":"result","key":"v2:321e7451ca5bd675f143aaf3fe818dc6fe8998a19e83ab3a5029a4871b279154","agentId":"adf99cd477a6820ce","result":{"findings":[]}}',
].join('\n') + '\n';

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'workflow-journal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, cwd: join(root, 'project_with space'), claudeDir: join(root, 'claude') };
}

function workflowDir({ cwd, claudeDir }, wf = 'wf_captured-real', session = 'session-id') {
  return join(claudeDir, 'projects', claudeProjectSlug(cwd), session, 'subagents', 'workflows', wf);
}

function writeJournal(env, text, { wf, session, mtimeMs } = {}) {
  const dir = workflowDir(env, wf, session);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'journal.jsonl');
  writeFileSync(file, text);
  if (mtimeMs != null) utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return { dir, file };
}

test('captured real sample computes started minus result and never opens agent transcripts', (t) => {
  const env = sandbox(t);
  const now = Date.parse('2026-07-18T10:00:00.000Z');
  const { dir } = writeJournal(env, CAPTURED_REAL_SAMPLE, { mtimeMs: now - 1_000 });
  const marker = join(dir, 'agent-af8b3321747c8e6e5.jsonl');
  symlinkSync('missing-private-agent-transcript', marker);

  const status = readWorkflowStatus(env.cwd, { claudeDir: env.claudeDir, now });
  assert.deepEqual(status, {
    wf: 'wf_captured-real',
    spawned: 3,
    done: 1,
    running: ['af8b3321747c8e6e5', 'ad6c4670508aa9a62'],
    mtime: '2026-07-18T09:59:59.000Z',
    stale: false,
  });
  assert.ok(lstatSync(marker).isSymbolicLink(), 'private agent marker must remain untouched');
});

test('absent project, absent wf directory, and wf without a journal all return null', (t) => {
  const env = sandbox(t);
  assert.equal(readWorkflowStatus(env.cwd, { claudeDir: env.claudeDir }), null);
  mkdirSync(join(env.claudeDir, 'projects', claudeProjectSlug(env.cwd), 'session-id', 'subagents', 'workflows'), { recursive: true });
  assert.equal(readWorkflowStatus(env.cwd, { claudeDir: env.claudeDir }), null);
  mkdirSync(workflowDir(env), { recursive: true });
  assert.equal(readWorkflowStatus(env.cwd, { claudeDir: env.claudeDir }), null);
});

test('newest workflow wins and format drift in that workflow fails safe instead of falling back', (t) => {
  const env = sandbox(t);
  const now = Date.parse('2026-07-18T10:00:00.000Z');
  writeJournal(env, CAPTURED_REAL_SAMPLE, { wf: 'wf_older', mtimeMs: now - 10_000 });
  writeJournal(env,
    '{"type":"started","key":"k","agentId":"a","unexpected":true}\n',
    { wf: 'wf_newer', session: 'another-session', mtimeMs: now - 1_000 });
  assert.equal(readWorkflowStatus(env.cwd, { claudeDir: env.claudeDir, now }), null);
});

test('unexpected entry keys, unknown types, and malformed complete lines return null', async (t) => {
  const cases = {
    emptyJournal: '',
    unexpectedKeys: '{"type":"started","key":"k","agentId":"a","extra":1}\n',
    unknownType: '{"type":"progress","key":"k","agentId":"a"}\n',
    wrongFieldType: '{"type":"started","key":"k","agentId":7}\n',
    malformedComplete: '{"type":"started","key":"k","agentId":"a"}\nnot-json\n',
  };
  for (const [name, text] of Object.entries(cases)) {
    await t.test(name, (st) => {
      const env = sandbox(st);
      writeJournal(env, text);
      assert.equal(readWorkflowStatus(env.cwd, { claudeDir: env.claudeDir }), null);
    });
  }
});

test('a syntactically truncated final append is discarded without losing complete entries', (t) => {
  const env = sandbox(t);
  writeJournal(env, CAPTURED_REAL_SAMPLE + '{"type":"started","key":"partial"');
  const status = readWorkflowStatus(env.cwd, { claudeDir: env.claudeDir });
  assert.equal(status?.spawned, 3);
  assert.equal(status?.done, 1);
  assert.deepEqual(status?.running, ['af8b3321747c8e6e5', 'ad6c4670508aa9a62']);
});

test('stale is derived from journal mtime with the pinned bounded threshold', (t) => {
  const env = sandbox(t);
  const now = Date.parse('2026-07-18T10:00:00.000Z');
  writeJournal(env, CAPTURED_REAL_SAMPLE, { mtimeMs: now - WORKFLOW_STALE_MS - 1 });
  assert.equal(readWorkflowStatus(env.cwd, { claudeDir: env.claudeDir, now })?.stale, true);
});
