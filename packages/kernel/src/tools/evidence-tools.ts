import { z } from 'zod';
import { countSignalsInRange, getCodeActivityForDate, getSignalsInRange } from '@sundial/db/index.js';
import { localDate, localDayRange } from '@sundial/helpers/local-day.js';
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js';
import type { GnomonTool } from './registry.js';

function ownerTimeZone(): string {
  return loadSundialConfig().timezone;
}

function today(now: Date): string {
  return localDate(now.toISOString(), ownerTimeZone());
}

/**
 * How much of one long string field survives in a signal row.
 *
 * A `screen:ocr` payload carries `screenText`: 7,095 of the largest row's 7,173
 * characters is that one field. Twenty rows of it made `gnomon_recent_activity`
 * 15,003 characters and a day of them made `gnomon_signals` 46,318 — spent on a
 * verbatim screen dump the model did not ask for, when the same payload already
 * carries `topics` and `lineCount` as its digest.
 */
const MAX_SIGNAL_FIELD_CHARS = 200;
/**
 * The kinds whose whole point is their text — what was said, what was on
 * screen, what a page read. Asked for by name, their text is kept long enough
 * to quote: at 200 characters "what did Alex say in standup" got the first
 * clause of each utterance. Never in the default set, where they would crowd
 * out every other kind of evidence on a day.
 */
const TEXT_SIGNAL_TYPES = new Set(['audio', 'screen', 'page', 'agent:turn']);
const TEXT_FIELD_CHARS = 1200;

/**
 * The per-result budget a tool should keep its own list inside.
 *
 * `renderResultText` (plugins/sundial-tools/render.js) caps a rendered result at
 * 12,000 bytes, and how it caps depends on the SHAPE: an array is halved into
 * `{ truncated, rows }` — still valid, still useful — while an OBJECT is
 * replaced by a 60%-length preview STRING, which is not a smaller answer but a
 * broken one. Both `gnomon_today_summary` and `gnomon_signals` return objects,
 * so both were hitting that path: measured on the live record, 13,324 and
 * 49,328 bytes, and the model said so out loud ("the session timeline came back
 * size-truncated").
 *
 * A tool that bounds its own list never reaches the object path. The margin
 * leaves room for the wrapper fields around the list.
 */
// ponytail: halved 2026-09-12 — on the board the model has the card beside it; the audit
// showed four tools filling 8k every call and being re-called with narrower filters.
export const RESULT_BUDGET_CHARS = 6_000;

/**
 * As many items as fit in `budget`, and how many were left out.
 *
 * The caller decides the ORDER, and that decision is the whole point: passing
 * items longest-first means a cap drops the least significant rather than
 * whatever happened to come last. `buildDailyContext`'s own chronological
 * 200-cap taught this — on 2026-09-09 it kept a morning of twenty-second flicks
 * and dropped 29 of the day's 50 real sessions.
 */
export function takeWithinBudget<T>(items: readonly T[], budget: number): { kept: T[]; omitted: number } {
  const kept: T[] = [];
  let used = 0;
  for (const item of items) {
    const size = JSON.stringify(item).length + 1;
    if (used + size > budget) break;
    kept.push(item);
    used += size;
  }
  return { kept, omitted: items.length - kept.length };
}

/**
 * How many rows a list tool returns when the caller does not say.
 *
 * Small on purpose, and only safe BECAUSE `total` and `nextOffset` ship beside
 * it. The old default was 100 with a 200 ceiling, and the live session log says
 * what a model does with a ceiling it cannot see past: it passed `limit: 200`
 * on 37 of 74 `gnomon_signals` calls — the maximum, every other time — and 70%
 * of those results came back cut anyway. Asking for everything is the rational
 * move when the alternative is guessing how much "everything" is. Once the
 * result states the true total, a small page is a cheap first look rather than
 * a gamble, and the second page is one call away.
 */
export const DEFAULT_PAGE_ROWS = 25;

/** One page of a list result, and enough for the model to decide whether it wants another. */
export interface ToolPage<T> {
  rows: T[];
  /** How many rows exist in all, not how many are in `rows`. */
  total: number;
  /** Where this page starts. */
  offset: number;
  /** Where the NEXT page starts. Absent when this page ends the list. */
  nextOffset?: number;
  /** Present only when rows were left out — says how to get them, in the words the model should act on. */
  note?: string;
}

/**
 * A page of a list, cut by whichever comes first: the caller's `limit`, or the
 * per-result character budget.
 *
 * The contract that matters is the one in `note`. What this replaced told the
 * model to "narrow with signalType, or a smaller limit and a later date" — an
 * instruction to ASK THE SAME QUESTION AGAIN with different filters, which
 * re-reads rows it already has and appends a second copy of them to a prompt
 * that keeps every earlier one. On the live session log 36% of cut results were
 * followed by the same tool being called again within three steps, and both
 * copies stayed in context for the rest of the turn.
 *
 * An offset is the cheap fix: page two is rows the model has NOT seen. The note
 * therefore names `nextOffset` and nothing else, so the obvious next move is
 * also the one that adds no duplicate.
 *
 * `total` is the other half, and it is what makes a small default page honest:
 * a model that can see it is reading 25 of 412 knows exactly what it is missing,
 * where a model that only knows it got 25 rows has to guess whether that was
 * the day or the cap.
 */
export function pageWithinBudget<T>(items: readonly T[], options: { offset?: number; limit?: number; budget: number }): ToolPage<T> {
  const total = items.length;
  // Clamped rather than rejected: an offset past the end is a natural way to
  // walk off a list that shrank between calls, and an empty final page is a
  // truthful answer to it.
  const offset = Math.max(0, Math.min(Math.floor(options.offset ?? 0), total));
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_PAGE_ROWS));
  const { kept } = takeWithinBudget(items.slice(offset, offset + limit), options.budget);
  const nextOffset = offset + kept.length;
  const remaining = total - nextOffset;
  return {
    rows: kept,
    total,
    offset,
    ...(remaining > 0 ? { nextOffset } : {}),
    ...(remaining > 0
      ? { note: `${remaining} more of ${total} rows not shown — call this tool again with offset: ${nextOffset} to read the next page. Do NOT re-run the same query with a different limit; that returns rows you already have.` }
      : {}),
  };
}

/**
 * A signal row with its long text capped, for the tools that return rows in
 * bulk.
 *
 * Capped by LENGTH rather than by field name on purpose: `screenText` is the
 * one that hurts today, and naming it here would mean the next sensor to log a
 * long string reintroduces the same problem in silence. Structure is untouched —
 * short fields, numbers and arrays pass through — so a caller reading
 * `topics`, `processName` or `lineCount` sees exactly what it saw before.
 *
 * `gnomon_moment_detail` and an explicit `signalType` query are how the full
 * text is still reachable; this is the shape of a LIST, not of a record.
 */
export function slimSignalData(data: Record<string, unknown>, cap = MAX_SIGNAL_FIELD_CHARS): Record<string, unknown> {
  let capped = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && value.length > cap) {
      out[key] = `${value.slice(0, cap)}…`;
      capped = true;
    } else {
      out[key] = value;
    }
  }
  // Said, so the model does not read a cut string as the whole of what was seen.
  if (capped) out.truncated = true;
  return out;
}


/**
 * Signal types that are evidence of the OWNER rather than of the daemon.
 *
 * `input:activity` emits a sample every ten seconds carrying `keyDownCount: 0`
 * when nobody is at the keyboard, and `clock:tick` fires by definition — so an
 * unfiltered "signals on this day" answers "was the daemon running", not "what
 * did I do", and it does so while consuming the entire row budget. The same
 * distinction the A01 aspiration probe had to make between uptime and
 * observation.
 *
 * `llm` and `privacy` are excluded for a different reason: they are Gnomon
 * describing its own internals, and feeding them back to a model answering a
 * question about the owner's day invites exactly the self-referential summary
 * recorded in `issues/journal-summarises-model-output-not-evidence` (since
 * retired from the almanac).
 */
export const OWNER_EVIDENCE_TYPES = [
  'window',
  'git',
  'shell',
  'file',
  'symbol',
  'agent',
  'clipboard',
  'calendar',
  'document',
  'search',
  // The assistant's OWN web activity (`web:fetch` / `web:search`, written by
  // the sundial-web-browser plugin). Kept distinct from `search`, which means
  // the OWNER searched — derived from their browser window titles. Both are
  // owner-relevant evidence, but conflating them would attribute the
  // assistant's research to the person.
  'web',
  'media',
  'event',
  'project',
  'system',
  'phone',
];

/**
 * The two tools that reach primary evidence — the ones semantic search
 * structurally cannot be.
 *
 * `scoredSearch` ranks rows in `memory_embeddings`, and raw signals are not an
 * embedding ref type (embedding several thousand `input:activity` ticks a day
 * is not retrieval, it is noise). So the file paths in `symbol:edited`, the
 * commit subjects in `git:commit`, and the commands in `shell:command` had no
 * path to a prompt at all — the record plainly contained the answer to "what
 * did I edit today" and no read path could produce it.
 *
 * The second reason is shape rather than reach. "Files edited today for gnomon"
 * is a filter-and-aggregate question — date range ∧ project ∧ group by file —
 * and a top-K cosine ranking has nowhere to put a WHERE clause. Even with every
 * signal embedded, similarity would return SOME edits and never THE edits.
 */
export const EVIDENCE_TOOLS: GnomonTool[] = [
  {
    name: 'gnomon_code_activity',
    description:
      'The file-level record of a day\'s coding: which files were edited (with the function names touched inside them and how many times each file was revisited), which commits landed with their subjects, which branches, and which projects were touched. This is primary evidence from the `symbol:edited`, `git:commit`, and `file:changed` sensors — use it for any question about files, functions, commits, or "what did I actually build", in preference to a moment narrative, which is a model\'s earlier guess about the same period. Returns one page of FILES, most-edited first: `fileCount` is how many the day holds in all, and when `nextOffset` is present, call again with it for the next page rather than re-running with a larger limit.',
    schema: {
      date: z.string().optional().describe('YYYY-MM-DD in the owner timezone, defaults to today'),
      projectRoot: z
        .string()
        .optional()
        .describe('Filter to one project. A bare name ("gnomon") or a full root ("~/Projects/acme/gnomon") both work. Omit to report every project the day touched.'),
      limit: z.number().int().positive().max(200).optional().describe(`How many FILES to return, most-edited first. Default ${DEFAULT_PAGE_ROWS}.`),
      offset: z.number().int().min(0).optional().describe('Where in the file list to start. Use the `nextOffset` from a previous call to read on; do not re-run with a bigger limit.'),
    },
    readOnly: true,
    handler: async ({ date, projectRoot, limit, offset }, env) => {
      const summary = await getCodeActivityForDate((date as string | undefined) ?? today(env.now), ownerTimeZone(), projectRoot as string | undefined);
      const { files, commits, ...head } = summary;
      // Files carry the bulk and are already sorted most-edited first, so a page
      // of them is the day's most significant work rather than its alphabetical
      // beginning. Commits are counted and budgeted separately: they are a
      // different list answering a different question, and sharing one offset
      // between them would make `nextOffset` mean two things at once.
      // Commits are measured FIRST, and the files are budgeted against what
      // that page actually costs — not against the whole commit list. Charging
      // files for commits that were themselves about to be cut left three of a
      // day's 54 files on a result that came in at 3,424 characters against a
      // 6,000 budget: half the allowance spent on nothing.
      const commitPage = pageWithinBudget(commits, { limit: DEFAULT_PAGE_ROWS, budget: Math.floor(RESULT_BUDGET_CHARS / 3) });
      const filePage = pageWithinBudget(files, {
        offset: offset as number | undefined,
        limit: limit as number | undefined,
        budget: Math.max(1_000, RESULT_BUDGET_CHARS - JSON.stringify(head).length - JSON.stringify(commitPage.rows).length),
      });
      return {
        ...head,
        files: filePage.rows,
        fileCount: filePage.total,
        ...(filePage.nextOffset !== undefined ? { nextOffset: filePage.nextOffset, note: filePage.note } : {}),
        commits: commitPage.rows,
        commitCount: commitPage.total,
        ...(commitPage.nextOffset !== undefined ? { commitsNote: `${commitPage.total - commitPage.rows.length} further commits not shown; narrow with projectRoot to see them.` } : {}),
      };
    },
  },
  {
    name: 'gnomon_signals',
    description:
      'Raw sensor events for one day, the lowest-level record there is — shell commands actually run, window titles actually focused, git status changes, clipboard and calendar activity, and, when asked for by type, what was SAID near the machine (audio: spokenText and language, English and Dutch), what was ON SCREEN (screen: text read off the screen), the text of web pages read (page), browser tabs (browser), what the owner asked each coding agent and what it answered (agent:turn: role prompt, reply or rejected, from Claude Code, Codex, Gemini, Copilot, Cursor and opencode, with session and cwd) and where the owner was (location). Use it when a question needs literal evidence no summary carries, e.g. "did I run any docker commands", "what was the window title at 3pm", "what did Alex say in standup" (signalType audio, from/to the meeting\'s times, contains a name or word). Narrow with from/to (HH:MM, owner time) and contains (words the row must hold). Filter with signalType when you know the kind you want; omitting it returns owner-activity types only, since the pure-telemetry sensors (input ticks, clock ticks) fire whether or not anyone is at the machine and would crowd out everything else. Returns ONE PAGE of a day: `total` is how many rows the day actually holds, and when `nextOffset` is present, call this tool again with that offset for the next page. Do not ask for a large limit to avoid paging — the page is small so the first look is cheap, and the total tells you whether a second one is worth taking.',
    schema: {
      date: z.string().optional().describe('YYYY-MM-DD in the owner timezone, defaults to today'),
      signalType: z
        .string()
        .optional()
        .describe('One type: shell, git, window, file, symbol, agent, clipboard, calendar, document, search, media, event, project, system, phone, audio (speech), screen (screen text), page (web page text), browser (tabs), location, input, clock. A type and its event narrows further, e.g. audio:transcript for speech only (audio alone also holds device changes)'),
      from: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('HH:MM owner time: only rows from this time on'),
      to: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('HH:MM owner time: only rows before this time'),
      contains: z.string().optional().describe('Only rows whose content holds these words (case-insensitive), e.g. a name, a command, a phrase'),
      limit: z.number().int().positive().max(200).optional().describe(`Max rows for THIS page, chronological. Default ${DEFAULT_PAGE_ROWS}. The result states the day's true total, so a small page is a cheap first look.`),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Where in the day to start, 0 for the beginning. Pass the `nextOffset` from a previous call to read on; do not re-run the same day with a bigger limit, which returns rows you already have.'),
    },
    readOnly: true,
    handler: async ({ date, signalType, limit, offset, from: fromTime, to: toTime, contains }, env) => {
      const day = (date as string | undefined) ?? today(env.now);
      const range = localDayRange(day, ownerTimeZone());
      // HH:MM as minutes past the day's start — an hour out only on the two
      // days a year the clock changes, which this narrowing can live with.
      const at = (hhmm: unknown, fallback: string) => {
        if (typeof hhmm !== 'string') return fallback;
        const [h, m] = hhmm.split(':').map(Number);
        return new Date(Date.parse(range.start) + ((h ?? 0) * 60 + (m ?? 0)) * 60_000).toISOString();
      };
      const start = at(fromTime, range.start);
      const end = at(toTime, range.end);
      const needle = typeof contains === 'string' && contains.trim() !== '' ? contains : undefined;
      // An explicit type is honored even when it is one of the noisy ones — the
      // caller asked for it by name, which is a different act from not filtering.
      const types = signalType ? [signalType as string] : OWNER_EVIDENCE_TYPES;
      const from = Math.max(0, Math.floor((offset as number | undefined) ?? 0));
      const want = Math.max(1, Math.floor((limit as number | undefined) ?? DEFAULT_PAGE_ROWS));
      // The count is a separate indexed query rather than `rows.length`, because
      // `rows` is one page: without it `total` would only ever report the page
      // size back to the caller, which is the blindness that made a model ask
      // for `limit: 200` on half of these calls.
      const [total, rows] = await Promise.all([countSignalsInRange(start, end, types, needle), getSignalsInRange(start, end, want, types, from, needle)]);
      const cap = signalType && (TEXT_SIGNAL_TYPES.has(String(signalType)) || TEXT_SIGNAL_TYPES.has(String(signalType).split(':')[0]!)) ? TEXT_FIELD_CHARS : MAX_SIGNAL_FIELD_CHARS;
      const wrapper = {
        date: day,
        ...(fromTime || toTime ? { from: (fromTime as string | undefined) ?? '00:00', to: (toTime as string | undefined) ?? '24:00' } : {}),
        ...(needle ? { contains: needle } : {}),
        signalType: (signalType as string | undefined) ?? null,
        included: signalType ? [signalType] : OWNER_EVIDENCE_TYPES,
      };
      // Bounded here rather than by `renderResultText`. This result is an
      // OBJECT, and that limiter replaces an over-long object with a 60%-length
      // preview STRING — a broken answer rather than a shorter one. A day at the
      // old default measured 49,328 bytes on the live record, so every such call
      // was arriving at the model as a preview. Oldest-first is kept
      // (chronological is what this tool promises), so a page that does not fit
      // the budget ends early and `nextOffset` picks up exactly where it stopped.
      const { kept } = takeWithinBudget(
        rows.map((row) => ({ capturedAt: row.capturedAt, type: `${row.signalType}:${row.eventType}`, data: slimSignalData(row.data, cap) })),
        RESULT_BUDGET_CHARS - JSON.stringify(wrapper).length,
      );
      const nextOffset = from + kept.length;
      const remaining = total - nextOffset;
      return {
        ...wrapper,
        count: kept.length,
        total,
        offset: from,
        ...(remaining > 0
          ? {
              nextOffset,
              note: `${remaining} more of ${total} rows on this day not shown — call gnomon_signals again with offset: ${nextOffset} for the next page, or pass signalType to ask a narrower question. Do NOT re-run this same query with a larger limit; it returns rows you already have.`,
            }
          : {}),
        signals: kept,
      };
    },
  },
];
