/**
 * Conditioning variables for research goals — the closed half of
 * propose-and-verify.
 *
 * A research goal's hypothesis is ONE of these, picked by the companion from
 * the record (the open-ended half, where a model is genuinely useful). The
 * verdict is arithmetic over the forecaster's own recorded samples (the closed
 * half, where a model has no authority): split the cell's outcomes on the
 * variable and measure the information gain. The model never writes a belief —
 * it writes a candidate this file accepts or discards.
 *
 * Every conditioner must be evaluable in BOTH worlds or it cannot exist here:
 *   - retroactively, over a `DayView` the trial executor builds per recorded
 *     prediction row (`RunGoalTrial`), and
 *   - live, at the moment `dayShapeForecast` opens a prediction, from the same
 *     `DayView` shape assembled out of `KernelState`.
 * One evaluator, two callers — a conditioner that backtests one function and
 * bets on another would let the trial validate something the forecaster then
 * doesn't do.
 *
 * `evaluate` returns `boolean | null`. `null` means "unknowable for this day"
 * (e.g. the previous day was never observed), and a null sample is EXCLUDED —
 * from the trial's arms and from the live arm update alike. Folding unknowns
 * into an arm would let missing evidence masquerade as a pattern.
 *
 * The menu is deliberately small and grows one honest entry at a time. It is
 * the extensibility point of the whole goal system: a new conditioner is a new
 * hypothesis the companion can propose, at the price of one pure function.
 */

/** Everything a conditioner may look at about one local day. */
export interface DayView {
  /** The local calendar day, `YYYY-MM-DD`. */
  date: string;
  /**
   * The previous local day's last ACTIVE hour (the hour whose `day-ending`
   * prediction resolved as a hit), or `null` when that day was never observed
   * or never resolved.
   */
  prevDayEndHour: number | null;
}

export interface Conditioner {
  id: string;
  /** Owner-facing name of the split, used in the self-report. */
  label: string;
  /** One sentence the proposal prompt shows the model. */
  hint: string;
  evaluate(day: DayView): boolean | null;
}

/**
 * Date-only weekday, timezone-free on purpose: a `YYYY-MM-DD` names the same
 * weekday everywhere, and parsing it through a local-time `Date` would shift
 * it across midnight in negative-offset zones.
 */
export function weekdayOf(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Hours at or past this count as "the previous day ran late". 22:00 in the owner's own zone. */
const LATE_END_HOUR = 22;

export const CONDITIONERS: readonly Conditioner[] = [
  {
    id: 'weekend',
    label: 'weekends',
    hint: 'Saturdays and Sundays behave differently from workdays.',
    evaluate: (day) => {
      const weekday = weekdayOf(day.date);
      return weekday === 0 || weekday === 6;
    },
  },
  {
    id: 'prev-day-ran-late',
    label: 'days after a late night',
    hint: `The previous day's activity ran to ${LATE_END_HOUR}:00 or later — an overnight session often explains odd early-morning cells.`,
    evaluate: (day) => {
      if (day.prevDayEndHour === null) return null;
      return day.prevDayEndHour >= LATE_END_HOUR;
    },
  },
];

export function conditionerById(id: string): Conditioner | null {
  return CONDITIONERS.find((conditioner) => conditioner.id === id) ?? null;
}

// ── The verdict arithmetic ──────────────────────────────────────────────────

/** One arm of a split: the samples where the conditioner held (or did not). */
export interface TrialArm {
  n: number;
  hits: number;
}

export interface TrialSplit {
  /** Samples where the variable was true. */
  when: TrialArm;
  /** Samples where it was false. */
  otherwise: TrialArm;
  /** Samples the conditioner could not evaluate; reported, never counted. */
  unknown: number;
}

/** Fewer samples than this in EITHER arm and the trial has not been run yet, whatever the gain says. */
export const MIN_ARM_N = 4;

/**
 * Shannon entropy of one arm's observed rate, in nats. Plain frequency, not
 * the Beta posterior: the trial judges the SPLIT of a fixed sample, and the
 * MDL penalty below is what guards small-n — smoothing here too would guard
 * it twice and hide real structure in thin arms.
 */
export function armEntropy(arm: TrialArm): number {
  if (arm.n === 0) return 0;
  const rate = arm.hits / arm.n;
  if (rate <= 0 || rate >= 1) return 0;
  return -(rate * Math.log(rate) + (1 - rate) * Math.log(1 - rate));
}

/**
 * Information gain of the split, in nats per sample: pooled entropy minus the
 * sample-weighted entropy of the arms. Zero when the arms have the same rate;
 * it CANNOT be produced by denominator growth, which is the failure the goal
 * criterion was rebuilt to exclude — gain requires the arms to actually
 * differ.
 */
export function informationGain(split: TrialSplit): number {
  const total: TrialArm = { n: split.when.n + split.otherwise.n, hits: split.when.hits + split.otherwise.hits };
  if (total.n === 0) return 0;
  const weighted = (split.when.n / total.n) * armEntropy(split.when) + (split.otherwise.n / total.n) * armEntropy(split.otherwise);
  return Math.max(0, armEntropy(total) - weighted);
}

/**
 * Accept the split only when the total nats saved exceed the MDL price of the
 * one extra parameter it introduces: `n·gain ≥ ln(n)/2 + 1`.
 *
 * This is the multiple-comparisons guard in its honest form. The hypothesis is
 * pre-registered (the model proposes ONE variable and only that one is
 * tested), and the MDL term prices what a single extra Bernoulli rate is worth
 * describing at this sample size — at n=13 the bar is ~2.3 nats total, which a
 * real 06:00-after-late-nights pattern clears and a coincidental 7/6 split
 * does not. The `+1` margin is deliberate slack for the roughness of the
 * criterion; it errs toward "not proven", which is the only safe direction for
 * a system that reports its findings to its owner.
 */
export function splitAccepted(split: TrialSplit): boolean {
  if (split.when.n < MIN_ARM_N || split.otherwise.n < MIN_ARM_N) return false;
  const n = split.when.n + split.otherwise.n;
  return n * informationGain(split) >= Math.log(n) / 2 + 1;
}
