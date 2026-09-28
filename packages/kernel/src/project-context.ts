import { getAllProjects, getMomentsForProject } from '@sundial/db/index.js';
import { canonicalProjectName } from '@sundial/helpers/sundial-config.js';
import { buildFocus, buildPhaseMix, minutes, viewMoment, type MomentView } from './daily-context.js';
import type { MomentKind } from './types.js';

// ─── Public shape ────────────────────────────────────────────────────────────

export interface ProjectMomentumPoint {
  /** YYYY-MM-DD (local). */
  date: string;
  minutes: number;
}

export interface ProjectRecentEntry {
  /** YYYY-MM-DD (local). */
  date: string;
  /** The moment's narrative if present, else its intent. */
  text: string;
}

/**
 * The rolling, date-independent activity pack for one project — the
 * `DailyContext` analog scoped to "where this project stands lately" rather
 * than "what happened on day X". Feeds the on-demand project-status writer.
 */
export interface ProjectStatusContext {
  projectId: string;
  name: string;
  rootPath: string;
  org: string | null;
  span: { firstActivity: string | null; lastActivity: string | null; daysActive: number };
  totalTrackedMin: number;
  momentCount: number;
  commits: number;
  branches: string[];
  phaseMix: Record<MomentKind, number>;
  focus: { deepMin: number; steadyMin: number; shallowMin: number };
  /** Per-day tracked minutes over the window, chronological. */
  momentum: ProjectMomentumPoint[];
  /** Most-recent narratives/intents, newest first. */
  recent: ProjectRecentEntry[];
}

export interface BuildProjectStatusContextOptions {
  projectAliases?: Record<string, string>;
  /** Cap on moments pulled for the project (most recent first). Tokens are ~free (self-hosted), so generous. */
  maxMoments?: number;
  /** Cap on the recent narrative entries serialized. */
  maxRecent?: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** YYYY-MM-DD in the host's local tz (the daemon runs in the owner's tz). */
function localDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Assemble a project's rolling status context from its most-recent moments.
 * Returns null when the project id is unknown or has no tracked moments — the
 * caller skips writing a status in that case (nothing to summarize). Reuses the
 * daily context's `viewMoment`/`buildPhaseMix`/`buildFocus` so a project's
 * phase/focus math is identical to the day view's, just over a different slice.
 */
export async function buildProjectStatusContext(
  projectId: string,
  options?: BuildProjectStatusContextOptions,
): Promise<ProjectStatusContext | null> {
  const aliases = options?.projectAliases ?? {};
  const maxMoments = options?.maxMoments ?? 400;
  const maxRecent = options?.maxRecent ?? 14;

  const [rows, allProjects] = await Promise.all([getMomentsForProject(projectId, maxMoments), getAllProjects()]);
  if (rows.length === 0) return null;

  const project = allProjects.find((p) => p.id === projectId);
  const rawName = project?.name || (projectId.startsWith('named:') ? projectId.slice('named:'.length) : (projectId.split('/').pop() ?? projectId));
  const name = canonicalProjectName(rawName, aliases);

  // `getMomentsForProject` is newest-first; work chronological for spans/momentum.
  const views: MomentView[] = rows.map(viewMoment).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  const totalMs = views.reduce((sum, v) => sum + v.durationMs, 0);
  const firstActivity = views[0]?.start ?? null;
  const lastActivity = views[views.length - 1]?.end ?? null;

  const commits = views.reduce((sum, v) => sum + v.gitCommitCount, 0);
  const branches: string[] = [];
  for (const v of views) if (v.gitBranch && !branches.includes(v.gitBranch)) branches.push(v.gitBranch);

  // Per-day tracked minutes.
  const perDay = new Map<string, number>();
  for (const v of views) {
    const day = localDate(v.start);
    perDay.set(day, (perDay.get(day) ?? 0) + v.durationMs);
  }
  const momentum: ProjectMomentumPoint[] = Array.from(perDay.entries())
    .map(([date, ms]) => ({ date, minutes: minutes(ms) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Most-recent narratives/intents, newest first.
  const recent: ProjectRecentEntry[] = [];
  for (const r of rows) {
    const v = viewMoment(r);
    const text = v.narrative ?? v.intent;
    if (!text) continue;
    recent.push({ date: localDate(v.start), text });
    if (recent.length >= maxRecent) break;
  }

  return {
    projectId,
    name,
    rootPath: project?.rootPath ?? '',
    org: project?.organizationId ?? null,
    span: { firstActivity, lastActivity, daysActive: perDay.size },
    totalTrackedMin: minutes(totalMs),
    momentCount: views.length,
    commits,
    branches,
    phaseMix: buildPhaseMix(views),
    focus: buildFocus(views),
    momentum,
    recent,
  };
}
