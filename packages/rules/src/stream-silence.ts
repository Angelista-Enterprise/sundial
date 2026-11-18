import type { KernelState, Rule, StreamCoverageState, StreamDay } from '@sundial/kernel/types.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { healthCandidate } from './sensor-health.js';

/** The sensor streams judged, by signal type. Sundial's own machinery (llm, judgement, notice, board …) is not a sensor. */
export const WATCHED_SIGNALS = new Set(['window', 'input', 'shell', 'git', 'file', 'symbol', 'browser', 'calendar', 'media', 'system', 'screen', 'audio', 'agent', 'project', 'clipboard', 'location', 'presence', 'mail', 'vault', 'phone', 'focus-mode', 'page']);
/** A day with at least this many input windows (one per 10 s awake) is a full day: five hours. */
export const FULL_DAY_INPUT_WINDOWS = 5 * 60 * 6;
/** A stream seen on this share of the full days of the same weekday class since it first appeared is expected daily. */
export const EXPECTED_SHARE = 0.8;
/** Full days a stream, or the pipeline, needs behind it before its silence is judged. */
export const MIN_FULL_DAYS = 5;
export const PIPELINE_MIN_SHARE = 0.3;
/** This many daily streams silent on one full day is an outage of Sundial, not of a sensor: 2026-10-09 had nine. */
export const OUTAGE_STREAMS = 3;
const DAYS_KEPT = 28;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2 : 0;
};

/** The ring stays in day order: a backfilled row with an old date lands on its own day's row, or nowhere once that day has left the ring. */
function bump(c: StreamCoverageState, day: string, f: (d: StreamDay) => StreamDay): StreamCoverageState {
  const last = c.days.at(-1);
  if (!last || day > last.day) return { ...c, days: [...c.days, f({ day, inputWindows: 0, llm: 0, entity: 0, streams: {} })].slice(-DAYS_KEPT) };
  const i = c.days.findIndex((d) => d.day === day);
  return i < 0 ? c : { ...c, days: c.days.map((d, j) => (j === i ? f(d) : d)) };
}

/** Saturday and Sunday, from a local `YYYY-MM-DD`. */
export const isWeekend = (day: string) => [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());

/** The full days of `yesterday`'s weekday class before it: a calendar stream quiet on a Saturday is not a dead sensor. */
function fullDaysLike(c: StreamCoverageState, yesterday: StreamDay, since = ''): StreamDay[] {
  return c.days.filter((d) => d.day >= since && d.day < yesterday.day && d.inputWindows >= FULL_DAY_INPUT_WINDOWS && isWeekend(d.day) === isWeekend(yesterday.day));
}

/** Every stream that missed `yesterday` (a full day) after being present on `EXPECTED_SHARE` of the full days of its class since it first appeared. */
export function silentStreams(c: StreamCoverageState, yesterday: StreamDay): string[] {
  const out: string[] = [];
  for (const [type, first] of Object.entries(c.firstDay)) {
    if ((yesterday.streams[type] ?? 0) > 0 || c.silentSince[type]) continue;
    const full = fullDaysLike(c, yesterday, first);
    if (full.length < MIN_FULL_DAYS) continue;
    const present = full.filter((d) => (d.streams[type] ?? 0) > 0).length;
    if (present / full.length >= EXPECTED_SHARE) out.push(type);
  }
  return out.sort();
}

/**
 * Which sensor streams are alive, judged from their own presence rather than
 * from a sidecar file's age: a Node poller that keeps running and emits
 * nothing, or a stream whose source changed, was invisible before. Six streams
 * were silent for one to three weeks in October 2026 without a notice.
 *
 * Counts rows per local day and watched stream. On the first `clock:tick` of a
 * new day, if yesterday was a full day (`FULL_DAY_INPUT_WINDOWS`), every stream
 * that was present on `EXPECTED_SHARE` of the full days since it first appeared
 * and absent yesterday is said, all of them in one `sensor-health` candidate;
 * a stream's next row clears it. A per-tick rule on each stream's gap cadence was tried first
 * and said over a thousand things on the record: most streams follow the
 * owner's work and have no cadence of their own. Days do.
 *
 * The same tick says once when a full day's LLM dispatches ran under `PIPELINE_MIN_SHARE` of the median of the earlier full days: on
 * 2026-10-09 and 10-10 the input ran 9–10 h while dispatches fell to a fifth
 * and no rule noticed.
 */
export const streamSilence: Rule = (state, event) => {
  const t = event.type;
  const ts = event.ts;
  const day = localDate(ts, state.config.timezone);
  let c: StreamCoverageState = state.streamCoverage ?? { days: [], firstDay: {}, silentSince: {}, judgedDay: null };
  const effects: ReturnType<Rule>['effects'] = [];

  if (t === 'clock:tick') {
    // Yesterday, judged once on the first tick after it ended: the day row for today may
    // already exist, since any event opens it, so the mark is what says it was judged.
    const yesterday = c.days.filter((d) => d.day < day).at(-1);
    if (yesterday && yesterday.day !== (c.judgedDay ?? null)) {
      c = { ...c, judgedDay: yesterday.day };
      if (yesterday.inputWindows >= FULL_DAY_INPUT_WINDOWS) {
        const silent = silentStreams(c, yesterday);
        let outage = silent.length >= OUTAGE_STREAMS;
        if (silent.length > 0) {
          c = { ...c, silentSince: { ...c.silentSince, ...Object.fromEntries(silent.map((type) => [type, yesterday.day])) } };
          const hours = Math.round(yesterday.inputWindows / 360);
          // One notice for the day, not one per stream: an outage silences a dozen at once.
          effects.push(healthCandidate(state, ts, event.id, `streams:${yesterday.day}`, `${yesterday.day}T00:00:00.000Z`, `${silent.length === 1 ? 'A sensor stream' : `${silent.length} sensor streams`} went silent on ${yesterday.day}, a day with ${hours} hours at the Mac: ${silent.join(', ')}. ${silent.length === 1 ? 'Its sensor has' : 'Their sensors have'} stopped or the source has changed; restart Sundial and check the log.`, silent.map((type) => `${type}: 0 rows on ${yesterday.day}, present on most full days before`)));
        }
        // Model calls only. Entity candidates were tried too and said six days in eight on
        // the record: their volume moves with every change to extraction, so a 28-day median
        // reads a deliberate change as an outage. They stay in the day row for the reader.
        const full = fullDaysLike(c, yesterday);
        if (full.length >= MIN_FULL_DAYS) {
          const medLlm = median(full.map((d) => d.llm));
          if (yesterday.llm < PIPELINE_MIN_SHARE * medLlm) {
            outage = true;
            const hours = Math.round(yesterday.inputWindows / 360);
            effects.push(healthCandidate(state, ts, event.id, `pipeline:${yesterday.day}`, `${yesterday.day}T00:00:00.000Z`, `${yesterday.day} had ${hours} hours at the Mac, but Sundial's own work on it ran at a fraction of normal: ${yesterday.llm} model calls against a usual ${Math.round(medLlm)}. The day's baselines are not to be trusted; check the model route and the log.`, [`${yesterday.day}: ${yesterday.llm} model calls, ${yesterday.entity} candidates`, `median of ${full.length} full ${isWeekend(yesterday.day) ? 'weekend days' : 'weekdays'}: ${Math.round(medLlm)} calls`]));
          }
        }
        if (outage && !(c.outageDays ?? []).includes(yesterday.day)) c = { ...c, outageDays: [...(c.outageDays ?? []), yesterday.day].slice(-DAYS_KEPT) };
      }
    }
    // A day row exists after its first tick, so a day with no input still counts as a day.
    if (!c.days.length || day > c.days.at(-1)!.day) c = bump(c, day, (d) => d);
  } else if (t === 'llm:dispatched') c = bump(c, day, (d) => ({ ...d, llm: d.llm + 1 }));
  else if (t === 'entity:fact-candidate') c = bump(c, day, (d) => ({ ...d, entity: d.entity + 1 }));
  else if (WATCHED_SIGNALS.has(t.slice(0, t.indexOf(':')))) {
    // Every input window counts, with or without a key press: the helper emits one per 10 s while the Mac is awake, so this is hours at the machine.
    c = bump(c, day, (d) => ({ ...d, inputWindows: d.inputWindows + (t === 'input:activity' ? 1 : 0), streams: { ...d.streams, [t]: (d.streams[t] ?? 0) + 1 } }));
    if (!c.firstDay[t]) c = { ...c, firstDay: { ...c.firstDay, [t]: day } };
    if (c.silentSince[t]) {
      const { [t]: _cleared, ...rest } = c.silentSince;
      c = { ...c, silentSince: rest };
    }
  }

  return c === state.streamCoverage ? { state, effects } : { state: { ...state, streamCoverage: c } as KernelState, effects };
};
