// W5 step 3: every guessed number Gnomon decides or speaks with, declared once with its prior,
// and read through `param()`, which pools the prior with what the log has measured since.
//
// A parameter's outcomes are folded by one rule, `calibrate`, into `state.calibrated.params`
// (or read from a fold that already counts them: the forecasters' own calibration). A reader
// never sees a bare constant: it gets the value, its n, and whether that n is worth trusting,
// and `formatParam` is the one way a number reaches the model or the owner.
//
// Pooling: value = (prior · priorN + observed) / (priorN + n). A family leaf (a kind, a question
// class) takes its parent's value as its prior, so a thin leaf reads as its parent and a well
// measured one as itself, with no cliff at n = 20. Caps and safety TTLs are not parameters.
import type { KernelState } from './types.js';
import type { ParamStats } from './state/calibrated.js';

export interface ParamSpec {
  /** An exact id, or a family ending in `:` that every id under it shares (`notice.precision:agent-waiting`). */
  id: string;
  /** What it measures, in the owner's words. */
  label: string;
  kind: 'rate' | 'mean';
  prior: number;
  /** How many outcomes the prior is worth. */
  priorN: number;
  /** The parameter a family leaf is pooled toward. */
  parent?: string;
  unit: '%' | 'min';
  /** Outcomes another rule already folds (the forecasters count their own); absent: `state.calibrated.params`. */
  from?: (state: KernelState, id: string) => { n: number; hits: number } | undefined;
}

const forecast = (kind: string) => (state: KernelState) => state.predictions?.calibration?.[kind];

export const PARAMETERS: ParamSpec[] = [
  // Loop A: notice precision, useful / (useful + wrong), per kind. The producer's own `precision`
  // is the kind's prior when the gate asks (`param(state, id, candidate.precision)`).
  { id: 'notice.precision', label: 'notices you judged worth hearing', kind: 'rate', prior: 0.6, priorN: 10, unit: '%' },
  { id: 'notice.precision:', label: 'notices of this kind you judged worth hearing', kind: 'rate', prior: 0.6, priorN: 10, parent: 'notice.precision', unit: '%' },
  // The bars' evidence (appendix #1): what each channel admitted, and how it was judged.
  { id: 'gate.precision:', label: 'notices admitted on this channel you judged worth hearing', kind: 'rate', prior: 0.6, priorN: 10, parent: 'notice.precision', unit: '%' },
  // W5 step 5: presence within 5 min of a delivery (seen), and each kind's own action.
  { id: 'notice.seen', label: 'notices followed by you at the Mac within 5 min', kind: 'rate', prior: 0.5, priorN: 10, unit: '%' },
  { id: 'notice.seen:', label: 'notices of this kind followed by you at the Mac within 5 min', kind: 'rate', prior: 0.5, priorN: 10, parent: 'notice.seen', unit: '%' },
  { id: 'notice.acted:', label: 'notices of this kind followed by the thing they named', kind: 'rate', prior: 0.3, priorN: 10, unit: '%' },
  { id: 'presence.baseline', label: 'fixed times followed by you at the Mac within 5 min', kind: 'rate', prior: 0.5, priorN: 10, unit: '%' },
  // Loop I: a routine forecast against the next step the owner took. The prior is the measured rate: every routine
  // forecast over the 62-day record scored at the next step held 11.7% (n = 11,620), not the 27% the old holdout said.
  { id: 'routine.next', label: 'routine forecasts of the next app that held', kind: 'rate', prior: 0.12, priorN: 20, unit: '%' },
  // Loop D: the forecasters' cold-start priors, from the outcomes they already count.
  { id: 'forecast.base:hour-fragmented', label: 'active hours that came apart', kind: 'rate', prior: 0.14, priorN: 20, unit: '%', from: forecast('hour-fragmented') },
  { id: 'forecast.base:project-touched', label: 'candidate projects touched the next day', kind: 'rate', prior: 0.42, priorN: 20, unit: '%', from: forecast('project-touched') },
  { id: 'forecast.base:day-ending', label: 'active hours that were the day\'s last', kind: 'rate', prior: 1 / 24, priorN: 20, unit: '%', from: forecast('day-ending') },
  // Loop H: Gnomon's questions, per class, useful / (useful + wrong).
  { id: 'ask.class', label: 'questions you judged worth asking', kind: 'rate', prior: 0.5, priorN: 4, unit: '%' },
  { id: 'ask.class:', label: 'questions of this kind you judged worth asking', kind: 'rate', prior: 0.5, priorN: 4, parent: 'ask.class', unit: '%' },
  // Appendix #3: the interruption cost weight's evidence — questions answered within 10 min by the
  // cost they landed at, and the minutes back to the app a phasic notice pulled you from.
  { id: 'gate.answered:high', label: 'questions answered within 10 min at a high interruption cost', kind: 'rate', prior: 0.4, priorN: 10, unit: '%' },
  { id: 'gate.answered:low', label: 'questions answered within 10 min at a low interruption cost', kind: 'rate', prior: 0.4, priorN: 10, unit: '%' },
  { id: 'gate.returnLag', label: 'minutes back to the app a notice pulled you from', kind: 'mean', prior: 1, priorN: 10, unit: 'min' },
  // Row 11: actions verified, and performed without failing.
  { id: 'action.verified:', label: 'actions of this tool the judge verified as done', kind: 'rate', prior: 0.9, priorN: 10, unit: '%' },
  { id: 'action.performed:', label: 'calls of this tool that did not fail', kind: 'rate', prior: 0.9, priorN: 10, unit: '%' },
];

/** Below this many outcomes a measured number is said to be too small to trust. */
export const TRUST_N = 20;

export function specFor(id: string): ParamSpec | undefined {
  return PARAMETERS.find((p) => p.id === id) ?? PARAMETERS.find((p) => p.id.endsWith(':') && id.startsWith(p.id) && id.length > p.id.length);
}

export interface ParamValue {
  id: string;
  value: number;
  n: number;
  /** The prior it was pooled with: the declared one, the parent's value, or the caller's. */
  prior: number;
  source: 'prior' | 'measured';
  /** Measured, but on fewer than `TRUST_N` outcomes. */
  thin: boolean;
  unit: '%' | 'min';
}

/** The parameter's value now. `prior` overrides the declared one (the gate passes the producer's precision). */
export function param(state: KernelState | null | undefined, id: string, prior?: number): ParamValue {
  const spec = specFor(id);
  if (!spec) throw new Error(`no parameter ${id} is declared in PARAMETERS`);
  const stats: Partial<ParamStats> | undefined = state ? (spec.from ? spec.from(state, id) : state.calibrated?.params?.[id]) : undefined;
  const n = stats?.n ?? 0;
  const base = prior ?? (spec.parent ? param(state, spec.parent).value : spec.prior);
  const observed = spec.kind === 'rate' ? (stats?.hits ?? 0) : (stats?.sum ?? 0);
  return { id, value: (base * spec.priorN + observed) / (spec.priorN + n), n, prior: base, source: n === 0 ? 'prior' : 'measured', thin: n > 0 && n < TRUST_N, unit: spec.unit };
}

/** The one way a parameter is said: "about 27% (measured, n = 312)" or "27% (prior, not measured yet)". */
export function formatParam(p: ParamValue): string {
  const say = (v: number) => (p.unit === '%' ? `${Math.round(v * 100)}%` : `${Math.round(v * 10) / 10} min`);
  if (p.source === 'prior') return `${say(p.prior)} (prior, not measured yet)`;
  return `about ${say(p.value)} (measured, n = ${p.n}${p.thin ? ', too small to trust' : ''})`;
}

/** One outcome folded into a parameter's stats: a hit or miss for a rate, a value for a mean. */
export function observe(params: Record<string, ParamStats>, id: string, outcome: boolean | number, ts: string): Record<string, ParamStats> {
  const s = params[id] ?? { n: 0, hits: 0, sum: 0, updatedAt: null };
  const value = typeof outcome === 'number' ? outcome : outcome ? 1 : 0;
  return { ...params, [id]: { n: s.n + 1, hits: s.hits + (outcome === true ? 1 : 0), sum: s.sum + value, updatedAt: ts } };
}

/** A hit on an outcome already counted (a notice counted at delivery, seen minutes later). */
export function credit(params: Record<string, ParamStats>, id: string, ts: string): Record<string, ParamStats> {
  const s = params[id] ?? { n: 0, hits: 0, sum: 0, updatedAt: null };
  return { ...params, [id]: { ...s, hits: s.hits + 1, sum: s.sum + 1, updatedAt: ts } };
}
