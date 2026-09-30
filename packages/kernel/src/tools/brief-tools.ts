import { z } from 'zod';
import { briefHeader, briefsOf, lastWorkDay, mondayOf, othersIn, prepLines, standupLines } from '../briefs.js';
import type { KernelState } from '../types.js';
import type { GnomonTool } from './registry.js';

/** Lane B: the next meeting with other people, or the first whose title has `title` in it. */
function nextMeeting(state: KernelState, now: string, title?: string) {
  const needle = title?.trim().toLowerCase();
  return state.schedule.upcoming.find((m) => !m.isAllDay && Date.parse(m.end) > Date.parse(now) && othersIn(state, m.attendees).length > 0 && (!needle || m.title.toLowerCase().includes(needle))) ?? null;
}

/** Lane B — the standup draft, a meeting's prep and the week in review, on demand (#22, #13, #14). */
export const BRIEF_TOOLS: GnomonTool[] = [
  {
    name: 'gnomon_brief',
    description: [
      'A short brief read from the record, without a model — the same lines Gnomon says on its own before a standup or a meeting, and shows on Today.',
      '`standup`: three lines to say at a standup — the last working day\'s commits, pull requests, tickets, promises kept and agent sessions, then today\'s meetings and what is due.',
      '`meeting`: prep for the next meeting with other people, or the one whose title contains `title` — promises with those people, the last meeting with them, tickets in play, recent mail subjects. Empty lines mean the record holds nothing on them.',
      '`week`: the week in review as last composed (from Friday 13:00, hourly through the weekend) — commits and merged pull requests, promises kept or broken (with the counts), time by project, mail from people you meet still waiting for a reply, and next week\'s meetings.',
      'Mail is subjects only; Slack, chat and mail bodies are not read.',
    ].join(' '),
    schema: {
      kind: z.enum(['standup', 'meeting', 'week']).describe('Which brief.'),
      title: z.string().max(120).optional().describe('For `meeting`: part of the meeting\'s title. Omit for the next meeting with others.'),
    },
    readOnly: true,
    handler: async ({ kind, title }, env) => {
      const state = await env.state();
      if (!state) return { unavailable: 'No kernel state has been written yet.' };
      const now = env.now.toISOString();
      if (kind === 'week') {
        const week = briefsOf(state).week ?? null;
        if (!week) return { none: 'No week in review has been composed yet: it is composed from Friday 13:00, hourly through the weekend.' };
        return week.from === mondayOf(now, state.config.timezone) ? week : { ...week, note: `This is the review of the week of ${week.from}; this week's is composed from Friday 13:00.` };
      }
      if (kind === 'standup') return { lines: standupLines(state, now), lastWorkDay: lastWorkDay(state, now) };
      const m = nextMeeting(state, now, title as string | undefined);
      if (!m) return { none: title ? `No meeting with others whose title contains "${title}" is on the calendar ahead.` : 'No meeting with others is on the calendar ahead.' };
      const lines = prepLines(state, m, now);
      return { meeting: { title: m.title, start: m.start, end: m.end }, lines: [briefHeader(state, m), ...(lines.length > 0 ? lines : ['Nothing on the record about these people yet.'])] };
    },
  },
];
