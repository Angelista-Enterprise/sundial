import type { KernelState } from './types.js';
import { localHour } from '@sundial/helpers/local-day.js';

/**
 * S1 — what is true right now, in one object (docs/jarvis/09).
 *
 * Gnomon had two partial answers to "right now" and they did not agree: the
 * presence line (`nowSnapshot`, client-side) knew the app and the moment, and the
 * agent's standing context knew goals and every open commitment. Neither knew
 * what is NEXT, what is open on the project the owner is IN, or where they LEFT
 * OFF — which is three of the four questions the owner's 193 chats keep asking.
 * This is the join, pure over `KernelState` plus the few reads a rule cannot
 * make, and it is the one thing the screen and the agent both read, so they
 * cannot describe two different presents.
 *
 * Every field is what the record holds, labelled for how sure it is: a project
 * carried over from the last attributed moment says so (`projectIsSticky`), and
 * a missing piece is null, never a guess.
 */

export type YouAre = 'in-a-call' | 'in-a-meeting' | 'away' | 'deep' | 'working';

export interface LeftOff {
  projectId: string;
  projectName: string;
  at: string;
  what: string;
}

/**
 * S2 — the moment of the day, and the one question it answers. The owner's
 * chats ask these at these moments: "what did I do yesterday" 07:30–09:00,
 * "what did I do today" 19:00–22:00, a brief before a meeting and a debrief
 * after, "where was I" after a break or a switch. Derived from the situation
 * and the clock; no sensor of its own.
 */
export type Phase = 'meeting-soon' | 'meeting-ended' | 'back-from-break' | 'switched-project' | 'morning' | 'evening' | 'working';

export const PHASE_QUESTION: Record<Phase, string> = {
  'meeting-soon': 'What do I need for the next meeting?',
  'meeting-ended': 'What came out of that meeting?',
  'back-from-break': 'Where was I?',
  'switched-project': 'What is open on this project?',
  morning: 'What did I do yesterday, and where did I leave off?',
  evening: 'What did I do today?',
  working: 'What am I in the middle of?',
};

/** A meeting starts within this many minutes: brief time. */
export const MEETING_SOON_MIN = 15;
/** A meeting ended within this many minutes: debrief time. */
export const MEETING_ENDED_MIN = 20;
/** Away at least this long, and back within {@link JUST_NOW_MIN}: a break, over. */
export const BREAK_MIN = 15;
export const JUST_NOW_MIN = 10;

export interface Situation {
  at: string;
  phase: Phase;
  /** The question {@link phase} answers — what a surface following the moment leads with. */
  question: string;
  now: {
    app: string | null;
    project: { id: string; name: string } | null;
    /** True when the project is the last one attributed, not the one in front — a browser tab has no project. */
    projectIsSticky: boolean;
    branch: string | null;
    sinceMin: number | null;
    intent: string | null;
  };
  you: YouAre;
  next: { title: string; startsInMin: number; with: string[] } | null;
  /** All-day items for today — someone's afternoon off, a conference week. Context, not appointments. */
  todayAllDay: string[];
  openHere: {
    commitments: { id: string; name: string; quietDays: number }[];
    unpushed: { branch: string | null; ahead: number } | null;
    hotFiles: string[];
  };
  /** The last thing done on each recent project, newest first — "where did I leave X". */
  leftOff: LeftOff[];
  waitingForYou: { question: string | null; shelf: number };
}

export interface SituationExtras {
  leftOff?: LeftOff[];
  shelfWaiting?: number;
}

/** Long enough in one place to be worth protecting; the flow tracker's own span. */
export const DEEP_AFTER_MIN = 25;

const minutesBetween = (fromIso: string | null | undefined, toMs: number): number | null => {
  const from = Date.parse(fromIso ?? '');
  return Number.isFinite(from) ? Math.max(0, Math.round((toMs - from) / 60_000)) : null;
};

export function buildSituation(state: KernelState, extras: SituationExtras = {}, nowMs = Date.now()): Situation {
  const moment = state.moment ?? null;
  const window = state.window?.active ?? null;
  const known = state.project?.known ?? {};

  const attributed = moment?.projectId ? { id: moment.projectId, name: known[moment.projectId]?.name ?? moment.projectId } : null;
  const sticky = attributed === null && state.project?.current ? { id: state.project.current.id, name: state.project.current.name } : null;
  const project = attributed ?? sticky;

  // The calendar: the next timed event, and today's all-day ones as context.
  // `isAllDay` items ("Noah middag vrij") would otherwise always be "next".
  const upcoming = state.schedule?.upcoming ?? [];
  const timed = upcoming.filter((e) => !e.isAllDay);
  const inMeeting = timed.some((e) => Date.parse(e.start) <= nowMs && nowMs < Date.parse(e.end));
  const nextEvent = timed.filter((e) => Date.parse(e.start) > nowMs).sort((a, b) => a.start.localeCompare(b.start))[0] ?? null;
  const dayEnd = nowMs + 24 * 3_600_000;
  const todayAllDay = [...new Set(upcoming.filter((e) => e.isAllDay && Date.parse(e.start) <= nowMs && nowMs < Date.parse(e.end) && Date.parse(e.start) < dayEnd).map((e) => e.title))];

  const flow = state.lifeEvent?.flow ?? null;
  const flowMin = flow ? minutesBetween(flow.startedAt, nowMs) : null;
  const you: YouAre = state.av?.call ? 'in-a-call' : inMeeting ? 'in-a-meeting' : state.lifeEvent?.idle?.isIdle ? 'away' : flowMin !== null && flowMin >= DEEP_AFTER_MIN ? 'deep' : 'working';

  // What is open on THIS project. Keyed the way the trackers key it: the
  // project id is the repository path, and so are the git and file maps.
  const commitments = project
    ? (state.commitments?.open ?? [])
        .filter((c) => c.projectId === project.id)
        .sort((a, b) => b.lastTouchedAt.localeCompare(a.lastTouchedAt))
        .map((c) => ({ id: c.id, name: c.name, quietDays: Math.floor((minutesBetween(c.lastTouchedAt, nowMs) ?? 0) / 1440) }))
    : [];
  const ahead = project ? state.git?.unpushed?.[project.id] : undefined;
  const hotFiles = project
    ? Object.values(state.files?.hot ?? {})
        .filter((f) => f.projectRoot === project.id)
        .sort((a, b) => b.changes - a.changes)
        .slice(0, 5)
        .map((f) => f.relPath)
    : [];

  const phase = phaseOf(state, { inMeeting, nextInMin: nextEvent ? (minutesBetween(new Date(nowMs).toISOString(), Date.parse(nextEvent.start)) ?? 0) : null }, nowMs);

  return {
    at: new Date(nowMs).toISOString(),
    phase,
    question: PHASE_QUESTION[phase],
    now: {
      app: window?.processName ?? moment?.processName ?? null,
      project,
      projectIsSticky: attributed === null && sticky !== null,
      branch: moment?.rollup?.gitBranch ?? null,
      sinceMin: moment ? minutesBetween(moment.startTime, nowMs) : null,
      intent: moment?.intent?.status === 'done' && typeof moment.intent.text === 'string' ? moment.intent.text : null,
    },
    you,
    // Who is in it: not the owner (their own name is on their own invites) and
    // not the room ("RTM-1-01 - Aquarium (12)" — every room ends in its size).
    next: nextEvent ? { title: nextEvent.title, startsInMin: minutesBetween(new Date(nowMs).toISOString(), Date.parse(nextEvent.start)) ?? 0, with: (nextEvent.attendees ?? []).filter((a) => !/\(\d+\)\s*$/.test(a) && !(state.config?.ownerAliases ?? []).some((o) => o.trim().toLowerCase() === a.trim().toLowerCase())) } : null,
    todayAllDay,
    openHere: { commitments, unpushed: ahead ? { branch: ahead.branch, ahead: ahead.ahead } : null, hotFiles },
    leftOff: extras.leftOff ?? [],
    waitingForYou: { question: state.ownerAsk?.open?.question ?? null, shelf: extras.shelfWaiting ?? 0 },
  };
}

/**
 * Which moment of the day it is. First match wins, most time-bound first: a
 * meeting in ten minutes outranks it being morning.
 */
export function phaseOf(state: KernelState, calendar: { inMeeting: boolean; nextInMin: number | null }, nowMs = Date.now()): Phase {
  if (!calendar.inMeeting && calendar.nextInMin !== null && calendar.nextInMin <= MEETING_SOON_MIN) return 'meeting-soon';

  // A meeting that just ended — and one the owner was in: hearing awake with
  // almost nothing said is a room they were not in (`meetingFollowup`'s test).
  const ended = Object.values(state.meetings?.seen ?? {}).some((m) => {
    const since = (nowMs - Date.parse(m.end)) / 60_000;
    if (!(since >= 0 && since <= MEETING_ENDED_MIN)) return false;
    const minutes = (Date.parse(m.end) - Date.parse(m.start)) / 60_000;
    const absent = m.listened === true && (m.heard ?? 0) > 0 && (m.heard ?? 0) < minutes;
    return !absent;
  });
  if (ended && !calendar.inMeeting) return 'meeting-ended';

  // The moment in front started just now; what came before it says why.
  const moment = state.moment ?? null;
  const last = state.project?.lastClosedMoment ?? null;
  const startedMin = moment ? (nowMs - Date.parse(moment.startTime)) / 60_000 : null;
  if (moment && startedMin !== null && startedMin <= JUST_NOW_MIN && last?.endedAt) {
    const gapMin = (Date.parse(moment.startTime) - Date.parse(last.endedAt)) / 60_000;
    if (gapMin >= BREAK_MIN) return 'back-from-break';
    if (moment.projectId && last.projectId && moment.projectId !== last.projectId) return 'switched-project';
  }

  const hour = localHour(new Date(nowMs).toISOString(), state.config?.timezone ?? 'UTC');
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 18 || hour < 4) return 'evening';
  return 'working';
}
