import type { KernelState, Rule } from '@sundial/kernel/types.js';
import { classifyActivity } from '@sundial/helpers/window-classification.js';

/**
 * Steps in a routine. Three is the shortest sequence that says anything an ordinary
 * app-switch does not; five is where a "routine" stops being one and becomes a
 * description of a whole morning.
 */
const MIN_STEPS = 3;
const MAX_STEPS = 5;

/**
 * Times a sequence must recur before it is a routine rather than a coincidence.
 *
 * Activity Frames' own threshold, and its reasoning transfers directly: below three
 * there is no way to tell a habit from a day.
 */
export const MIN_SUPPORT = 3;

/**
 * Distinct targets a sequence must touch.
 *
 * The guard that separates a procedure from a tic, and the live corpus shows why it
 * is load-bearing rather than tidy. The most frequent process-level triples in the
 * owner's real data are `Chrome → Claude → Chrome` (96 times) and
 * `Claude → Chrome → Claude` (87) — alt-tabbing, not a routine. Activity Frames
 * measured the same thing at a larger scale: raw recurrence of any n-gram was 83.1%
 * and dominated by keystroke texture, while recurrence of sequences touching two or
 * more distinct targets was 9.0% in-sample and 7.7% out-of-sample. The out-of-sample
 * figure is the honest one and the reason this rule is measured on a holdout.
 */
const MIN_DISTINCT_TARGETS = 2;

/** Bounded ring of the steps seen so far in the current stretch of work. */
const MAX_TRAIL = 8;

/** Bound on the learned table. Beyond this the least-supported routines are dropped. */
export const MAX_ROUTINES = 64;

/** A routine unseen this long is the first to make room: habits change (a new browser, a new tool). */
export const STALE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * A step is an app plus WHAT KIND of thing it was doing, not a raw window title.
 *
 * Raw titles never repeat — a pull-request title differs every time — so a routine
 * built on them could never recur and the whole tier would learn nothing. The
 * activity class is the coarsest description that still distinguishes "the editor"
 * from "the browser on a work site" from "the browser on YouTube", which is the
 * granularity a routine actually lives at. It also keeps anything sensitive out:
 * a step records a process name and one of five class labels, never page content.
 */
export function routineStep(processName: string, windowTitle: string, taxonomy: KernelState['config']['leisureRules']): string {
  return `${processName}/${classifyActivity(processName, windowTitle, taxonomy)}`;
}

/** Stable key for a sequence, so the same routine accumulates one entry. */
export function routineKey(steps: string[]): string {
  return steps.join(' > ');
}

function distinctTargets(steps: string[]): number {
  return new Set(steps.map((s) => s.split('/')[0])).size;
}

/**
 * True when the sequence is just two things alternating — `A > B > A`, `A > B > A > B`.
 *
 * The alt-tab signature, and the guard that `MIN_DISTINCT_TARGETS` alone does not
 * catch: `Chrome > Claude > Chrome` touches two distinct targets and passes it
 * cleanly. Measured on the owner's real 13 days, that hole let switching texture
 * take every top slot — the strongest "routine" learned was
 * `Chrome > Claude > Chrome` at support 375, and out-of-sample precision sat at
 * 40.3%. With this guard the same holdout read 26.8%: lower, and the honest
 * number. Alternation is what a person does while thinking, not a procedure they
 * follow, and a routine tier that reports it back has learned the shape of a
 * keyboard rather than the shape of the work.
 */
function isAlternation(steps: string[]): boolean {
  if (distinctTargets(steps) > 2) return false;
  const targets = steps.map((s) => s.split('/')[0]);
  return targets.every((target, i) => i < 2 || target === targets[i - 2]);
}

/**
 * Learns which sequences of activity the owner repeats.
 *
 * The procedural-memory tier: working memory is now, episodic memory is what
 * happened, reflective memory is what was noticed about it, and core memory is what
 * is durably true — but none of the four records HOW the owner does things. MIRIX
 * names procedural memory as a first-class memory type for exactly this gap, and
 * Activity Frames measured what it is worth (7.7% of steps out-of-sample belong to
 * routines, at 60-343x the tokens to re-derive versus replay).
 *
 * Deliberately shaped like `expectationLearn`, which is the rule that already solved
 * the same problem one level down: it folds occurrences into a running mean and has
 * no opinion about them. This folds sequences into a running count and likewise
 * emits nothing, decides nothing, and interrupts nobody. What consumes the table is
 * a separate question — today only a read tool does.
 *
 * A routine is NOT a macro. Nothing here emits an effect that acts on anything;
 * actuation is explicitly out of scope for
 * `decisions/assistant-as-an-event-source`, and a learned step list looking
 * executable is precisely the temptation that decision declines. Routines are told,
 * never run.
 */
export const routineLearn: Rule = (state, event) => {
  if (event.type !== 'window:changed') return { state, effects: [] };

  const payload = event.payload as { processName?: unknown; windowTitle?: unknown };
  const processName = typeof payload.processName === 'string' ? payload.processName.trim() : '';
  if (!processName) return { state, effects: [] };
  const windowTitle = typeof payload.windowTitle === 'string' ? payload.windowTitle : '';

  const step = routineStep(processName, windowTitle, state.config.leisureRules);
  const previous = state.routines.trail;

  // A repeat of the step already at the end is the same step continuing, not a new
  // one. Without this a title change inside one app would pad every sequence with
  // duplicates of itself and no real sequence would ever match another.
  if (previous.at(-1) === step) return { state, effects: [] };

  const trail = [...previous, step].slice(-MAX_TRAIL);

  // Count every sequence ending at the newest step. Sequences are counted, never
  // emitted: this rule has no opinion, exactly like `expectationLearn`.
  const learned = { ...state.routines.learned };
  for (let length = MIN_STEPS; length <= MAX_STEPS; length++) {
    if (trail.length < length) break;
    const steps = trail.slice(-length);
    if (distinctTargets(steps) < MIN_DISTINCT_TARGETS) continue;
    if (isAlternation(steps)) continue;
    const key = routineKey(steps);
    const entry = learned[key];
    learned[key] = { support: (entry?.support ?? 0) + 1, steps, lastSeenAt: event.ts, firstSeenAt: entry?.firstSeenAt ?? event.ts };
  }

  // Bound the table by dropping the least-supported entries. Ties break on the
  // older `lastSeenAt`, so a routine still in use outlives one that has stopped.
  //
  // A routine not seen for `STALE_MS` goes first, whatever its support. Without
  // that a full table is a trap: every newcomer enters at support 1, is the
  // least supported, and is dropped on the spot, so the table can never learn
  // a new habit. Measured 2026-09-28: the owner changed browsers on 09-16, the
  // 16 strongest routines all ran through the old one and stopped that day, and
  // nothing new could take their place.
  const keys = Object.keys(learned);
  if (keys.length > MAX_ROUTINES) {
    const now = Date.parse(event.ts);
    const stale = (k: string) => (now - Date.parse(learned[k]!.lastSeenAt) > STALE_MS ? 1 : 0);
    const ordered = keys.sort((a, b) => stale(a) - stale(b) || learned[b]!.support - learned[a]!.support || Date.parse(learned[b]!.lastSeenAt) - Date.parse(learned[a]!.lastSeenAt));
    for (const stale of ordered.slice(MAX_ROUTINES)) delete learned[stale];
  }

  return { state: { ...state, routines: { trail, learned } }, effects: [] };
};

/** Routines that have cleared the support bar, strongest first. */
export function confirmedRoutines(state: KernelState, minSupport = MIN_SUPPORT): Array<{ key: string; steps: string[]; support: number; firstSeenAt: string; lastSeenAt: string }> {
  return Object.entries(state.routines.learned)
    .filter(([, entry]) => entry.support >= minSupport)
    .map(([key, entry]) => ({ key, ...entry }))
    .sort((a, b) => b.support - a.support);
}
