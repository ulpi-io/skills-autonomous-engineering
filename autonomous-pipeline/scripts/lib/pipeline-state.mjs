// pipeline-state.mjs — the PURE lifecycle state machine for autonomous-pipeline.
//
// Zero I/O, zero side effects, deterministic. Every function is a total function of its inputs so the
// coordinator (or any harness) can reason about a pipeline's legality, resumability and convergence
// WITHOUT touching a filesystem, a clock, or a network. This is the single source of truth for:
//   • the legal state transitions of a phase or a build unit (pending/running/done/blocked/skipped),
//   • optional-phase SKIP handling (only optional phases may be skipped),
//   • RESUME selection — which phases / units are still runnable,
//   • REQUIRED-gate sequencing — a blocked OR unrun required upstream phase makes every downstream
//     phase non-runnable (fail-closed: you cannot run past a gate that has not gone green), and
//   • the explicit CONVERGENCE conjunction (see `converged` / `convergenceFailures`).
//
// The canonical states mirror the checkpoint schema in references/pipeline-state.md. `running` is the
// honest "in progress / crashed mid-flight" state: it is NOT terminal, so a phase or unit left `running`
// by an interrupted run is re-entered on resume rather than skipped.

/** The five canonical lifecycle states, in no particular order. */
export const STATES = Object.freeze(['pending', 'running', 'done', 'blocked', 'skipped']);

/** Terminal states — a phase/unit here is finished and is NOT re-run on resume. */
export const TERMINAL_STATES = Object.freeze(['done', 'skipped']);

// The transition table. A state maps to the set of states it may legally move to. Everything not listed
// is illegal. `skipped` is reachable only from `pending` AND only for an optional phase (enforced below).
const TRANSITIONS = Object.freeze({
  pending: Object.freeze(['running', 'skipped']),
  running: Object.freeze(['done', 'blocked']),
  blocked: Object.freeze(['running']), // resume re-enters a blocked phase; it never jumps straight to done
  done: Object.freeze([]), // terminal
  skipped: Object.freeze([]), // terminal
});

/**
 * The canonical workflow-owned phases, in execution order, each tagged required vs optional. These are the
 * six keys the Workflow owns (spec/plan/approval are skill-owned and happen before launch). Optional phases
 * (`simplify`, `performance`, `ship_prep`) may be skipped by user config; `build`/`test`/`review` may not.
 */
export const PHASES = Object.freeze([
  Object.freeze({ name: 'build', optional: false }),
  Object.freeze({ name: 'simplify', optional: true }),
  Object.freeze({ name: 'test', optional: false }),
  Object.freeze({ name: 'review', optional: false }),
  Object.freeze({ name: 'performance', optional: true }),
  Object.freeze({ name: 'ship_prep', optional: true }),
]);

/** @returns {boolean} whether `s` is one of the five canonical states. */
export function isState(s) {
  return STATES.includes(s);
}

/** @returns {boolean} whether `s` is a terminal state (done | skipped). */
export function isTerminal(s) {
  return TERMINAL_STATES.includes(s);
}

/** @returns {boolean} whether the named phase is optional (skippable) in the given phase defs. */
export function isOptionalPhase(name, phaseDefs = PHASES) {
  const def = phaseDefs.find((p) => p.name === name);
  return def ? def.optional === true : false;
}

/**
 * Legal-transition validation. Pure predicate — never throws.
 * @param {string} from current state
 * @param {string} to proposed next state
 * @param {{optional?: boolean}} [opts] optional:true marks the phase as skippable (required for → skipped)
 * @returns {boolean} true iff `from → to` is a legal transition
 */
export function isLegalTransition(from, to, opts = {}) {
  if (!isState(from) || !isState(to)) return false;
  if (!TRANSITIONS[from].includes(to)) return false;
  // A skip is only legal for an optional phase — a required phase can never be skipped.
  if (to === 'skipped' && opts.optional !== true) return false;
  return true;
}

/**
 * Apply a transition, returning the new state. Throws on an illegal transition (fail-closed: an illegal
 * move is a bug the caller must not silently swallow).
 * @param {string} from
 * @param {string} to
 * @param {{optional?: boolean}} [opts]
 * @returns {string} `to`
 */
export function applyTransition(from, to, opts = {}) {
  if (!isState(from)) throw new Error(`illegal transition: unknown from-state "${from}"`);
  if (!isState(to)) throw new Error(`illegal transition: unknown to-state "${to}"`);
  if (!isLegalTransition(from, to, opts)) {
    const why = to === 'skipped' && opts.optional !== true
      ? ' (only an optional phase may be skipped)'
      : '';
    throw new Error(`illegal transition: ${from} → ${to}${why}`);
  }
  return to;
}

/**
 * The required phases that sit upstream of `name` in execution order (optional phases never gate).
 * @param {string} name
 * @param {ReadonlyArray<{name:string,optional:boolean}>} [phaseDefs]
 * @returns {string[]} names of required upstream phases, in order
 */
export function requiredUpstream(name, phaseDefs = PHASES) {
  const idx = phaseDefs.findIndex((p) => p.name === name);
  if (idx < 0) return [];
  return phaseDefs.slice(0, idx).filter((p) => p.optional === false).map((p) => p.name);
}

/**
 * Whether every REQUIRED upstream phase of `name` has gone green (state === 'done'). A required upstream
 * that is pending/running/blocked (i.e. unrun or blocked) is NOT cleared — the gate is closed.
 * @param {string} name
 * @param {Record<string,string>} phaseStates map of phase name → state
 * @param {ReadonlyArray<{name:string,optional:boolean}>} [phaseDefs]
 * @returns {boolean}
 */
export function requiredUpstreamCleared(name, phaseStates, phaseDefs = PHASES) {
  return requiredUpstream(name, phaseDefs).every((up) => phaseStates[up] === 'done');
}

/**
 * Whether a phase is runnable right now: it is not terminal (there is work left to do) AND every required
 * upstream gate is green. A phase left `running` by a crash is runnable (re-entered on resume).
 * @param {string} name
 * @param {Record<string,string>} phaseStates
 * @param {ReadonlyArray<{name:string,optional:boolean}>} [phaseDefs]
 * @returns {boolean}
 */
export function isPhaseRunnable(name, phaseStates, phaseDefs = PHASES) {
  const state = phaseStates[name];
  if (state === undefined) return false; // unknown phase — not part of this pipeline
  if (isTerminal(state)) return false; // done or skipped — nothing to run
  return requiredUpstreamCleared(name, phaseStates, phaseDefs);
}

/**
 * RESUME selection for phases: the ordered list of phase names that are runnable given the current states.
 * (A downstream phase gated by a blocked/unrun required upstream is excluded.)
 * @param {Record<string,string>} phaseStates
 * @param {ReadonlyArray<{name:string,optional:boolean}>} [phaseDefs]
 * @returns {string[]}
 */
export function runnablePhases(phaseStates, phaseDefs = PHASES) {
  return phaseDefs
    .map((p) => p.name)
    .filter((name) => isPhaseRunnable(name, phaseStates, phaseDefs));
}

/**
 * Whether a build unit is runnable: not terminal AND all of its declared dependencies are done.
 * @param {string} id unit id
 * @param {Record<string,{status:string,dependsOn?:string[]}>} units
 * @returns {boolean}
 */
export function isUnitRunnable(id, units) {
  const u = units[id];
  if (!u) return false;
  if (isTerminal(u.status)) return false;
  const deps = Array.isArray(u.dependsOn) ? u.dependsOn : [];
  return deps.every((d) => units[d] && units[d].status === 'done');
}

/**
 * RESUME selection for build units: the ids of every unit that is still runnable (dependency-gated).
 * @param {Record<string,{status:string,dependsOn?:string[]}>} units
 * @returns {string[]}
 */
export function runnableUnits(units) {
  return Object.keys(units).filter((id) => isUnitRunnable(id, units));
}

/**
 * The explicit reasons a pipeline is NOT converged. An empty array means converged. Convergence is the
 * conjunction:
 *   converged === (every unit done)
 *              AND (every required phase done, and every optional phase done or legitimately skipped)
 *              AND (no unresolved blocker: no phase/unit in `blocked`, and no open register items)
 *              AND (final validation is present AND green).
 *
 * @param {object} state
 * @param {Record<string,{status:string}>} [state.units] build units
 * @param {Record<string,string>} [state.phases] phase name → state
 * @param {ReadonlyArray<{name:string,optional:boolean}>} [state.phaseDefs]
 * @param {Array<any>} [state.openItems] the open register (verified blocking findings)
 * @param {{passed:boolean}|null|undefined} [state.finalValidation] final workspace validation result
 * @returns {Array<{code:string, detail:string}>}
 */
export function convergenceFailures(state = {}) {
  const {
    units = {},
    phases = {},
    phaseDefs = PHASES,
    openItems = [],
    finalValidation = null,
  } = state;
  const failures = [];

  // 1. Every build unit must be done.
  for (const [id, u] of Object.entries(units)) {
    if (!u || u.status !== 'done') {
      failures.push({ code: 'unit-unfinished', detail: `unit ${id} is ${u ? u.status : 'undefined'}, not done` });
    }
  }

  // 2. Every REQUIRED phase must be done; every OPTIONAL phase must be done or legitimately skipped.
  for (const def of phaseDefs) {
    const st = phases[def.name];
    if (st === 'done') continue;
    if (def.optional && st === 'skipped') continue; // legitimately skipped optional phase
    if (!def.optional && st === 'skipped') {
      failures.push({ code: 'required-phase-skipped', detail: `required phase ${def.name} was illegitimately skipped` });
    } else {
      failures.push({ code: 'phase-not-green', detail: `phase ${def.name} is ${st === undefined ? 'unrun' : st}, not green` });
    }
  }

  // 3. No unresolved blocker: nothing sitting in `blocked`, and an empty open register.
  for (const [id, u] of Object.entries(units)) {
    if (u && u.status === 'blocked') {
      failures.push({ code: 'blocked-unit', detail: `unit ${id} is blocked` });
    }
  }
  for (const def of phaseDefs) {
    if (phases[def.name] === 'blocked') {
      failures.push({ code: 'blocked-phase', detail: `phase ${def.name} is blocked` });
    }
  }
  if (Array.isArray(openItems) && openItems.length > 0) {
    failures.push({ code: 'open-register', detail: `${openItems.length} unresolved open register item(s)` });
  }

  // 4. Final validation must be present AND green.
  if (finalValidation === null || finalValidation === undefined) {
    failures.push({ code: 'final-validation-missing', detail: 'final validation is absent' });
  } else if (finalValidation.passed !== true) {
    failures.push({ code: 'final-validation-red', detail: 'final validation did not pass' });
  }

  return failures;
}

/**
 * The convergence conjunction as a single boolean. True iff `convergenceFailures` is empty.
 * @param {object} state see {@link convergenceFailures}
 * @returns {boolean}
 */
export function converged(state = {}) {
  return convergenceFailures(state).length === 0;
}
