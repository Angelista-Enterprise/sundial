import type { KernelState, Rule } from '@sundial/kernel/types.js';
import { deriveId } from '@sundial/helpers/derive-id.js';
import { namedAttendees } from './people-ask.js';
import { formatClock } from '@sundial/helpers/local-day.js';
import { meetingJobKey } from './workbench.js';
import { directionOf, meetingPromiseId, promiseLine } from './promise-track.js';
import { openAsk } from '@sundial/helpers/loops.js';
import { ABSENT_BELOW_PER_MIN, attendanceOf } from '@sundial/kernel/attendance.js';

/** The window after a meeting's end in which the question is worth asking. */
export const FOLLOWUP_MIN_AFTER_MS = 2 * 60 * 1000;
export const FOLLOWUP_MAX_AFTER_MS = 20 * 60 * 1000;
/** UC1-X3: how long the question waits for the meeting's promise pass before asking without it. */
export const EXTRACT_WAIT_MS = 8 * 60 * 1000;
/** Seen meetings older than this are forgotten. */
export const SEEN_HORIZON_MS = 2 * 24 * 60 * 60 * 1000;
/** A work call shorter than this is a quick sync, not something to debrief. */
export const CALL_FOLLOWUP_MIN_MS = 10 * 60 * 1000;
// ABSENT_BELOW_PER_MIN lives with `attendanceOf` (kernel/attendance.ts). On the live record (2026-09-11 →
// 09-23) the two meetings the owner said they skipped heard 1 and 16 utterances; one whose calendar time was
// wrong heard 34 in an hour; every attended one heard 96 or more.
export { ABSENT_BELOW_PER_MIN };

/**
 * Hearing was awake for the meeting and almost nothing was said: the owner was
 * elsewhere. Zero utterances is NOT absence — a transcriber that died hears
 * nothing too, and a quiet room is rarely silent to whisper — so it still asks.
 */
export function wasAbsent(meeting: { start: string; end: string; listened?: boolean; heard?: number }): boolean {
  return attendanceOf({ title: '', attendees: [], askedAt: null, ...meeting }) === 'absent';
}

/** The question's id for a meeting: the same on the way out and when the answer comes back. */
export const meetingAskId = (key: string, start: string) => `owner-ask:meeting-${deriveId(start, 'meeting-followup', key).slice(0, 12)}`;

const WASNT_THERE = /^(wasn'?t|was not|not there|didn'?t|no\b|nee\b|niet)/i;
const WAS_THERE = /^(yes|ja|yep|i was|was there)/i;

function isOwner(name: string, aliases: readonly string[]): boolean {
  const needle = name.trim().toLowerCase();
  return aliases.some((alias) => alias.trim().toLowerCase() === needle);
}

// The owner's own clock, from the one formatter in helpers: this string is READ
// BY THE OWNER (the reason line under the question), and the first version
// sliced the ISO string and said "ended 09:30Z" for a meeting that ended at
// 11:30 in Amsterdam.

/**
 * The other half of the meeting loop. The work loop briefs the owner BEFORE a
 * meeting; this asks them, once, shortly AFTER: "how did it go?" — the one
 * question whose answer no sensor can supply, and which the conversation pass
 * then turns into memory (who was there, what was agreed, what to remember).
 *
 * Meetings are remembered in this rule's own slice rather than read off
 * `schedule.upcoming` at the end, because `scheduleTrack` drops an ended
 * meeting on the next calendar poll and a tick can miss the window. Only
 * meetings with other people count; a blocked-out hour is not a meeting.
 * Goes through `ask:owner-opened`, so the ownerAsk rule's one-question-at-a-time
 * and 24 h expiry govern it like any question Gnomon asks.
 */
export const meetingFollowup: Rule = (state, event) => {
  if (event.type === 'audio:transcript') {
    const { spokenText: spoken, channel } = event.payload as { spokenText?: unknown; channel?: unknown };
    if (typeof spoken !== 'string' || spoken.trim() === '') return { state, effects: [] };
    // The far side of a call (the Mac's own output, `channel: system`) is heard
    // whether or not the owner is at the desk: a call left running in an empty
    // room would otherwise read as attended. Only the microphone counts as
    // `heard`; both streams count as `voices`, what the promise pass can read.
    let seen: KernelState['meetings']['seen'] | null = null;
    for (const [key, meeting] of Object.entries(state.meetings.seen)) {
      if (event.ts < meeting.start || event.ts > meeting.end) continue;
      seen ??= { ...state.meetings.seen };
      seen[key] = { ...meeting, voices: (meeting.voices ?? 0) + 1, ...(channel === 'system' ? {} : { heard: (meeting.heard ?? 0) + 1 }) };
    }
    return seen ? { state: { ...state, meetings: { seen } }, effects: [] } : { state, effects: [] };
  }
  // UC1: the promise pass answered. Its promises open in `promiseTrack`; the
  // meeting keeps their ids and one line each, for the question at its end.
  if (event.type === 'meeting:promises') {
    const p = event.payload as { meetingKey?: unknown; start?: unknown; promises?: unknown };
    const key = typeof p.meetingKey === 'string' ? p.meetingKey : '';
    const meeting = state.meetings.seen[key];
    if (!meeting || meeting.promised || !Array.isArray(p.promises) || typeof p.start !== 'string') return { state, effects: [] };
    const found = (p.promises as { who?: unknown; kind?: unknown; to?: unknown; what?: unknown; due?: unknown }[]).map((mp, i) => ({ mp, id: meetingPromiseId(p.start as string, key, i) }));
    const owed = found.filter(({ mp }) => typeof mp?.what === 'string' && directionOf({ who: mp.who === 'other' ? 'other' : 'owner', kind: mp.kind === 'request' ? 'request' : 'promise' }) !== 'awaiting');
    const promised = { ids: owed.map((f) => f.id), lines: [] as string[] };
    return { state: { ...state, meetings: { seen: { ...state.meetings.seen, [key]: { ...meeting, promised } } } }, effects: [] };
  }
  // The owner answered "Were you in X?": their word is the verdict (`attendanceOf`).
  if (event.type === 'ask:owner-answered') {
    const p = event.payload as { askId?: unknown; answer?: unknown };
    const answer = typeof p.answer === 'string' ? p.answer.trim() : '';
    const hit = Object.entries(state.meetings.seen).find(([key, m]) => meetingAskId(key, m.start) === p.askId);
    if (!hit || answer === '') return { state, effects: [] };
    const confirmed = WASNT_THERE.test(answer) ? 'no' : WAS_THERE.test(answer) ? 'yes' : null;
    if (!confirmed) return { state, effects: [] };
    return { state: { ...state, meetings: { seen: { ...state.meetings.seen, [hit[0]]: { ...hit[1], confirmed } } } }, effects: [] };
  }
  if (event.type !== 'clock:tick') return { state, effects: [] };
  const now = Date.parse(event.ts);
  const aliases = state.config.ownerAliases;

  let seen = state.meetings.seen;
  let changed = false;

  // Remember what is on the calendar with other people.
  for (const meeting of state.schedule.upcoming) {
    if (meeting.isAllDay || meeting.title.trim() === '') continue;
    const key = `${meeting.title}|${meeting.start}`;
    if (seen[key]) continue;
    const others = meeting.attendees.filter((name) => !isOwner(name, aliases));
    if (others.length === 0) continue;
    if (!changed) {
      seen = { ...seen };
      changed = true;
    }
    seen[key] = { title: meeting.title, start: meeting.start, end: meeting.end, attendees: others, askedAt: null, ...(meeting.online ? { online: true } : {}) };
  }

  // Was hearing awake inside a meeting? Without it, silence says nothing.
  if (state.hearing?.listening) {
    for (const [key, meeting] of Object.entries(seen)) {
      if (meeting.listened || event.ts < meeting.start || event.ts > meeting.end) continue;
      if (!changed) {
        seen = { ...seen };
        changed = true;
      }
      seen[key] = { ...meeting, listened: true };
    }
  }

  // Was the owner in it? One sample a minute while it runs (`attendanceOf`): a call app on the mic or camera,
  // the owner at the keys, the laptop on the network the owner labelled home.
  // A personal call (WhatsApp, FaceTime, the phone) during a meeting is not the meeting.
  const callApp = state.av.call !== null && state.av.call.kind !== 'personal-call';
  const atKeys = state.lifeEvent?.idle?.isIdle === false;
  const atHome = state.config.locationLabels?.[state.network?.fingerprint ?? ''] === 'home';
  for (const [key, meeting] of Object.entries(seen)) {
    if (event.ts < meeting.start || event.ts > meeting.end) continue;
    if (!changed) {
      seen = { ...seen };
      changed = true;
    }
    seen[key] = { ...meeting, ticks: (meeting.ticks ?? 0) + 1, active: (meeting.active ?? 0) + (atKeys ? 1 : 0), home: (meeting.home ?? 0) + (atHome ? 1 : 0), ...(callApp ? { called: true } : {}) };
  }

  // Forget the old.
  // An ad-hoc work call the calendar never knew about (`callSpanTrack`): a
  // microphone held by a conferencing app or a browser for ten minutes or more,
  // not overlapping a scheduled meeting. Personal calls are not asked about.
  const lastCall = state.av.lastCall;
  if (lastCall && lastCall.kind === 'work-call') {
    const callMs = Date.parse(lastCall.until) - Date.parse(lastCall.since);
    const key = `call|${lastCall.since}`;
    const overlapsScheduled = Object.values(seen).some((m) => !m.title.startsWith('the call in ') && m.start <= lastCall.until && m.end >= lastCall.since);
    if (callMs >= CALL_FOLLOWUP_MIN_MS && !seen[key] && !overlapsScheduled) {
      if (!changed) {
        seen = { ...seen };
        changed = true;
      }
      seen[key] = { title: `the call in ${lastCall.app}`, start: lastCall.since, end: lastCall.until, attendees: [], askedAt: null, called: true };
    }
  }

  for (const [key, meeting] of Object.entries(seen)) {
    if (now - Date.parse(meeting.end) > SEEN_HORIZON_MS) {
      if (!changed) {
        seen = { ...seen };
        changed = true;
      }
      delete seen[key];
    }
  }

  const effects: ReturnType<Rule>['effects'] = [];
  // Once a meeting the signals put the owner in is over: `meeting:attended`, which `entityExtract` turns into
  // "met with" facts. They used to be written when the calendar said it STARTED, for meetings never joined too.
  for (const [key, meeting] of Object.entries(seen)) {
    if (meeting.metAt || key.startsWith('call|') || meeting.attendees.length === 0 || now < Date.parse(meeting.end)) continue;
    if (meeting.confirmed !== 'yes' && now - Date.parse(meeting.end) > FOLLOWUP_MAX_AFTER_MS) continue;
    if (attendanceOf(meeting) !== 'joined') continue;
    if (!changed) {
      seen = { ...seen };
      changed = true;
    }
    seen[key] = { ...meeting, metAt: event.ts };
    effects.push({ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'meeting-attended', key), type: 'meeting:attended', ts: event.ts, payload: { event: { eventId: key, title: meeting.title, start: meeting.start, end: meeting.end, attendees: meeting.attendees } } } });
  }
  // UC1 (U1-F2): one promise pass per meeting, once it is over and while the
  // question about it is still ahead. Only a meeting something was heard in —
  // or an unscheduled call, whose words were counted before it had a key.
  // Overlapping entries (a meeting and its room booking) heard the same words:
  // one pass for them, the entry with the most attendees first.
  // W6 P2: NOT gated on `wasAbsent`. That test counts the owner's microphone only (S11), against a
  // bar measured on both channels, so a call the owner mostly listened to read as a room they were
  // not in and no meeting on the live record ever got a pass. What the far side promised the owner
  // is worth reading whether or not the owner spoke; the absence test still keeps the question.
  const span = (m: { start: string; end: string }) => [Date.parse(m.start), Date.parse(m.end)] as const;
  const passed = Object.values(seen).filter((m) => m.extractAt).map(span);
  for (const [key, meeting] of Object.entries(seen).sort(([, a], [, b]) => b.attendees.length - a.attendees.length)) {
    const since = now - Date.parse(meeting.end);
    if (meeting.extractAt || since < 0 || since > FOLLOWUP_MAX_AFTER_MS) continue;
    const isCall = key.startsWith('call|');
    if (!isCall && (meeting.voices ?? 0) === 0) continue;
    // Promises are the owner's only if the owner was there (2026-10-07: the calendar alone no longer says so).
    if (attendanceOf(meeting) !== 'joined') continue;
    if (!changed) {
      seen = { ...seen };
      changed = true;
    }
    seen[key] = { ...meeting, extractAt: event.ts };
    const [start, end] = span(meeting);
    const twin = passed.some(([s, e]) => start < e && s < end);
    passed.push([start, end]);
    if (twin) continue;
    effects.push({ type: 'RunMeetingPromises', meetingKey: key, title: meeting.title, start: meeting.start, end: meeting.end, attendees: meeting.attendees, ts: event.ts });
  }
  if (openAsk(state) === null && state.commitments.promiseAsk === null) {
    const due = Object.entries(seen).find(([, meeting]) => {
      // Asked only about a meeting the signals put the owner in: never one declined, missed, or merely on the calendar.
      // Joined: how did it go. Unknown (in person, hearing off, no call app): ask whether they were there at all. Absent: nothing.
      if (meeting.askedAt !== null || attendanceOf(meeting) === 'absent') return false;
      const since = now - Date.parse(meeting.end);
      // UC1-X3: while the promise pass is out, wait for it (a few minutes at
      // most), so the one question can show what it found.
      if (meeting.extractAt && !meeting.promised && now - Date.parse(meeting.extractAt) < EXTRACT_WAIT_MS && since < FOLLOWUP_MAX_AFTER_MS - 60_000) return false;
      return since >= FOLLOWUP_MIN_AFTER_MS && since <= FOLLOWUP_MAX_AFTER_MS;
    });
    if (due) {
      const [key, meeting] = due;
      if (!changed) {
        seen = { ...seen };
        changed = true;
      }
      seen[key] = { ...meeting, askedAt: event.ts };
      // Names where the owner has given them; the alias only where they have not.
      const named = namedAttendees(meeting.attendees, state.memory.aliasNames);
      const who = named.length === 0 ? 'no calendar entry' : named.slice(0, 4).join(', ') + (named.length > 4 ? ` and ${named.length - 4} more` : '');
      // The brief's own points, when the workbench wrote one for this meeting:
      // "how did it go?" becomes "did X come up?", which is a question with an
      // answer. Two fixed choices plus at most two points keeps it under the
      // four-button ceiling `ownerAsk` enforces.
      const points = state.workbench.briefPoints?.[meetingJobKey(meeting.title, meeting.start)] ?? [];
      // UC1-X3: one question, and it asks about promises. When the promise
      // pass found some, it shows them for confirmation instead of asking.
      const found = (meeting.promised?.ids ?? []).map((id) => state.commitments.promises.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => c !== undefined);
      const lines = found.map((c) => promiseLine(state, c));
      const label = meeting.attendees.length === 0 ? meeting.title : `"${meeting.title}"`;
      const unsure = attendanceOf(meeting) === 'unknown';
      const question = unsure
        ? `Were you in ${label}? If so — did you promise anything?`
        : found.length > 0
          ? `How did ${label} go? I heard you promise: ${lines.join('; ')}. Keep track of ${found.length === 1 ? 'it' : 'them'}?`
          : meeting.attendees.length === 0
            ? `How did ${label} go? Who was it with — and did you promise anything?`
            : `How did ${label} go — did you promise anything?`;
      const choices = unsure
        ? ["Wasn't there", 'Yes — nothing promised', 'Yes — tell me']
        : found.length === 0 ? ['No', 'Yes — tell me', ...points.slice(0, 2).map((point) => `Mostly: ${point}`.slice(0, 48))] : found.length === 1 ? ['Track it', 'Not a promise'] : ['Track them', 'Only the first', 'Not promises'];
      effects.push({
        type: 'EmitEvent',
        event: {
          id: deriveId(event.ts, event.id, 'meeting-followup', key),
          type: 'ask:owner-opened',
          ts: event.ts,
          payload: {
            askId: meetingAskId(key, meeting.start),
            question,
            reason: `ended ${formatClock(meeting.end, state.config.timezone)} with ${who}`,
            choices,
            promiseAsk: { kind: 'meeting', ids: found.map((c) => c.id), attendees: meeting.attendees, meeting: { title: meeting.title, start: meeting.start } },
          },
        },
      });
    }
  }

  if (!changed) return { state, effects };
  return { state: { ...state, meetings: { seen } }, effects };
};
