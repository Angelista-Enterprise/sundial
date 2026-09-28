import type { KernelState, Rule } from '@sundial/kernel/types.js';
import { deriveId } from '@sundial/helpers/derive-id.js';
import { namedAttendees } from './people-ask.js';
import { formatClock } from '@sundial/helpers/local-day.js';
import { meetingJobKey } from './workbench.js';

/** The window after a meeting's end in which the question is worth asking. */
export const FOLLOWUP_MIN_AFTER_MS = 2 * 60 * 1000;
export const FOLLOWUP_MAX_AFTER_MS = 20 * 60 * 1000;
/** Seen meetings older than this are forgotten. */
export const SEEN_HORIZON_MS = 2 * 24 * 60 * 60 * 1000;
/** A work call shorter than this is a quick sync, not something to debrief. */
export const CALL_FOLLOWUP_MIN_MS = 10 * 60 * 1000;
/**
 * Fewer utterances per minute than this, with hearing awake, is a room the
 * owner was not in. On the live record (2026-09-11 → 09-23) the two meetings
 * the owner said they skipped heard 1 and 16 utterances; one whose calendar time
 * was wrong heard 34 in an hour; every attended one heard 96 or more.
 */
export const ABSENT_BELOW_PER_MIN = 1;

/**
 * Hearing was awake for the meeting and almost nothing was said: the owner was
 * elsewhere. Zero utterances is NOT absence — a transcriber that died hears
 * nothing too, and a quiet room is rarely silent to whisper — so it still asks.
 */
export function wasAbsent(meeting: { start: string; end: string; listened?: boolean; heard?: number }): boolean {
  const heard = meeting.heard ?? 0;
  if (!meeting.listened || heard === 0) return false;
  const minutes = (Date.parse(meeting.end) - Date.parse(meeting.start)) / 60_000;
  return heard < minutes * ABSENT_BELOW_PER_MIN;
}

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
    const spoken = (event.payload as { spokenText?: unknown }).spokenText;
    if (typeof spoken !== 'string' || spoken.trim() === '') return { state, effects: [] };
    let seen: KernelState['meetings']['seen'] | null = null;
    for (const [key, meeting] of Object.entries(state.meetings.seen)) {
      if (event.ts < meeting.start || event.ts > meeting.end) continue;
      seen ??= { ...state.meetings.seen };
      seen[key] = { ...meeting, heard: (meeting.heard ?? 0) + 1 };
    }
    return seen ? { state: { ...state, meetings: { seen } }, effects: [] } : { state, effects: [] };
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
    seen[key] = { title: meeting.title, start: meeting.start, end: meeting.end, attendees: others, askedAt: null };
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
      seen[key] = { title: `the call in ${lastCall.app}`, start: lastCall.since, end: lastCall.until, attendees: [], askedAt: null };
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
  if (state.ownerAsk.open === null) {
    const due = Object.entries(seen).find(([, meeting]) => {
      if (meeting.askedAt !== null || wasAbsent(meeting)) return false;
      const since = now - Date.parse(meeting.end);
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
      const choices = ['Fine, nothing to keep', 'Let me tell you', ...points.map((point) => `Mostly: ${point}`.slice(0, 48))];
      effects.push({
        type: 'EmitEvent',
        event: {
          id: deriveId(event.ts, event.id, 'meeting-followup', key),
          type: 'ask:owner-opened',
          ts: event.ts,
          payload: {
            askId: `owner-ask:meeting-${deriveId(meeting.start, 'meeting-followup', key).slice(0, 12)}`,
            question: meeting.attendees.length === 0 ? `How did ${meeting.title} go? Who was it with, and anything worth remembering?` : `How did "${meeting.title}" go? Anything worth remembering — decisions, who said what, follow-ups?`,
            reason: `ended ${formatClock(meeting.end, state.config.timezone)} with ${who}`,
            choices,
          },
        },
      });
    }
  }

  if (!changed) return { state, effects };
  return { state: { ...state, meetings: { seen } }, effects };
};
