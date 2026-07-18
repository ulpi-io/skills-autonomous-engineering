// Best-effort reader for Claude Code's EXTERNAL workflow journal format.
//
// This module deliberately knows only the project/session/workflow directory shape and the
// `journal.jsonl` started/result envelopes. It never walks a workflow directory recursively and never
// opens `agent-<id>.jsonl`; those transcripts are private runtime detail, not status input. The durable
// `.ulpi/runs/<id>.json` document remains authoritative for run status. Any external-format drift returns
// null so this optional live overlay cannot corrupt or downgrade durable state.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const WORKFLOW_STALE_MS = 30 * 60 * 1000;

export function claudeProjectSlug(cwd) {
  return resolve(cwd).replace(/[^A-Za-z0-9-]/g, '-');
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validEntry(entry) {
  if (entry?.type === 'started') {
    return exactKeys(entry, ['type', 'key', 'agentId'])
      && typeof entry.key === 'string' && entry.key.length > 0
      && typeof entry.agentId === 'string' && entry.agentId.length > 0;
  }
  if (entry?.type === 'result') {
    return exactKeys(entry, ['type', 'key', 'agentId', 'result'])
      && typeof entry.key === 'string' && entry.key.length > 0
      && typeof entry.agentId === 'string' && entry.agentId.length > 0;
  }
  return false;
}

function parseJournal(text) {
  if (typeof text !== 'string') return null;
  const endedWithNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (endedWithNewline) lines.pop();

  const entries = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line) return null;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // A process can die halfway through its final append. Only that syntactically-truncated final
      // line is discardable; malformed complete/intermediate lines mean format drift and fail closed.
      if (!endedWithNewline && index === lines.length - 1) break;
      return null;
    }
    if (!validEntry(entry)) return null;
    entries.push(entry);
  }
  return entries;
}

function newestJournal(projectDir) {
  const candidates = [];
  for (const session of readdirSync(projectDir, { withFileTypes: true })) {
    if (!session.isDirectory()) continue;
    const workflowsDir = join(projectDir, session.name, 'subagents', 'workflows');
    if (!existsSync(workflowsDir)) continue;
    for (const wf of readdirSync(workflowsDir, { withFileTypes: true })) {
      if (!wf.isDirectory() || !/^wf_[A-Za-z0-9-]+$/.test(wf.name)) continue;
      const file = join(workflowsDir, wf.name, 'journal.jsonl');
      if (!existsSync(file)) continue;
      const stat = statSync(file);
      if (stat.isFile()) candidates.push({ file, mtimeMs: stat.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file));
  return candidates[0] || null;
}

/**
 * Read the newest Claude Code workflow journal for `cwd`.
 *
 * `options` is an intentionally small test/config seam. Normal callers use readWorkflowStatus(cwd);
 * CLAUDE_CONFIG_DIR is honored when Claude stores its config outside ~/.claude.
 */
export function readWorkflowStatus(cwd, options = {}) {
  try {
    const claudeDir = options.claudeDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const staleAfterMs = options.staleAfterMs ?? WORKFLOW_STALE_MS;
    const now = options.now ?? Date.now();
    const projectDir = join(claudeDir, 'projects', claudeProjectSlug(cwd));
    if (!existsSync(projectDir)) return null;

    const newest = newestJournal(projectDir);
    if (!newest) return null;
    const entries = parseJournal(readFileSync(newest.file, 'utf8'));
    if (!entries || entries.length === 0) return null;

    const started = entries.filter((entry) => entry.type === 'started');
    const results = entries.filter((entry) => entry.type === 'result');
    const completedIds = new Set(results.map((entry) => entry.agentId));
    const running = [...new Set(started.map((entry) => entry.agentId))]
      .filter((agentId) => !completedIds.has(agentId));

    return {
      wf: basename(dirname(newest.file)),
      spawned: started.length,
      done: results.length,
      running,
      mtime: new Date(newest.mtimeMs).toISOString(),
      stale: !Number.isFinite(now) || !Number.isFinite(staleAfterMs)
        ? true
        : now - newest.mtimeMs > staleAfterMs,
    };
  } catch {
    return null;
  }
}
