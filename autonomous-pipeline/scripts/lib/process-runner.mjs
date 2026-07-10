// process-runner.mjs — the argv-only child-process runner behind the Codex-native pipeline coordinator.
//
// Every external process the coordinator drives (Codex, git plumbing, gates) runs THROUGH this one
// choke point so a single, audited policy governs isolation, size, time and cancellation:
//
//   * NEVER a shell.  We spawn an execFile-style argv (file + string[]), so word-splitting / glob /
//     interpolation are structurally impossible — a prompt or path can never become a command.
//   * WHOLE-GROUP kill.  The child is spawned `detached` (its own process group, pgid === pid); on
//     timeout / cancellation / output-ceiling we `kill(-pgid)` so NO descendant outlives the run. On
//     an otherwise-clean exit we PROBE the group (`kill(-pgid, 0)`) and, if any descendant survives,
//     terminate the group and report the run BLOCKED — a leaked background process is never "success".
//   * BOUNDED output.  stdout+stderr are captured up to a byte ceiling; crossing it truncates, kills
//     the group, and blocks (a runaway writer can't OOM the coordinator).
//   * BOUNDED time.  A timeout kills the group and blocks.
//   * CANCELLABLE.  An AbortSignal kills the group and blocks.
//
// The result is a single TYPED object — `{ status:'ok'|'blocked', reason, code, signal, timedOut,
// cancelled, killed, truncated, stdout, stderr, ... }` — never a throw for a non-zero child (a throw is
// reserved for a programming error in the CALL itself). Zero external deps. Node 22+.

import { spawn } from 'node:child_process';

export const DEFAULT_TIMEOUT_MS = 120_000;          // 2 min: a generous per-process ceiling
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024; // 8 MiB combined stdout+stderr

// Blocked reasons, in the order of precedence finalize() applies them.
export const BLOCK_REASONS = Object.freeze([
  'spawn-error',          // the executable could not be started (ENOENT / EACCES / …)
  'output-ceiling',       // combined output exceeded maxOutputBytes
  'timeout',              // wall-clock timeout fired
  'cancelled',            // an AbortSignal aborted the run
  'signal',               // the child died from a signal
  'exit',                 // the child exited non-zero
  'surviving-descendant', // the child exited clean but left a live process-group member
]);

// Send `sig` to the whole process group; fall back to the single child if the group send fails
// (e.g. the leader already reaped). Always best-effort — a failed kill never throws out of here.
function killGroup(child, pgid, sig) {
  let sent = false;
  if (pgid != null) {
    try { process.kill(-pgid, sig); sent = true; } catch { /* group gone */ }
  }
  if (!sent) {
    try { child.kill(sig); } catch { /* child gone */ }
  }
}

// True if any member of the process group `pgid` is still alive. Signal 0 performs the permission/
// existence check without delivering a signal; ESRCH ⇒ nobody left.
function groupAlive(pgid) {
  if (pgid == null) return false;
  try { process.kill(-pgid, 0); return true; } catch { return false; }
}

export function runProcess(opts = {}) {
  const {
    file,
    args = [],
    cwd,
    env,
    stdin = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    signal, // optional AbortSignal
  } = opts;

  // A bad CALL is a programming error → reject (not a blocked child result).
  if (typeof file !== 'string' || file.length === 0) {
    return Promise.reject(new TypeError('runProcess: `file` must be a non-empty string'));
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    return Promise.reject(new TypeError('runProcess: `args` must be a string[]'));
  }

  const startedAt = Date.now();

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env,
        detached: true,                    // OWN process group → group-kill reaches every descendant
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,                      // NEVER a shell
      });
    } catch (err) {
      resolve({
        status: 'blocked', ok: false, blocked: true, reason: 'spawn-error',
        code: null, signal: null, timedOut: false, cancelled: false, killed: false,
        truncated: false, stdout: '', stderr: '', error: String((err && err.message) || err),
        pid: null, durationMs: Date.now() - startedAt,
      });
    }
    if (!child) return;

    // `detached` makes the child its own group leader, so the group id equals its pid.
    const pgid = typeof child.pid === 'number' ? child.pid : null;

    let settled = false;
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let killed = false;
    let spawnErr = null;
    let exitCode = null;
    let exitSignal = null;
    let timer = null;

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal) { try { signal.removeEventListener('abort', onAbort); } catch { /* noop */ } }
    };

    const kill = (sig) => { killed = true; killGroup(child, pgid, sig); };

    // Enforce the combined output ceiling; crossing it truncates + kills the group.
    const enforceCeiling = () => {
      if (truncated) return;
      if (stdout.length + stderr.length > maxOutputBytes) {
        truncated = true;
        if (stdout.length > maxOutputBytes) stdout = stdout.slice(0, maxOutputBytes);
        if (stderr.length > maxOutputBytes) stderr = stderr.slice(0, maxOutputBytes);
        kill('SIGKILL');
      }
    };

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => { stdout += d; enforceCeiling(); });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => { stderr += d; enforceCeiling(); });
    }

    // Feed the prompt on stdin and close it. Ignore EPIPE if the child never reads.
    if (child.stdin) {
      child.stdin.on('error', () => { /* EPIPE: child closed stdin early — not our failure */ });
      try { child.stdin.end(stdin); } catch { /* already closed */ }
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => { timedOut = true; kill('SIGKILL'); }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }

    function onAbort() { cancelled = true; kill('SIGKILL'); }
    if (signal) {
      if (signal.aborted) queueMicrotask(onAbort);
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => { spawnErr = String((err && err.message) || err); finalize(); });
    child.on('exit', (code, sig) => { exitCode = code; exitSignal = sig; });
    child.on('close', () => finalize());

    function finalize() {
      if (settled) return;
      settled = true;
      cleanup();

      // Would this have been a clean success absent any leaked descendant?
      const cleanExit = !spawnErr && !truncated && !timedOut && !cancelled
        && exitSignal == null && exitCode === 0;

      let survivingDescendant = false;
      if (cleanExit) {
        // The leader has exited (reaped by node); any group member still alive is a leaked descendant.
        if (groupAlive(pgid)) { survivingDescendant = true; killGroup(child, pgid, 'SIGKILL'); killed = true; }
      } else {
        // Non-clean paths already fired a group kill (or had nothing to kill); make cleanup certain.
        if (groupAlive(pgid)) { killGroup(child, pgid, 'SIGKILL'); killed = true; }
      }

      let reason = null;
      if (spawnErr) reason = 'spawn-error';
      else if (truncated) reason = 'output-ceiling';
      else if (timedOut) reason = 'timeout';
      else if (cancelled) reason = 'cancelled';
      else if (exitSignal != null) reason = 'signal';
      else if (exitCode !== 0) reason = 'exit';
      else if (survivingDescendant) reason = 'surviving-descendant';

      const status = reason == null ? 'ok' : 'blocked';
      resolve({
        status,
        ok: status === 'ok',
        blocked: status === 'blocked',
        reason,
        code: exitCode,
        signal: exitSignal,
        timedOut,
        cancelled,
        killed,
        truncated,
        stdout,
        stderr,
        error: spawnErr,
        pid: pgid,
        durationMs: Date.now() - startedAt,
      });
    }
  });
}
