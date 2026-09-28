/**
 * Reading habits off the moments, because the routine table cannot carry one.
 *
 * `routineLearn` counts sequences of app switches, and that is all it stores: a
 * `LearnedRoutine` is `steps`, `support`, and two timestamps. There is no hour in
 * it, no project, no duration and no weekday — so the habits card could only ever
 * say `Claude → Warp → Google Chrome, seen 123×`, which is what the owner read and
 * could not use. Their words: "We miss context. What information is that bringing
 * across?" None. A trigram is activity; a habit is activity that happens at a TIME,
 * FOR something, and lasts about as long each time.
 *
 * All four of those are already in the record, on the moments. A moment carries its
 * start and end, the project it was attributed to, the app in front, and the model's
 * own sentence about what it was. So a ritual is not learned and not stored — it is
 * READ, the same way `topRoutines` reads the routine table, and it can be recomputed
 * from scratch whenever the definition changes without a reprocess.
 *
 * Nothing here decides anything or emits anything, by the same argument the routine
 * tier makes for itself: a tendency is worth knowing and is not worth an
 * interruption.
 */

/** The fields a ritual is read from. A subset of `StoredMoment`, so the db types stay in db. */
export interface RitualMoment {
  startTime: string;
  endTime: string;
  processName: string;
  projectId: string | null;
  intent: string | null;
}

export interface Ritual {
  /** Stable across recomputation: project and slot, never the count. */
  key: string;
  /** What the owner reads: `Morning · puzzlebox-studio`. */
  name: string;
  /** The project's display name alone. */
  project: string;
  /** Minutes from local midnight: the usual window, first quartile start to third quartile end. */
  startMin: number;
  endMin: number;
  /** Median wall length of one sitting, in minutes. */
  medianMin: number;
  /** Distinct local days it happened on — the support that matters, not the occurrence count. */
  days: number;
  occurrences: number;
  /** The apps in front, commonest first. The demoted raw sequence. */
  apps: string[];
  /** Occurrences per weekday, Monday first. */
  weekdays: number[];
  /** `weekdays` · `weekends` · `any day` — the conditioning the audit asked for. */
  when: string;
  /** Local date of the most recent occurrence, `YYYY-MM-DD`. */
  lastDay: string;
  /** What the model said these sittings were, most recent first. Ochre on screen: a model wrote them. */
  intents: string[];
}

/**
 * Model sentences kept per ritual.
 *
 * The busiest ritual has a thousand of them. Three is what a fold can hold, and a
 * payload carrying the rest is one nobody reads — the same argument that capped the
 * Day's window titles at twelve.
 */
const KEPT_INTENTS = 3;

/** Apps kept per ritual. Beyond six it is the long tail of everything that was ever open. */
const KEPT_APPS = 6;

/**
 * The six times of day, by the hour a sitting STARTS.
 *
 * Two-hour buckets were the first cut and gave two rituals the same name — a
 * `Morning · puzzlebox-studio` at 08h and another at 10h, which is one morning's
 * work reported as two habits. Bucketing by the word instead makes the name unique
 * by construction and matches how the owner would say it.
 */
const SLOTS: Array<{ from: number; word: string }> = [
  { from: 0, word: 'Early' },
  { from: 8, word: 'Morning' },
  { from: 12, word: 'Midday' },
  { from: 14, word: 'Afternoon' },
  { from: 18, word: 'Evening' },
  { from: 22, word: 'Late' },
];

export function slotOf(hour: number): string {
  let word = SLOTS[0]!.word;
  for (const slot of SLOTS) if (hour >= slot.from) word = slot.word;
  return word;
}

/** `~/Projects/acme/puzzlebox-studio` → `puzzlebox-studio`; `named:hub` → `hub`. */
export function projectLabel(projectId: string): string {
  if (projectId.startsWith('named:')) return projectId.slice('named:'.length);
  return projectId.split('/').pop() ?? projectId;
}

/** One formatter per zone: building an `Intl.DateTimeFormat` per moment was ~0.4 s of the Habits card over 8k moments. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let format = FORMATTERS.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    FORMATTERS.set(timeZone, format);
  }
  return format;
};

/** Local `{ day, minutes, weekday }` for an instant, weekday 0 = Monday. */
function localParts(iso: string, timeZone: string): { day: string; minutes: number; weekday: number } | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const parts = formatterFor(timeZone).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  // `Date.UTC` on the local calendar date gives the weekday without a second
  // formatter and without a locale's idea of which day starts the week.
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  return { day, minutes, weekday };
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** The value a quarter of the way in, and three quarters — the usual window, not the extremes. */
function quartile(sorted: number[], at: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))]!;
}

/** Longest gap between two moments that is still the same sitting. */
const SITTING_GAP_MS = 20 * 60 * 1000;
/** A sitting shorter than this is an errand, not a stretch of work. */
const MIN_SITTING_MS = 10 * 60 * 1000;

interface Sitting {
  project: string;
  day: string;
  weekday: number;
  startMin: number;
  endMin: number;
  lengthMin: number;
  apps: Map<string, number>;
  intents: Array<{ ms: number; text: string }>;
}

/**
 * Consecutive moments on one project, read as one sitting.
 *
 * A moment with NO project extends the sitting it lands in rather than breaking it.
 * That is the difference between a median sitting of nine minutes and one of
 * thirty-seven on the same data: two thousand of the seven thousand moments are
 * unattributed, and most of them are the browser between two attributed ones. A
 * sitting broken at every unattributed glance is not a sitting.
 */
export function sittings(moments: readonly RitualMoment[], timeZone: string): Sitting[] {
  const out: Sitting[] = [];
  let current: Sitting | null = null;
  let currentEndAt = 0;
  for (const moment of moments) {
    const start = localParts(moment.startTime, timeZone);
    const end = localParts(moment.endTime, timeZone);
    if (start === null || end === null) continue;
    const startAt = Date.parse(moment.startTime);
    const sameSitting =
      current !== null && start.day === current.day && startAt - currentEndAt <= SITTING_GAP_MS && (moment.projectId === null || projectLabel(moment.projectId) === current.project);
    if (!sameSitting) {
      if (current !== null) out.push(current);
      if (moment.projectId === null) {
        current = null;
        continue;
      }
      current = { project: projectLabel(moment.projectId), day: start.day, weekday: start.weekday, startMin: start.minutes, endMin: start.minutes, lengthMin: 0, apps: new Map(), intents: [] };
    }
    const sitting = current!;
    // A sitting that runs past local midnight would otherwise end "before" it
    // began; the day it started in is the day it belongs to.
    sitting.endMin = end.day === sitting.day ? Math.max(sitting.endMin, end.minutes) : 24 * 60;
    sitting.lengthMin = sitting.endMin - sitting.startMin;
    sitting.apps.set(moment.processName, (sitting.apps.get(moment.processName) ?? 0) + 1);
    if (moment.intent) sitting.intents.push({ ms: Math.max(0, Date.parse(moment.endTime) - startAt), text: moment.intent });
    currentEndAt = Date.parse(moment.endTime);
  }
  if (current !== null) out.push(current);
  return out.filter((s) => s.lengthMin * 60_000 >= MIN_SITTING_MS);
}

/**
 * The rituals in a stretch of moments, most-practised first.
 *
 * `minDays` is the "so what?" filter the audit asked for, and it is deliberately
 * counted in DAYS rather than occurrences: four sittings in one afternoon is an
 * afternoon, and four sittings on four separate days is a habit. A cluster with no
 * project is dropped entirely — it cannot be named, and a band called "something,
 * around two" is exactly the row the owner could not use.
 */
export function rituals(moments: readonly RitualMoment[], timeZone: string, minDays = 4): Ritual[] {
  const groups = new Map<string, Sitting[]>();
  for (const sitting of sittings(moments, timeZone)) {
    const key = `${sitting.project}@${slotOf(Math.floor(sitting.startMin / 60))}`;
    const list = groups.get(key) ?? [];
    list.push(sitting);
    groups.set(key, list);
  }
  const out: Ritual[] = [];
  for (const [key, list] of groups) {
    const days = new Set(list.map((s) => s.day));
    if (days.size < minDays) continue;
    const starts = list.map((s) => s.startMin).sort((a, b) => a - b);
    const ends = list.map((s) => s.endMin).sort((a, b) => a - b);
    const lengths = list.map((s) => s.lengthMin).sort((a, b) => a - b);
    const apps = new Map<string, number>();
    for (const sitting of list) for (const [app, n] of sitting.apps) apps.set(app, (apps.get(app) ?? 0) + n);
    const weekdays = [0, 0, 0, 0, 0, 0, 0];
    for (const sitting of list) weekdays[sitting.weekday]! += 1;
    const onWeekend = weekdays[5]! + weekdays[6]!;
    const onWeekday = weekdays.slice(0, 5).reduce((a, b) => a + b, 0);
    const slot = key.split('@')[1]!;
    const project = list[0]!.project;
    out.push({
      key,
      name: `${slot} · ${project}`,
      project,
      startMin: quartile(starts, 0.25),
      endMin: quartile(ends, 0.75),
      medianMin: median(lengths),
      days: days.size,
      occurrences: list.length,
      // Capped, because the tail is every app that was ever open during a
      // sitting — Photo Booth and Find My are not part of anyone's morning.
      apps: [...apps]
        .sort((a, b) => b[1] - a[1])
        .slice(0, KEPT_APPS)
        .map(([app]) => app),
      weekdays,
      when: onWeekend === 0 ? 'weekdays' : onWeekday === 0 ? 'weekends' : 'any day',
      lastDay: list.reduce((latest, s) => (s.day > latest ? s.day : latest), list[0]!.day),
      // The LONGEST moments, not the newest. Newest-first is the client's rule
      // everywhere a list is a feed, and it is wrong here: the most recent
      // moments in a stretch are the short ones at the edges, so the busiest
      // ritual in the record answered "what is this for?" with "Switching from
      // VS Code to WhatsApp". A ritual is its substantial sittings, and the
      // model's sentence about a forty-minute one is the reading worth keeping.
      intents: [
        ...new Set(
          list
            .flatMap((s) => s.intents)
            .sort((a, b) => b.ms - a.ms)
            .map((i) => i.text),
        ),
      ].slice(0, KEPT_INTENTS),
    });
  }
  return out.sort((a, b) => b.days - a.days || b.occurrences - a.occurrences);
}

/**
 * Sequences and their reverses, counted once.
 *
 * `Claude → Warp → Chrome` at 123 and `Chrome → Warp → Claude` at 110 are the same
 * oscillation seen from both ends, and the card reported them as two of the owner's
 * strongest habits. Eight of the top twenty are mirrors of another in the same list.
 * The stronger direction survives and carries its twin's support as `mirrored`, so
 * the total is still honest and the row stops being printed twice.
 */
export function mergeMirrors<T extends { steps: string[]; support: number }>(routines: readonly T[]): Array<T & { mirrored: number | null }> {
  const groups = new Map<string, T[]>();
  for (const routine of routines) {
    const forward = routine.steps.join('>');
    const backward = [...routine.steps].reverse().join('>');
    const key = forward < backward ? forward : backward;
    const list = groups.get(key) ?? [];
    list.push(routine);
    groups.set(key, list);
  }
  return [...groups.values()]
    .map((list) => {
      const [strongest, ...rest] = [...list].sort((a, b) => b.support - a.support);
      return { ...strongest!, mirrored: rest.length === 0 ? null : rest.reduce((sum, r) => sum + r.support, 0) };
    })
    .sort((a, b) => b.support + (b.mirrored ?? 0) - (a.support + (a.mirrored ?? 0)));
}
