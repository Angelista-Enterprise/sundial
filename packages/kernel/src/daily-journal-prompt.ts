import type {
  DailyContext,
  DailyMeeting,
  DailyTimelineEntry,
} from './daily-context.js';
import { NO_DIAGNOSIS, withPersona } from './persona.js';
import type { ChatMessage, MomentKind } from './types.js';

// ─── Result shape ────────────────────────────────────────────────────────────

export interface JournalResult {
  tldr: string;
  narrative: string;
  noticed: string[];
  followups: string[];
}

// ─── Length budget ────────────────────────────────────────────────────────────
//
// The Today card (`apps/macos-ui`'s `TodayJournalColumn`) reserves a fixed
// reading measure rather than growing to fit whatever prose arrives — a
// journal that ran long used to spill past the fold of a card the design
// treats as fixed-height. Enforced twice: as the soft target below (and in
// `project-status-prompt.ts`, which shares this budget and this parser), and
// as a hard clamp in `parseJournalResult`, so a reply that ignores the budget
// — or one written before this budget existed — still renders inside the
// card instead of relying on the model's compliance.
export const JOURNAL_TLDR_MAX_CHARS = 160;
export const JOURNAL_NARRATIVE_TARGET_CHARS = 700;
export const JOURNAL_NARRATIVE_MAX_CHARS = 900;
/**
 * Raised from 220 once the journal started saying something.
 *
 * A vague item fits in 220 characters easily; a grounded one — naming a branch,
 * a file count and what it implies — does not, and the clamp was cutting three
 * of four `noticed` items mid-sentence ("a separate repo within the…"). A
 * truncated observation is worse than a shorter one, because the reader cannot
 * tell whether the point was ever made.
 */
export const JOURNAL_LIST_ITEM_MAX_CHARS = 320;
export const JOURNAL_LIST_MAX_ITEMS = 4;

/**
 * The journal reads EVIDENCE and calls tools for what it does not have.
 *
 * `almanac/issues/journal-summarises-model-output-not-evidence` measured the old
 * version of this call: 90,550 characters of prompt, 95.8% timeline, and 88.3%
 * of that timeline was `intent`/`narrative` text a previous call had written
 * about each moment. The journal was a summary of sentences rather than of a
 * day, which meant it could not correct an upstream misreading and compounded
 * whatever the first stage got wrong — while being the single most expensive
 * thing Gnomon does.
 *
 * Measured on this corpus before the change: a 54,728-character prompt for
 * 2026-08-01 produced a journal naming ZERO of the 39 files edited that day,
 * ZERO of the 80 symbols, and ZERO of the 20 commits. Every specific thing the
 * owner actually did was absent, because none of it was ever in the prompt —
 * `symbol:edited` and `git:commit` had no path into it at all.
 *
 * Two changes fix that together. The timeline no longer carries `narrative` (a
 * past-tense restatement of `intent` from the same call — 13,380 characters of
 * pure duplication on that day), and the call now runs through the tool loop, so
 * the model fetches commits, file edits and commands itself instead of being
 * handed a paraphrase of them. `intent` stays: one short clause per row is what
 * makes the timeline navigable enough to know which hour is worth opening.
 */
const SYSTEM_PROMPT = withPersona(
  [
  "Today you are writing the owner's daily work journal.",
  "Write in their own retrospective voice — past tense, natural prose, first person implied (never \"the user\").",
  'This is read in a small, fixed-height card, not a page — brevity is part of the brief, not a fallback for a thin day.',
  '',
  NO_DIAGNOSIS,
  '',
  'HOW TO WORK. The activity log below is the SHAPE of the day — coverage, projects, meetings, and a timeline of moments. It is not the detail. Before writing, call tools to find out what actually happened:',
  '- `gnomon_code_activity` for the files edited, the functions touched inside them, and the commit subjects. Call this first on any day with coding in it.',
  '- `gnomon_signals` for shell commands, window titles, and calendar events when the timeline is vague about a block.',
  '- `gnomon_moment_detail` to open a specific moment that looks pivotal.',
  'A journal that names a real file, a real commit, or a real command is worth reading. One that says "worked on the project for a few hours" is not, and you have the tools to do better.',
  '',
  'The `[bracketed]` text on a timeline row is an earlier model\'s guess about that moment, not an observation. Use it to decide where to look; never repeat it as fact, and prefer what the tools return whenever the two disagree.',
  '',
  'When you have what you need, respond with STRICT JSON only, no markdown fencing, matching exactly:',
  '{"tldr":"...","narrative":"...","noticed":["..."],"followups":["..."]}',
  `- "tldr": ONE sentence naming the SHAPE of the day (deep-coding, meeting-heavy, scattered, setup-heavy) and the primary project(s). Under ${JOURNAL_TLDR_MAX_CHARS} characters.`,
  `- "narrative": 2-3 SHORT paragraphs (use \\n\\n between them), about ${JOURNAL_NARRATIVE_TARGET_CHARS} characters total — every sentence has to earn its place. Name specific files, commits, commands, search queries, ticket IDs and meeting names VERBATIM where they carry signal. Never write "logged" or "session N". If a project is (no project) or nothing is known about a block, write around it — do not invent motivation.`,
  '  COVERAGE: walk the day start to end, but compress a long, low-detail block into one clause rather than a sentence (e.g. "then 90 minutes back in Warp on gnomon with little else logged") — do not silently drop it, but do not dwell on it either.',
  '  DISTINCTNESS: never merge two differently-named projects, repos, or tasks into one sentence or follow-up just because they happened close together in time — keep each attributed to its own line/timestamp.',
  `- "noticed": 2-4 non-obvious cross-signal observations, each grounded in a specific number, timestamp, file, or event name, each ONE sentence under ${JOURNAL_LIST_ITEM_MAX_CHARS} characters — say the whole thought or pick a smaller one, never trail off. Empty array if none are well-supported.`,
  `- "followups": concrete open loops only — ticket IDs, a dirty branch, an unmerged PR, a file left mid-edit. One short line per distinct piece of work. Empty array if none.`,
  ].join('\n'),
);

// ─── Serialization of DailyContext → the user message ────────────────────────

/** HH:MM in the host's local tz (the daemon runs in the owner's tz). */
function clock(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** System chrome that never belongs in the narrative timeline. */
const CHROME = new Set(['loginwindow', 'WindowManager', 'Spotlight', 'Finder', 'ScreenSaverEngine']);

/** Merge sub-2-min fragments and drop chrome, so a 150-moment day stays a readable prompt. */
function condenseTimeline(timeline: DailyTimelineEntry[]): DailyTimelineEntry[] {
  return timeline.filter((t) => !CHROME.has(t.process) && (t.durationMin >= 2 || t.narrative || t.intent));
}

function timelineLine(t: DailyTimelineEntry): string {
  // `12m/40m` reads as "12 minutes at the keyboard of 40 open": presence is not attention.
  const parts = [`${clock(t.start)}-${clock(t.end)}`, `${t.process}${t.project ? ` · ${t.project}` : ''}`, `${t.kind}/${typeof t.activeMin === 'number' && t.activeMin !== t.durationMin ? `${t.activeMin}m/${t.durationMin}m` : `${t.durationMin}m`}`];
  if (t.intent) parts.push(`[${t.intent}]`);
  // `narrative` is deliberately NOT serialized. It is the same observation as
  // `intent` in the past tense, produced by the same call — 13,380 characters of
  // restatement on a single measured day, for no information the row does not
  // already carry. It still exists on the moment (the Recorded list and
  // `gnomon summary` read it); it just no longer inflates this prompt.
  const tail: string[] = [];
  if (t.titles.length) tail.push(`titles: ${t.titles.join(' | ')}`);
  if (t.pages?.length) tail.push(`pages: ${t.pages.join(' | ')}`);
  if (t.notableCommands.length) tail.push(`cmds: ${t.notableCommands.join('; ')}`);
  const events = t.lifeEvents.filter((e) => e.startsWith('event:') || e.startsWith('media:'));
  if (events.length) tail.push(events.join(','));
  return `- ${parts.join(' · ')}${tail.length ? ` (${tail.join(' — ')})` : ''}`;
}

function meetingLine(m: DailyMeeting): string {
  const av = [m.micOn ? 'mic' : null, m.camOn ? 'cam' : null].filter(Boolean).join('+');
  return `- "${m.title}" ${clock(m.start)}-${clock(m.end)}${m.attendees.length ? ` [${m.attendees.join(', ')}]` : ''}${av ? ` (${av})` : ''}`;
}

function phaseMixLine(phaseMix: Record<MomentKind, number>): string {
  return (Object.entries(phaseMix) as [MomentKind, number][])
    .filter(([, min]) => min > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, min]) => `${k} ${min}m`)
    .join(', ');
}

/** Serialize a DailyContext into the plain-text activity log the model reads. Public for testing. */
export function serializeDailyContext(ctx: DailyContext): string {
  const lines: string[] = [];
  lines.push(`DATE: ${ctx.date}. All clock times below are ${ctx.timeZone} local.`);
  // Stated because the TOOLS do not honour it. They return raw UTC ISO
  // timestamps, and a model that reads `2026-08-01T19:53:00.000Z` writes "at
  // 19:53 UTC" — which it did, in a journal for someone who was at the machine
  // at 21:53. The owner does not think in UTC and should never be shown it.
  lines.push(`TIME: tool results return UTC ISO timestamps. Convert them to ${ctx.timeZone} before quoting any time, and never write "UTC" in the journal.`);
  lines.push(`COVERAGE: ${ctx.coverage.trackedMin} tracked min over ${ctx.coverage.wallClockMin} wall-clock min${ctx.coverage.firstActivity ? ` (${clock(ctx.coverage.firstActivity)}–${clock(ctx.coverage.lastActivity!)})` : ''}`);

  if (ctx.projects.length) {
    lines.push(
      `PROJECTS: ${ctx.projects.map((p) => `${p.name} ${p.minutes}m${p.commits ? `, ${p.commits} commit${p.commits === 1 ? '' : 's'}` : ''}${p.branches.length ? `, branch ${p.branches.join('/')}` : ''} (${p.confidence ?? 'unknown'})`).join('; ')}${ctx.noProjectMin ? `; (no project) ${ctx.noProjectMin}m` : ''}`,
    );
  } else if (ctx.noProjectMin) {
    lines.push(`PROJECTS: (no project) ${ctx.noProjectMin}m`);
  }

  const phaseMix = phaseMixLine(ctx.phaseMix);
  if (phaseMix) lines.push(`PHASE MIX: ${phaseMix}`);
  lines.push(`FOCUS: deep ${ctx.focus.deepMin}m, steady ${ctx.focus.steadyMin}m, shallow ${ctx.focus.shallowMin}m`);
  if (ctx.deepWorkBlocks.length) lines.push(`DEEP-WORK BLOCKS: ${ctx.deepWorkBlocks.map((b) => `${clock(b.start)}-${clock(b.end)} (${b.durationMin}m${b.project ? `, ${b.project}` : ''})`).join('; ')}`);

  if (ctx.meetings.length) {
    lines.push('MEETINGS:');
    lines.push(...ctx.meetings.map(meetingLine));
  }
  if (ctx.searches.length) lines.push(`SEARCHES: ${ctx.searches.map((s) => `"${s.query}"`).join(', ')}`);
  if (ctx.flows.length) lines.push(`FLOWS: ${ctx.flows.map((f) => `${f.from}→${f.to} ×${f.count}`).join(', ')}`);
  if (ctx.energyCurve.length) lines.push(`ENERGY (hourly): ${ctx.energyCurve.map((e) => `${e.hour}h:${e.score}`).join(' ')}`);
  if (ctx.breaks.length) lines.push(`BREAKS: ${ctx.breaks.map((b) => `${clock(b.start)}-${clock(b.end)} ${b.kind} (${b.durationMin}m→${b.adjacentApp ?? '?'})`).join('; ')}`);
  if (ctx.anomalies.length) {
    lines.push('ANOMALIES:');
    lines.push(...ctx.anomalies.map((a) => `- ${a.title}: ${a.body}`));
  }
  if (ctx.continuity.length) lines.push(`CONTINUITY: ${ctx.continuity.map((c) => `${c.project} (from ${c.carriedFrom})`).join(', ')}`);

  const timeline = condenseTimeline(ctx.timeline);
  if (timeline.length) {
    lines.push('TIMELINE:');
    lines.push(...timeline.map(timelineLine));
  }
  return lines.join('\n');
}

export function buildJournalMessages(ctx: DailyContext): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: serializeDailyContext(ctx) },
  ];
}

// ─── Parsing the model's reply ────────────────────────────────────────────────

function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
}

/**
 * Truncates at the last sentence boundary at or before `max`, so a clamp
 * lands as a full stop rather than mid-word. Falls back to the last word
 * boundary (and an ellipsis) when no sentence end falls late enough in the
 * text to leave a reasonable fragment — the `max * 0.4` floor keeps a stray
 * early period from truncating a long paragraph down to one clause.
 */
function clampProse(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (lastSentenceEnd > max * 0.4) return cut.slice(0, lastSentenceEnd + 1).trimEnd();
  // Reserve one character for the ellipsis so the result never exceeds `max`.
  const shortened = cut.slice(0, max - 1);
  const lastSpace = shortened.lastIndexOf(' ');
  return `${(lastSpace > 0 ? shortened.slice(0, lastSpace) : shortened).trimEnd()}…`;
}

/** `clampProse` over a list, also capping the item count — same rule `daily-journal-prompt` and `project-status-prompt` both ask the model for ("2-4 items"), enforced rather than trusted. */
function clampList(items: string[], maxItems: number, maxCharsPerItem: number): string[] {
  return items.slice(0, maxItems).map((item) => clampProse(item, maxCharsPerItem));
}

/**
 * Defensive parse of the strict-JSON journal reply. Returns null on anything
 * malformed or missing the two required prose fields. Every prose field is
 * also clamped to the length budget above — a model that ignores the
 * prompt's soft target (or an entry written before the budget existed) still
 * comes out fitting the Today/project-status card's fixed reading measure.
 */
export function parseJournalResult(text: string): JournalResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  const tldr = typeof o.tldr === 'string' ? o.tldr.trim() : '';
  const narrative = typeof o.narrative === 'string' ? o.narrative.trim() : '';
  if (!tldr || !narrative) return null;
  return {
    tldr: clampProse(tldr, JOURNAL_TLDR_MAX_CHARS),
    narrative: clampProse(narrative, JOURNAL_NARRATIVE_MAX_CHARS),
    noticed: clampList(strArr(o.noticed), JOURNAL_LIST_MAX_ITEMS, JOURNAL_LIST_ITEM_MAX_CHARS),
    followups: clampList(strArr(o.followups), JOURNAL_LIST_MAX_ITEMS, JOURNAL_LIST_ITEM_MAX_CHARS),
  };
}

/** Assemble the markdown body persisted in the `daily` knowledge entry's `body`. */
export function assembleJournalMarkdown(result: JournalResult): string {
  const parts = [result.narrative];
  if (result.noticed.length) parts.push(['## What you probably didn’t notice', ...result.noticed.map((n) => `- ${n}`)].join('\n'));
  if (result.followups.length) parts.push(['## Follow-ups', ...result.followups.map((f) => `- [ ] ${f}`)].join('\n'));
  return parts.join('\n\n');
}
