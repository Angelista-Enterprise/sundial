import type { Effect, KernelState, Rule, WorkJob, WorkJobRecord } from '@sundial/kernel/types.js';
import { deriveId } from '@sundial/helpers/derive-id.js';
import { promiseLine } from './promise-track.js';
import { samePerson } from './promise-terms.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { lastOccurrence, parseRepeat, repeatKey } from '@sundial/helpers/repeat-schedule.js';

/** Jobs a day, meeting briefs excepted — they are owed to the calendar, not to spare time. */
export const MAX_JOBS_PER_DAY = 3;
/** A job with no result after this is closed `timed-out`; the worker took too long or died. */
export const JOB_TIMEOUT_MS = 20 * 60 * 1000;
/** Breathing room between two spare-time jobs. */
export const MIN_GAP_MS = 30 * 60 * 1000;
/** A meeting brief opens inside this window before the start. */
export const MEETING_BRIEF_MIN_BEFORE_MS = 8 * 60 * 1000;
export const MEETING_BRIEF_MAX_BEFORE_MS = 20 * 60 * 1000;
/** A thread quiet this long, with at least this many active days, earns a handoff note. */
export const HANDOFF_QUIET_MS = 20 * 60 * 60 * 1000;
export const HANDOFF_MIN_ACTIVE_DAYS = 2;
/** Closed-job ring and the done map's horizon. */
export const MAX_RECENT_JOBS = 20;
export const DONE_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
/** Owner-requested jobs waiting for the slot. A sixth is refused: a queue that long is a backlog, and the owner should hear that. */
export const MAX_QUEUED_JOBS = 5;
/** Repeating jobs the owner may keep. An eleventh is refused by the tool. */
export const MAX_REPEATS = 10;
/** An occurrence missed by more than this (the Mac was asleep all morning) is skipped, not run late. */
export const REPEAT_GRACE_MS = 6 * 60 * 60 * 1000;

interface RequestedPayload {
  subject?: string;
  brief?: string;
  /** J5.3: the goal step this job runs for, so `goalPursuit` can grade the result. */
  goalId?: string;
  stepId?: string;
  /** A schedule in plain words; the job is kept and run on it instead of once now. */
  repeat?: string;
  /** `rule`: a watch rule's action (UC4 F19), not the owner's own ask. */
  by?: string;
  rule?: string;
}

interface ShelvedPayload {
  jobId?: string;
  title?: string;
  body?: string;
  sources?: string[];
}

interface ClosedPayload {
  jobId?: string;
  outcome?: string;
  note?: string;
}

function isOwner(name: string, aliases: readonly string[]): boolean {
  const needle = name.trim().toLowerCase();
  return aliases.some((alias) => alias.trim().toLowerCase() === needle);
}

/**
 * Whether the owner is away enough for Gnomon to spend a model on its own work.
 * Idle by input, or outside the daytime phase — the same "heavy autonomous
 * work away from active daytime" gate `mindTrack` computes `circadian` for.
 */
export function ownerIsAway(state: KernelState): boolean {
  return state.lifeEvent.idle.isIdle || state.mind.circadian !== 'day';
}

/**
 * The next job worth opening, or null. Pure, state only.
 *
 * Order: a meeting brief when one is due (time-bound, not gated on being away);
 * then, only while the owner is away and under the daily cap, a handoff note
 * for a thread that has gone quiet; then a brief on a tool the owner has been
 * touching. Topics are deliberately NOT briefed: on the live record
 * `memory.recentEntityIds` is mostly code identifiers (`topic:readbody`), which
 * no web search improves on.
 */
/**
 * The files touched most in the thread's project today (`fileTrack`), so a
 * handoff note can name where the work actually was rather than only the branch.
 * Matched on the project root's last path segment; empty when nothing matches.
 */
export function hotFilesFor(state: KernelState, projectName: string | null, max = 3): string[] {
  if (!projectName) return [];
  const needle = projectName.toLowerCase();
  return Object.values(state.files?.hot ?? {})
    .filter((file) => file.projectRoot.split('/').filter(Boolean).pop()?.toLowerCase() === needle)
    .sort((a, b) => b.changes - a.changes)
    .slice(0, max)
    .map((file) => `${file.relPath} (${file.changes}×)`);
}

export function pickJob(state: KernelState, nowIso: string): WorkJob | null {
  const now = Date.parse(nowIso);
  const done = state.workbench.done;

  for (const meeting of state.schedule.upcoming) {
    if (meeting.isAllDay) continue;
    const start = Date.parse(meeting.start);
    if (!Number.isFinite(start)) continue;
    const lead = start - now;
    if (lead < MEETING_BRIEF_MIN_BEFORE_MS || lead > MEETING_BRIEF_MAX_BEFORE_MS) continue;
    const others = meeting.attendees.filter((name) => !isOwner(name, state.config.ownerAliases));
    if (others.length === 0) continue;
    const key = meetingJobKey(meeting.title, meeting.start);
    if (done[key]) continue;
    return {
      id: deriveId(nowIso, 'workbench', key),
      kind: 'meeting-brief',
      key,
      subject: meeting.title,
      reason: `starts in ${Math.round(lead / 60_000)} min with ${others.length} other${others.length === 1 ? '' : 's'}`,
      // U1-F33: what is owed between the owner and the people in the room, so the brief leads with it.
      detail: { start: meeting.start, end: meeting.end, attendees: others, promises: state.commitments.promises.filter((c) => others.some((a) => samePerson(a, c.promise?.counterparty))).map((c) => promiseLine(state, c)) },
      openedAt: nowIso,
    };
  }

  if (!ownerIsAway(state)) return null;
  if (state.workbench.countToday >= MAX_JOBS_PER_DAY) return null;
  const last = state.workbench.recent[state.workbench.recent.length - 1];
  if (last && now - Date.parse(last.closedAt) < MIN_GAP_MS) return null;

  const quiet = state.commitments.open
    .filter((thread) => thread.activeDays.length >= HANDOFF_MIN_ACTIVE_DAYS && now - Date.parse(thread.lastTouchedAt) >= HANDOFF_QUIET_MS)
    .sort((a, b) => (a.lastTouchedAt < b.lastTouchedAt ? 1 : -1));
  for (const thread of quiet) {
    const key = `handoff:${thread.id}:${thread.lastTouchedAt.slice(0, 10)}`;
    if (done[key]) continue;
    return {
      id: deriveId(nowIso, 'workbench', key),
      kind: 'handoff-note',
      key,
      subject: thread.name,
      reason: `quiet since ${thread.lastTouchedAt.slice(0, 10)} after ${thread.activeDays.length} active days`,
      detail: { branch: thread.branch, project: thread.projectName, lastTouchedAt: thread.lastTouchedAt, commitmentId: thread.id, hotFiles: hotFilesFor(state, thread.projectName) },
      openedAt: nowIso,
    };
  }

  // Once a week: look for one thing worth noticing unasked, and propose it as a
  // tested watch rule (kernel/watch.ts). The owner's Keep on the shelf adopts it.
  const ideaKey = `rule-idea:${Math.floor(now / (7 * 86_400_000))}`;
  if (!done[ideaKey]) {
    return { id: deriveId(nowIso, 'workbench', ideaKey), kind: 'rule-idea', key: ideaKey, subject: 'a rule worth watching for', reason: 'the weekly look for something to notice on its own', detail: {}, openedAt: nowIso };
  }

  for (const entityId of state.memory.recentEntityIds) {
    if (!entityId.startsWith('tool:')) continue;
    const key = `brief:${entityId}`;
    if (done[key]) continue;
    return {
      id: deriveId(nowIso, 'workbench', key),
      kind: 'topic-brief',
      key,
      subject: entityId.slice('tool:'.length),
      reason: 'a tool that keeps showing up in your work',
      detail: { entityId },
      openedAt: nowIso,
    };
  }

  return null;
}

/** The `done`/`briefPoints` key for a meeting brief. Named once: `meetingFollowup` reads the same key to offer the brief's points, and a re-typed literal is how the two silently stop matching. */
export function meetingJobKey(title: string, start: string): string {
  return `meeting:${title}:${start}`;
}

/** Tap-sized answer ceiling, the same `ownerAsk` enforces. */
const POINT_MAX_CHARS = 48;
/** At most this many points ride into the follow-up question, beside its two fixed choices. */
const MAX_BRIEF_POINTS = 2;

/**
 * The lead phrases of a brief: the bold openers the worker is told to write
 * (`**Who's in the room**`, `**Open threads worth a slot**`), or failing those the
 * first words of its bullets. Short enough to be a button.
 */
export function briefPoints(body: string): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    const point = raw.replace(/\s+/g, ' ').replace(/[*_`]/g, '').trim().replace(/[\s—:–-]+$/, '');
    if (point.length >= 4 && point.length <= POINT_MAX_CHARS && !out.includes(point)) out.push(point);
  };
  for (const match of body.matchAll(/\*\*([^*\n]{4,80})\*\*/g)) push(match[1]!);
  if (out.length < MAX_BRIEF_POINTS) {
    for (const line of body.split('\n')) {
      const bullet = line.match(/^\s*[-*•]\s+(.+)$/);
      if (bullet) push(bullet[1]!.split(/[—:.(]/)[0]!);
    }
  }
  return out.slice(0, MAX_BRIEF_POINTS);
}

function close(state: KernelState, job: WorkJob, outcome: WorkJobRecord['outcome'], title: string | null, ts: string, body = ''): KernelState {
  const record: WorkJobRecord = { ...job, closedAt: ts, outcome, title };
  const points = job.kind === 'meeting-brief' && outcome === 'shelved' ? briefPoints(body) : [];
  const briefPointsNext = points.length > 0 ? { ...(state.workbench.briefPoints ?? {}), [job.key]: points } : state.workbench.briefPoints;
  const recent = [...state.workbench.recent, record].slice(-MAX_RECENT_JOBS);
  return { ...state, workbench: { ...state.workbench, open: null, recent, done: { ...state.workbench.done, [job.key]: ts }, ...(briefPointsNext ? { briefPoints: briefPointsNext } : {}) } };
}

/**
 * Open the next owner-requested job when the slot is free. The queue is drained
 * on every close path and on the request itself, so a request never waits for
 * a tick. `openedAt` is stamped when the job actually opens, not when it was
 * asked for — the worker's timeout counts from here.
 */
function drain(state: KernelState, ts: string): { state: KernelState; effects: Effect[] } {
  const queue = state.workbench.queue ?? [];
  if (state.workbench.open !== null || queue.length === 0) return { state, effects: [] };
  const job: WorkJob = { ...queue[0]!, openedAt: ts };
  return {
    state: { ...state, workbench: { ...state.workbench, open: job, queue: queue.slice(1) } },
    effects: [{ type: 'StartSubagent', job: { ...job } }],
  };
}

/**
 * Queue each repeating job whose latest occurrence has not run yet. Pure: the
 * occurrence comes from the schedule, the zone and the tick's own time. A full
 * queue leaves the occurrence for a later tick, inside the grace window.
 */
function queueDueRepeats(state: KernelState, nowIso: string): KernelState {
  const repeats = state.workbench.repeats ?? {};
  let queue = state.workbench.queue ?? [];
  let changed = false;
  const next = { ...repeats };
  for (const [key, repeat] of Object.entries(repeats)) {
    const schedule = parseRepeat(repeat.schedule);
    const at = schedule ? lastOccurrence(schedule, nowIso, state.config.timezone) : null;
    if (at === null || at <= repeat.lastRunAt) continue;
    if (Date.parse(nowIso) - Date.parse(at) <= REPEAT_GRACE_MS) {
      if (queue.length >= MAX_QUEUED_JOBS) continue;
      const jobKey = `repeat:${key}:${at}`;
      queue = [...queue, { id: deriveId(nowIso, 'workbench', jobKey), kind: 'owner-request', key: jobKey, subject: repeat.subject, reason: `you asked for this ${repeat.schedule}`, detail: { brief: repeat.brief }, openedAt: nowIso }];
    }
    next[key] = { ...repeat, lastRunAt: at };
    changed = true;
  }
  return changed ? { ...state, workbench: { ...state.workbench, queue, repeats: next } } : state;
}

function pruneDone(done: Record<string, string>, nowMs: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, at] of Object.entries(done)) if (nowMs - Date.parse(at) < DONE_HORIZON_MS) out[key] = at;
  return out;
}

/**
 * The work loop's one rule. Opens a job when `pickJob` finds one and hands it
 * to the executor as `StartSubagent` (W3; the proactive plugin is the actor
 * that runs it, and `work:stop-requested` asks for `StopSubagent`); it runs a
 * worker turn that ends in `gnomon_shelve` (→ `work:shelved`) or
 * `gnomon_work_done` (→ `work:closed`), which fold back here. A shelved result
 * becomes a `knowledge_entries` row of kind `shelf`, retractable through the
 * ordinary verdict path — the shelf IS the record, not a side table.
 */
export const workbench: Rule = (state, event) => {
  if (event.type === 'work:shelved') {
    const payload = event.payload as ShelvedPayload;
    const title = typeof payload.title === 'string' ? payload.title.trim().slice(0, 140) : '';
    const body = typeof payload.body === 'string' ? payload.body.trim() : '';
    if (title === '' || body === '') return { state, effects: [] };
    const sources = Array.isArray(payload.sources) ? payload.sources.filter((source): source is string => typeof source === 'string' && source.trim() !== '').slice(0, 8) : [];
    const open = state.workbench.open;
    const matches = open !== null && open.id === payload.jobId;
    const closed = matches ? close(state, open, 'shelved', title, event.ts, body) : state;
    const { state: next, effects: nextJob } = drain(closed, event.ts);
    const fullBody = sources.length > 0 ? `${body}\n\nSources:\n${sources.map((source) => `- ${source}`).join('\n')}` : body;
    return {
      state: next,
      effects: [
        // The owner is TOLD, through the gate like everything else Gnomon says.
        // A job they asked for clears the phasic bar (they are waiting on it);
        // one Gnomon picked for itself is context for the next conversation.
        // Lane B: not a meeting brief — the meeting's prep (`briefClock`) is its one notice, and points here.
        ...(matches && open.kind !== 'meeting-brief'
          ? [
              {
                type: 'EmitEvent' as const,
                event: {
                  id: deriveId(event.ts, event.id, 'workbench', `shelved:${open.id}`),
                  type: 'notice:candidate',
                  ts: event.ts,
                  payload: {
                    timestamp: event.ts,
                    shape: 'self-report',
                    kind: 'work-shelved',
                    key: `work-shelved:${open.id}`,
                    surprise: open.kind === 'owner-request' ? 2 : 1,
                    precision: 1,
                    valueHalfLifeMs: open.kind === 'owner-request' ? 4 * 60 * 60 * 1000 : null,
                    observation: `I left "${title}" on your shelf${open.kind === 'owner-request' ? ' — the one you asked for' : ''} (${open.kind} · ${open.subject}).`,
                    evidence: [open.reason],
                    concerns: [],
                  },
                },
              },
            ]
          : []),
        ...nextJob,
        {
          type: 'WriteDB',
          table: 'knowledge_entries',
          row: {
            id: deriveId(event.ts, event.id, 'shelf'),
            kind: 'shelf',
            title,
            body: matches ? `${open.kind} · ${open.subject} — ${open.reason}\n\n${fullBody}` : fullBody,
            severity: null,
            dedupeKey: `shelf:${typeof payload.jobId === 'string' && payload.jobId !== '' ? payload.jobId : event.id}`,
            sourceEventId: event.id,
            createdAt: event.ts,
            importanceScore: 6,
          },
        },
      ],
    };
  }

  if (event.type === 'work:closed') {
    const payload = event.payload as ClosedPayload;
    const open = state.workbench.open;
    if (open === null || open.id !== payload.jobId) return { state, effects: [] };
    const outcome = payload.outcome === 'failed' ? 'failed' : 'nothing';
    const { state: next, effects } = drain(close(state, open, outcome, null, event.ts), event.ts);
    // A job the OWNER asked for that came back empty is news they are waiting
    // on; Gnomon's own empty jobs are not (nothing was promised).
    if (open.kind !== 'owner-request') return { state: next, effects };
    const note = typeof payload.note === 'string' && payload.note.trim() !== '' ? payload.note.trim().slice(0, 200) : outcome === 'failed' ? 'it failed' : 'nothing worth keeping came back';
    return {
      state: next,
      effects: [
        {
          type: 'EmitEvent',
          event: {
            id: deriveId(event.ts, event.id, 'workbench', `closed:${open.id}`),
            type: 'notice:candidate',
            ts: event.ts,
            payload: {
              timestamp: event.ts,
              shape: 'self-report',
              kind: 'work-closed',
              key: `work-closed:${open.id}`,
              surprise: 2,
              precision: 1,
              valueHalfLifeMs: 4 * 60 * 60 * 1000,
              observation: `I could not finish "${open.subject}" — ${note}. Ask me to try again, or narrow it.`,
              evidence: [open.reason],
              concerns: [],
            },
          },
        },
        ...effects,
      ],
    };
  }

  // The owner handed Gnomon a job (`gnomon_start_job`). Not gated on being
  // away, the cap or the gap — they asked — and not counted against the day.
  // Opens now when the slot is free, else waits its turn.
  if (event.type === 'work:requested') {
    const payload = event.payload as RequestedPayload;
    const subject = typeof payload.subject === 'string' ? payload.subject.trim().slice(0, 140) : '';
    const brief = typeof payload.brief === 'string' ? payload.brief.trim().slice(0, 2000) : '';
    if (subject === '' || brief === '') return { state, effects: [] };
    // A schedule keeps the job instead of running it now: "every monday at 9"
    // said on a Thursday runs on Monday. The request itself is the first
    // `lastRunAt`, so an occurrence earlier today is not run late.
    if (typeof payload.repeat === 'string' && payload.repeat.trim() !== '') {
      const repeats = state.workbench.repeats ?? {};
      const key = repeatKey(subject);
      if (parseRepeat(payload.repeat) === null || (!(key in repeats) && Object.keys(repeats).length >= MAX_REPEATS)) return { state, effects: [] };
      return { state: { ...state, workbench: { ...state.workbench, repeats: { ...repeats, [key]: { subject, brief, schedule: payload.repeat.trim().slice(0, 80), lastRunAt: event.ts } } } }, effects: [] };
    }
    const queue = state.workbench.queue ?? [];
    if (queue.length >= MAX_QUEUED_JOBS) return { state, effects: [] };
    // A rule's job was not asked for in the moment: it spends the day's job budget like Gnomon's own.
    const byRule = payload.by === 'rule';
    const today = localDate(event.ts, state.config.timezone);
    const spent = state.workbench.day === today ? state.workbench.countToday : 0;
    if (byRule && spent >= MAX_JOBS_PER_DAY) return { state, effects: [] };
    const key = `owner:${subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)}:${event.ts.slice(0, 10)}`;
    const forGoal = typeof payload.goalId === 'string' && typeof payload.stepId === 'string';
    const job: WorkJob = { id: deriveId(event.ts, event.id, 'workbench', key), kind: 'owner-request', key, subject, reason: forGoal ? 'a step toward a goal you marked active' : byRule ? 'a rule you adopted fired' : 'you asked', detail: { brief, ...(forGoal ? { goalId: payload.goalId!, stepId: payload.stepId! } : {}) }, openedAt: event.ts };
    const counted = byRule ? { day: today, countToday: spent + 1 } : {};
    return drain({ ...state, workbench: { ...state.workbench, ...counted, queue: [...queue, job] } }, event.ts);
  }

  // W3: the owner's Stop. The executor aborts the child and answers `work:closed`, which closes the record.
  if (event.type === 'work:stop-requested') {
    const jobId = typeof event.payload.jobId === 'string' ? event.payload.jobId : '';
    return jobId === '' ? { state, effects: [] } : { state, effects: [{ type: 'StopSubagent', jobId }] };
  }

  if (event.type === 'work:repeat-stopped') {
    const key = repeatKey(typeof event.payload.subject === 'string' ? event.payload.subject : '');
    const repeats = state.workbench.repeats ?? {};
    if (!(key in repeats)) return { state, effects: [] };
    const { [key]: _stopped, ...rest } = repeats;
    return { state: { ...state, workbench: { ...state.workbench, repeats: rest } }, effects: [] };
  }

  if (event.type === 'day:boundary') {
    const done = pruneDone(state.workbench.done, Date.parse(event.ts));
    const briefPointsKept = Object.fromEntries(Object.entries(state.workbench.briefPoints ?? {}).filter(([key]) => key in done));
    return { state: { ...state, workbench: { ...state.workbench, day: null, countToday: 0, done, briefPoints: briefPointsKept } }, effects: [] };
  }

  if (event.type !== 'clock:tick') return { state, effects: [] };

  const now = Date.parse(event.ts);
  // A repeat that came due joins the queue and opens now if the slot is free;
  // the timeout and Gnomon's own picks wait for the next tick.
  const withRepeats = queueDueRepeats(state, event.ts);
  if (withRepeats !== state) return drain(withRepeats, event.ts);
  const open = state.workbench.open;
  if (open !== null) {
    if (now - Date.parse(open.openedAt) < JOB_TIMEOUT_MS) return { state, effects: [] };
    return drain(close(state, open, 'timed-out', null, event.ts), event.ts);
  }

  const day = localDate(event.ts, state.config.timezone);
  const dayState = state.workbench.day === day ? state : { ...state, workbench: { ...state.workbench, day, countToday: 0 } };
  const job = pickJob(dayState, event.ts);
  if (job === null) return dayState === state ? { state, effects: [] } : { state: dayState, effects: [] };

  return {
    state: { ...dayState, workbench: { ...dayState.workbench, open: job, countToday: dayState.workbench.countToday + (job.kind === 'meeting-brief' ? 0 : 1) } },
    effects: [{ type: 'StartSubagent', job: { ...job } }],
  };
};
