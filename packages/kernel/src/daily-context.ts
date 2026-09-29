import {
  getKnowledgeEntriesForDate,
  getMomentsForDate,
  getSignalsForDate,
  getAllProjects,
  type StoredMoment,
  type StoredSignal,
} from '@sundial/db/index.js';
import { localHour } from '@sundial/helpers/local-day.js';
import { canonicalProjectName } from '@sundial/helpers/sundial-config.js';
import type { FocusQuality, MomentKind } from './types.js';

// ─── Public shape ───────────────────────────────────────────────────────────

export interface DailyProjectSummary {
  name: string;
  minutes: number;
  momentCount: number;
  commits: number;
  branches: string[];
  confidence: 'certain' | 'weak' | null;
}

export interface DailyTimelineEntry {
  /** For `gnomon_moment_detail`: a summary that cannot be drilled into is a dead end. */
  id: string;
  start: string;
  end: string;
  durationMin: number;
  process: string;
  project: string | null;
  narrative: string | null;
  intent: string | null;
  titles: string[];
  /** Pages read in the browser during the moment, as host/path. */
  pages?: string[];
  lifeEvents: string[];
  notableCommands: string[];
  kind: MomentKind;
  focusScore: number;
  /** Minutes with real input, when the moment recorded any; null for a moment from before that was measured. */
  activeMin?: number | null;
  /**
   * Characters of speech ambient hearing captured during this moment, when it
   * captured any. Absent, never zero — a moment with no speech says nothing
   * about hearing, and a `0` would read as "the mic was on and heard silence".
   *
   * The COUNT, not the words. The words are the bulk this whole view exists to
   * leave behind, and they are one `gnomon_moment_detail` away. What the count
   * buys is the thing its absence cost on 2026-09-14: asked for a meeting
   * transcript, Gnomon read a day summary with no trace of speech in it and
   * answered that ambient hearing had recorded nothing and that the feature was
   * still unbuilt — while 57 moments of that same morning held 24,544
   * characters of the standup. A model cannot offer what the record never tells
   * it is there.
   */
  heardChars?: number;
}

export interface DailyMeeting {
  title: string;
  start: string;
  end: string;
  attendees: string[];
  micOn: boolean;
  camOn: boolean;
}

export interface DailyFlow {
  from: string;
  to: string;
  count: number;
}

export interface DailyDeepBlock {
  start: string;
  end: string;
  durationMin: number;
  project: string | null;
}

export interface DailyBreak {
  start: string;
  end: string;
  durationMin: number;
  kind: 'overnight' | 'lunch' | 'micro' | 'other';
  adjacentApp: string | null;
}

export interface DailyEnergyPoint {
  hour: number;
  score: number;
}

export interface DailySearch {
  query: string;
  ts: string;
}

export interface DailyAnomaly {
  severity: string | null;
  title: string;
  body: string;
}

export interface DailyContinuity {
  project: string;
  carriedFrom: string;
}

export interface DailyRedactions {
  total: number;
  byProperty: Record<string, number>;
}

export interface DailyContext {
  date: string;
  /**
   * The zone this day was sliced in, carried so the prompt can NAME it.
   *
   * The journal's tools return raw UTC ISO timestamps, and a model reading
   * `2026-08-01T19:53:00.000Z` writes "at 19:53 UTC" — which it did, in a journal
   * addressed to someone who was sitting at the machine at 21:53 local. The
   * serializer states the zone and instructs the conversion; it cannot do that
   * without knowing which zone the day was built in.
   */
  timeZone: string;
  coverage: { trackedMin: number; wallClockMin: number; firstActivity: string | null; lastActivity: string | null };
  projects: DailyProjectSummary[];
  noProjectMin: number;
  phaseMix: Record<MomentKind, number>;
  focus: { deepMin: number; steadyMin: number; shallowMin: number };
  timeline: DailyTimelineEntry[];
  meetings: DailyMeeting[];
  searches: DailySearch[];
  flows: DailyFlow[];
  deepWorkBlocks: DailyDeepBlock[];
  energyCurve: DailyEnergyPoint[];
  breaks: DailyBreak[];
  anomalies: DailyAnomaly[];
  continuity: DailyContinuity[];
  redactions: DailyRedactions;
}

export interface BuildDailyContextOptions {
  projectAliases?: Record<string, string>;
  /**
   * The owner's IANA zone, deciding where this day starts and ends.
   *
   * Defaults to `'UTC'`, which is what every one of these queries silently used
   * before — and in Amsterdam that put the boundary at 02:00, so the first two
   * hours of each morning were filed under the previous date. That skewed the
   * overnight break taxonomy in particular, since the sleep/wake crossings it
   * reads are precisely the events in those hours.
   *
   * Passed to all five date-scoped queries below rather than some of them: a
   * context whose moments run on a local day and whose signals run on a UTC day
   * describes two different days at once.
   */
  timeZone?: string;
  /** Cap on the timeline entries / flows / searches serialized. Tokens are ~free (self-hosted), so this is generous. */
  maxTimeline?: number;
  maxFlows?: number;
  maxSearches?: number;
}

// ─── Tunables ────────────────────────────────────────────────────────────────

const DEEP_FOCUS = 0.7;
const DEEP_BLOCK_MIN = 25; // a run of high-focus contiguous time ≥ this is a deep-work block
const DEEP_BLOCK_GAP_MS = 5 * 60_000; // moments within this gap count as contiguous
const MIN_BREAK_MS = 5 * 60_000;
const LUNCH_MIN = 30;
const LUNCH_MAX = 120;
const OVERNIGHT_MIN_MIN = 180;
const TYPING_NORM_PER_MIN = 60; // typing events/min mapped to full engagement

// ─── Typed view over a StoredMoment's JSON data blob ─────────────────────────

export interface MomentView {
  /** The `moments` row id, so a caller can hand it to `gnomon_moment_detail`. */
  id: string;
  start: string;
  end: string;
  durationMs: number;
  process: string;
  projectId: string | null;
  kind: MomentKind;
  focusScore: number;
  focusQuality: FocusQuality;
  narrative: string | null;
  intent: string | null;
  titles: string[];
  pages: string[];
  lifeEvents: string[];
  notableCommands: string[];
  gitCommitCount: number;
  gitBranch: string | null;
  typingEventCount: number;
  micActive: boolean;
  cameraActive: boolean;
  calendarActive: boolean;
  meetingTitle: string | null;
  meetingAttendees: string[];
  projectConfidence: 'certain' | 'weak' | null;
  /** ms with real input, or null when the moment predates `activeMs`. */
  activeMs: number | null;
  /** The tail of what ambient hearing caught during the moment, or null when it caught nothing. */
  spokenExcerpt: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function bool(v: unknown): boolean {
  return v === true;
}

const KINDS: MomentKind[] = ['setup', 'focus', 'meeting', 'switch', 'browse'];
function asKind(v: unknown): MomentKind {
  return typeof v === 'string' && (KINDS as string[]).includes(v) ? (v as MomentKind) : 'setup';
}
function asQuality(v: unknown): FocusQuality {
  return v === 'deep' || v === 'steady' || v === 'shallow' ? v : 'shallow';
}

/** Defensive projection of a StoredMoment onto the fields the daily needs — tolerant of pre-P2 rows missing focus/meeting fields. Exported so the project-status context (a different time-slice over the same rows) reuses the exact same view. */
export function viewMoment(m: StoredMoment): MomentView {
  const d = m.data;
  const intentObj = d.intent as { text?: unknown } | undefined;
  return {
    id: m.id,
    start: m.startTime,
    end: m.endTime,
    durationMs: m.durationMs,
    process: m.processName,
    projectId: m.projectId,
    kind: asKind(d.kind),
    focusScore: num(d.focusScore),
    focusQuality: asQuality(d.focusQuality),
    narrative: str(d.narrative),
    intent: str(intentObj?.text),
    titles: strArr(d.windowTitles),
    pages: strArr(d.pages),
    lifeEvents: strArr(d.lifeEvents),
    notableCommands: strArr(d.notableCommands),
    gitCommitCount: num(d.gitCommitCount),
    gitBranch: str(d.gitBranch),
    typingEventCount: num(d.typingEventCount),
    micActive: bool(d.micActive),
    cameraActive: bool(d.cameraActive),
    calendarActive: bool(d.calendarActive),
    meetingTitle: str(d.meetingTitle),
    meetingAttendees: strArr(d.meetingAttendees),
    projectConfidence: d.projectConfidence === 'certain' || d.projectConfidence === 'weak' ? d.projectConfidence : null,
    activeMs: typeof d.activeMs === 'number' && (num(d.inputEventCount) > 0 || d.activeMs > 0) ? d.activeMs : null,
    spokenExcerpt: str(d.spokenExcerpt),
  };
}

export function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

function isRealMeeting(v: MomentView): boolean {
  return v.calendarActive && (v.meetingAttendees.length > 0 || v.micActive || v.cameraActive);
}

/** A display name for a projectId (path, `named:<canonical>`, or null), canonicalized for grouping. */
function projectDisplayName(projectId: string | null, projectNames: Map<string, string>, aliases: Record<string, string>): string | null {
  if (!projectId) return null;
  const raw = projectNames.get(projectId) ?? (projectId.startsWith('named:') ? projectId.slice('named:'.length) : (projectId.split('/').pop() ?? projectId));
  return canonicalProjectName(raw, aliases);
}

// ─── Section builders ────────────────────────────────────────────────────────

function buildProjects(views: MomentView[], projectNames: Map<string, string>, aliases: Record<string, string>): { projects: DailyProjectSummary[]; noProjectMin: number } {
  const groups = new Map<string, DailyProjectSummary>();
  let noProjectMs = 0;
  for (const v of views) {
    const name = projectDisplayName(v.projectId, projectNames, aliases);
    if (!name) {
      noProjectMs += v.durationMs;
      continue;
    }
    const g = groups.get(name) ?? { name, minutes: 0, momentCount: 0, commits: 0, branches: [], confidence: null };
    g.minutes += minutes(v.durationMs);
    g.momentCount += 1;
    g.commits += v.gitCommitCount;
    if (v.gitBranch && !g.branches.includes(v.gitBranch)) g.branches.push(v.gitBranch);
    if (v.projectConfidence === 'certain' || (v.projectConfidence === 'weak' && g.confidence === null)) g.confidence = v.projectConfidence;
    groups.set(name, g);
  }
  const projects = Array.from(groups.values()).sort((a, b) => b.minutes - a.minutes);
  return { projects, noProjectMin: minutes(noProjectMs) };
}

export function buildPhaseMix(views: MomentView[]): Record<MomentKind, number> {
  const mix: Record<MomentKind, number> = { setup: 0, focus: 0, meeting: 0, switch: 0, browse: 0, leisure: 0 };
  for (const v of views) mix[v.kind] += minutes(v.durationMs);
  return mix;
}

export function buildFocus(views: MomentView[]): { deepMin: number; steadyMin: number; shallowMin: number } {
  const f = { deepMin: 0, steadyMin: 0, shallowMin: 0 };
  for (const v of views) {
    const m = minutes(v.durationMs);
    if (v.focusQuality === 'deep') f.deepMin += m;
    else if (v.focusQuality === 'steady') f.steadyMin += m;
    else f.shallowMin += m;
  }
  return f;
}

function buildFlows(views: MomentView[], max: number): DailyFlow[] {
  const counts = new Map<string, number>();
  for (let i = 0; i < views.length - 1; i++) {
    const from = views[i].process;
    const to = views[i + 1].process;
    if (from === to) continue;
    const key = `${from}\u0000${to}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => {
      const [from, to] = key.split('\u0000');
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, max);
}

function buildDeepWorkBlocks(views: MomentView[], projectNames: Map<string, string>, aliases: Record<string, string>): DailyDeepBlock[] {
  const blocks: DailyDeepBlock[] = [];
  let runStart: MomentView | null = null;
  let runEnd: MomentView | null = null;

  const flush = () => {
    if (runStart && runEnd) {
      const span = Date.parse(runEnd.end) - Date.parse(runStart.start);
      if (span >= DEEP_BLOCK_MIN * 60_000) {
        blocks.push({ start: runStart.start, end: runEnd.end, durationMin: minutes(span), project: projectDisplayName(runStart.projectId, projectNames, aliases) });
      }
    }
    runStart = null;
    runEnd = null;
  };

  for (const v of views) {
    const isDeep = v.focusScore >= DEEP_FOCUS;
    if (!isDeep) {
      flush();
      continue;
    }
    if (runEnd && Date.parse(v.start) - Date.parse(runEnd.end) > DEEP_BLOCK_GAP_MS) flush();
    if (!runStart) runStart = v;
    runEnd = v;
  }
  flush();
  return blocks;
}

/**
 * The hourly energy curve, as a MINUTE-weighted mean rather than a per-moment one.
 *
 * The mean used to be over the moment COUNT, which asks "how focused was the
 * average window I happened to open" — and on this owner's record an hour holds
 * twenty to fifty moments, most of them a few seconds of Finder or a browser
 * tab. One forty-minute block and thirty flicks averaged to the flicks, so an
 * hour of real work reported as an unfocused one. Weighting by the minutes each
 * moment actually lasted asks the question the curve is drawn to answer: how
 * focused was that HOUR. Measured on three live days it lifts the peaks by
 * roughly a fifth (a 27 hour becomes 33) and leaves the quiet hours where they
 * were, which is the correction working in the direction it should.
 */
function buildEnergyCurve(views: MomentView[], timeZone: string): DailyEnergyPoint[] {
  const buckets = new Map<number, { focusMinutes: number; typingMinutes: number; minutes: number }>();
  for (const v of views) {
    const hour = localHour(v.start, timeZone);
    const mins = Math.max(1, v.durationMs / 60_000);
    const typingRate = Math.min(1, v.typingEventCount / mins / TYPING_NORM_PER_MIN);
    const b = buckets.get(hour) ?? { focusMinutes: 0, typingMinutes: 0, minutes: 0 };
    b.focusMinutes += v.focusScore * mins;
    b.typingMinutes += typingRate * mins;
    b.minutes += mins;
    buckets.set(hour, b);
  }
  return Array.from(buckets.entries())
    .map(([hour, b]) => ({ hour, score: Math.round(100 * (0.6 * (b.focusMinutes / b.minutes) + 0.4 * (b.typingMinutes / b.minutes))) }))
    .sort((a, b) => a.hour - b.hour);
}

function buildMeetings(views: MomentView[]): DailyMeeting[] {
  const byTitle = new Map<string, DailyMeeting>();
  for (const v of views) {
    if (!isRealMeeting(v)) continue;
    const title = v.meetingTitle ?? '(untitled meeting)';
    const m = byTitle.get(title) ?? { title, start: v.start, end: v.end, attendees: [], micOn: false, camOn: false };
    if (Date.parse(v.start) < Date.parse(m.start)) m.start = v.start;
    if (Date.parse(v.end) > Date.parse(m.end)) m.end = v.end;
    for (const a of v.meetingAttendees) if (!m.attendees.includes(a)) m.attendees.push(a);
    m.micOn = m.micOn || v.micActive;
    m.camOn = m.camOn || v.cameraActive;
    byTitle.set(title, m);
  }
  return Array.from(byTitle.values()).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

function buildBreaks(views: MomentView[], sleepWakeAt: number[]): DailyBreak[] {
  const breaks: DailyBreak[] = [];
  for (let i = 0; i < views.length - 1; i++) {
    const gapStart = Date.parse(views[i].end);
    const gapEnd = Date.parse(views[i + 1].start);
    const gapMs = gapEnd - gapStart;
    if (gapMs < MIN_BREAK_MS) continue;
    const gapMin = minutes(gapMs);
    const crossesSleep = sleepWakeAt.some((t) => t >= gapStart && t <= gapEnd);
    let kind: DailyBreak['kind'];
    if (crossesSleep || gapMin >= OVERNIGHT_MIN_MIN) kind = 'overnight';
    else if (gapMin >= LUNCH_MIN && gapMin <= LUNCH_MAX) kind = 'lunch';
    else if (gapMin < LUNCH_MIN) kind = 'micro';
    else kind = 'other';
    breaks.push({ start: views[i].end, end: views[i + 1].start, durationMin: gapMin, kind, adjacentApp: views[i + 1].process });
  }
  return breaks;
}

function buildRedactions(privacySignals: StoredSignal[]): DailyRedactions {
  const byProperty: Record<string, number> = {};
  let total = 0;
  for (const s of privacySignals) {
    const props = s.data.properties;
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      for (const [key, count] of Object.entries(props as Record<string, unknown>)) {
        const n = num(count);
        byProperty[key] = (byProperty[key] ?? 0) + n;
        total += n;
      }
    }
  }
  return { total, byProperty };
}

function buildSearches(searchSignals: StoredSignal[], max: number): DailySearch[] {
  const out: DailySearch[] = [];
  const seen = new Set<string>();
  for (const s of searchSignals) {
    const query = str(s.data.query);
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ query, ts: s.capturedAt });
    if (out.length >= max) break;
  }
  return out;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * P3 (docs/design/07) — the day-scoped context assembler the day-writer (P5)
 * consumes, the `buildWcsContext`-equivalent Gnomon never had. Pure over the DB
 * queries: everything but verbatim search text and overnight-break tagging is
 * derived from the day's moments (flows from consecutive-moment process
 * transitions; deep-work blocks/energy/breaks/coverage/phase/project mix from
 * the P2-enriched `MomentRow.data`; meetings from the P2 meeting-truth fields).
 * Search text and sleep/wake crossings come from the day's signals. Continuity
 * is the set of projects also present yesterday.
 */
export async function buildDailyContext(date: string, options?: BuildDailyContextOptions): Promise<DailyContext> {
  const aliases = options?.projectAliases ?? {};
  const timeZone = options?.timeZone ?? 'UTC';
  const maxTimeline = options?.maxTimeline ?? 200;
  const maxFlows = options?.maxFlows ?? 15;
  const maxSearches = options?.maxSearches ?? 40;

  const yesterday = new Date(Date.parse(`${date}T00:00:00.000Z`) - 24 * 60 * 60_000).toISOString().slice(0, 10);

  const [moments, searchSignals, systemSignals, privacySignals, todaysKnowledge, yesterdaysMoments, allProjects] = await Promise.all([
    getMomentsForDate(date, timeZone),
    getSignalsForDate(date, 'search', timeZone),
    getSignalsForDate(date, 'system', timeZone),
    getSignalsForDate(date, 'privacy', timeZone),
    getKnowledgeEntriesForDate(date, timeZone),
    getMomentsForDate(yesterday, timeZone),
    getAllProjects(),
  ]);

  const projectNames = new Map(allProjects.map((p) => [p.id, p.name]));
  const views = moments.map(viewMoment);

  const trackedMs = views.reduce((sum, v) => sum + v.durationMs, 0);
  const firstActivity = views.length > 0 ? views[0].start : null;
  const lastActivity = views.length > 0 ? views[views.length - 1].end : null;
  const wallClockMs = firstActivity && lastActivity ? Date.parse(lastActivity) - Date.parse(firstActivity) : 0;

  const { projects, noProjectMin } = buildProjects(views, projectNames, aliases);

  const timeline: DailyTimelineEntry[] = views.slice(0, maxTimeline).map((v) => ({
    id: v.id,
    start: v.start,
    end: v.end,
    durationMin: minutes(v.durationMs),
    process: v.process,
    project: projectDisplayName(v.projectId, projectNames, aliases),
    narrative: v.narrative,
    intent: v.intent,
    titles: v.titles.slice(0, 5),
    pages: v.pages.slice(0, 5),
    lifeEvents: v.lifeEvents,
    notableCommands: v.notableCommands,
    kind: v.kind,
    focusScore: v.focusScore,
    activeMin: v.activeMs !== null ? minutes(v.activeMs) : null,
    // Omitted rather than zeroed: see `heardChars`. A moment that heard nothing
    // carries no key at all, so the field's presence IS the signal.
    ...(v.spokenExcerpt !== null ? { heardChars: v.spokenExcerpt.length } : {}),
  }));

  const sleepWakeAt = systemSignals
    .filter((s) => s.eventType === 'sleep-wake')
    .map((s) => Date.parse(s.capturedAt))
    .filter((t) => Number.isFinite(t));

  const anomalies: DailyAnomaly[] = todaysKnowledge
    .filter((k) => k.kind === 'companion-insight')
    .map((k) => ({ severity: k.severity, title: k.title, body: k.body }));

  const todaysProjectNames = new Set(projects.map((p) => p.name));
  const yesterdaysProjectNames = new Set(
    yesterdaysMoments
      .map((m) => projectDisplayName(m.projectId, projectNames, aliases))
      .filter((n): n is string => n !== null),
  );
  const continuity: DailyContinuity[] = Array.from(todaysProjectNames)
    .filter((name) => yesterdaysProjectNames.has(name))
    .map((name) => ({ project: name, carriedFrom: yesterday }));

  return {
    date,
    timeZone,
    coverage: { trackedMin: minutes(trackedMs), wallClockMin: minutes(wallClockMs), firstActivity, lastActivity },
    projects,
    noProjectMin,
    phaseMix: buildPhaseMix(views),
    focus: buildFocus(views),
    timeline,
    meetings: buildMeetings(views),
    searches: buildSearches(searchSignals, maxSearches),
    flows: buildFlows(views, maxFlows),
    deepWorkBlocks: buildDeepWorkBlocks(views, projectNames, aliases),
    energyCurve: buildEnergyCurve(views, timeZone),
    breaks: buildBreaks(views, sleepWakeAt),
    anomalies,
    continuity,
    redactions: buildRedactions(privacySignals),
  };
}
