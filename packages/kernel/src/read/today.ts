import { buildDailyContext } from '../daily-context.js';
import type { KernelState } from '../types.js';

/**
 * Today's numbers, for one date: what the web client's Today card and the MCP `gnomon_today`
 * tool both draw. One function, so the two cannot disagree. Moved here from the theme's host on
 * 2026-10-05 (Track B); the route only resolves its span and calls this.
 */
export interface TodayRead {
  date: string;
  coverage: { trackedMin: number; wallClockMin: number; firstActivity: string | null; lastActivity: string | null };
  focus: { deepMin: number; steadyMin: number; shallowMin: number };
  noProjectMin: number;
  /** Biggest first: the day's shape is the finding, and a list in record order buries it. */
  projects: { name: string; minutes: number; commits: number; confidence: 'certain' | 'weak' | null }[];
  noticed: { title: string; body: string }[];
  meetings: number;
  /** The files worked in most today, off the fold's hot-files ring. Only for today: the ring is reset at the day boundary. */
  hotFiles: { path: string; project: string; changes: number; focusedChanges: number; lastAt: string }[];
}

function hotFilesOf(state: KernelState | null | undefined): TodayRead['hotFiles'] {
  return Object.values(state?.files?.hot ?? {})
    .sort((a, b) => b.changes - a.changes)
    .slice(0, 6)
    .map((f) => ({ path: f.relPath, project: f.projectRoot.split('/').pop() ?? f.projectRoot, changes: f.changes, focusedChanges: f.focusedChanges, lastAt: f.lastAt }));
}

export async function readToday({ state, date, timeZone, isToday }: { state: KernelState | null | undefined; date: string; timeZone: string; isToday: boolean }): Promise<TodayRead> {
  const context = await buildDailyContext(date, { timeZone });
  return {
    date,
    coverage: context.coverage,
    focus: context.focus,
    noProjectMin: context.noProjectMin,
    projects: [...context.projects]
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 6)
      .map((project) => ({ name: project.name, minutes: project.minutes, commits: project.commits, confidence: project.confidence })),
    noticed: context.anomalies.slice(0, 4).map((anomaly) => ({ title: anomaly.title, body: anomaly.body })),
    meetings: context.meetings.length,
    hotFiles: isToday ? hotFilesOf(state) : [],
  };
}
