import { z } from 'zod';
import { formatParam, param } from '../calibrated.js';
import { getBoardTraffic, getSignalsInRange, getMomentById, getMomentCost, getMomentsForProject, getMultiDayCommitments, getOpenCommitments, getPromises, getRecentSignals, loadAliasNames } from '@sundial/db/index.js';
import { promiseReliability } from '../promise-reliability.js';
import { localDate, localDayRange, localHour } from '@sundial/helpers/local-day.js';
import { getLlmLedgerRows, type LlmLedgerGroupBy } from '@sundial/db/index.js';
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js';
import { buildDailyContext } from '../daily-context.js';
import { DEFAULT_PAGE_ROWS, OWNER_EVIDENCE_TYPES, pageWithinBudget, RESULT_BUDGET_CHARS, slimSignalData } from './evidence-tools.js';
import { sharedCheckouts } from '../agent-fleet.js';
import { backtestTypes, describeRule, resolvePeople, validateWatchRule, WATCH_FLAG_TYPES, WATCH_GRAMMAR } from '../watch.js';
import { MINE_TYPES, mineRules } from '../watch-mine.js';
import { summarizeBacktest } from '../watch-backtest.js';
import { readSituation } from '../read/situation.js';
import { routineForecast, routineLabel, topRoutines } from '../routines.js';
import type { GnomonTool } from './registry.js';
import { openAsk } from '@sundial/helpers/loops.js';

/** The owner's day, not UTC's. Read per call rather than cached so an edited config.json takes effect without a restart. */
function ownerTimeZone(): string {
  return loadSundialConfig().timezone;
}

function today(now: Date): string {
  return localDate(now.toISOString(), ownerTimeZone());
}

/**
 * A session too short to be worth a line in a day's reading.
 *
 * Three minutes. A day holds ~314 closed moments and roughly half are under
 * this — a window flicked to and away from, which is real in the log and noise
 * in a summary. They stay reachable through `gnomon_signals`, and the moments
 * table itself is untouched.
 */
const SUMMARY_MIN_MS = 3 * 60_000;

/**
 * Enough timeline that `buildDailyContext`'s own cap cannot bite before the
 * duration filter below has run.
 *
 * That cap defaults to 200 and slices CHRONOLOGICALLY, which is the wrong end
 * for this: on 2026-09-09 the day held 316 moments, 50 of them over three
 * minutes — and 29 of those 50 fell after the 200th. A morning of twenty-second
 * flicks spent the budget and an afternoon of real work was dropped. Raising it
 * here costs nothing because the filter, not the cap, is what keeps this small.
 */
const SUMMARY_TIMELINE_CAP = 5000;

/**
 * Sessions per page of a day.
 *
 * Larger than `DEFAULT_PAGE_ROWS` because a session row is small and a day's
 * SHAPE is the thing this tool promises — showing 25 of a busy day's 60
 * sessions would answer a different question than the one asked. The character
 * budget still governs, so this is a ceiling rather than a target.
 */
const SUMMARY_SESSION_PAGE = 60;

/**
 * A day, small enough to fit in a prompt.
 *
 * `gnomon_today_summary` used to return `getMomentsForDate` — the raw `moments`
 * table. Measured against the live record on 2026-09-09 that was **479,384
 * characters**: 314 rows carrying every window title, screen excerpt,
 * `[private]` placeholder and internal column. Roughly 120,000 tokens, which is
 * very nearly the whole 128,000-token window in ONE tool result, and the
 * missing half of why single conversations reached 142,654 and 165,108 prompt
 * tokens. dsh's `tool-result-pruner` now truncates an over-long result, but
 * head-plus-tail on a 314-item array hands the model the start of the day and
 * the end of it and silently drops the middle — a worse answer than a summary.
 *
 * `buildDailyContext` already computes every aggregate the journal and Today
 * read, so nothing is derived twice here. What this adds is the projection: the
 * aggregates whole (they are small), and the timeline reduced to the six fields
 * a reading of a day needs, each carrying its moment id so
 * `gnomon_moment_detail` remains the way to the rest. Narratives, titles, pages,
 * life events and commands are dropped — they are the bulk, and every one of
 * them is one `gnomon_moment_detail` call away.
 */
async function summarizeDay(date: string, page: { offset?: number; limit?: number } = {}): Promise<Record<string, unknown>> {
  const context = await buildDailyContext(date, { timeZone: ownerTimeZone(), maxTimeline: SUMMARY_TIMELINE_CAP });
  const { timeline, ...day } = context;

  const worthReading = timeline.filter((entry) => entry.durationMin * 60_000 >= SUMMARY_MIN_MS);
  // Longest first for the CAP, so a fragmented day drops its shortest sessions
  // rather than its afternoon — then back into clock order, which is how a day
  // is read. The aggregates are measured first and the sessions get what is
  // left, so this result cannot reach `renderResultText`'s object path.
  const budget = RESULT_BUDGET_CHARS - JSON.stringify(day).length;
  const byLength = [...worthReading].sort((a, b) => b.durationMin - a.durationMin);
  const sessionPage = pageWithinBudget(
    byLength.map((entry) => ({
      id: entry.id,
      start: entry.start,
      min: entry.durationMin,
      process: entry.process,
      project: entry.project,
      intent: entry.intent,
      // A count, not the words — the seventh field, and the cheapest one that
      // could exist: it tells the model a transcript of this session is on the
      // record and reachable through `gnomon_moment_detail`. Without it a day
      // with two hours of captured speech in it is indistinguishable from a
      // silent one, and the model answers accordingly.
      ...(entry.heardChars !== undefined ? { heardChars: entry.heardChars } : {}),
    })),
    { offset: page.offset, limit: page.limit ?? SUMMARY_SESSION_PAGE, budget },
  );
  const kept = sessionPage.rows;
  const omitted = sessionPage.total - (sessionPage.offset + kept.length);

  const heard = kept.filter((entry) => typeof entry.heardChars === 'number');

  return {
    ...day,
    sessions: kept.sort((a, b) => a.start.localeCompare(b.start)),
    sessionCount: sessionPage.total,
    sessionOffset: sessionPage.offset,
    // The paging fields are added only when there IS another page, so an
    // ordinary day carries no machinery it does not need — and a `nextOffset`
    // in the result always means something is actually there.
    ...(sessionPage.nextOffset !== undefined ? { nextSessionOffset: sessionPage.nextOffset } : {}),
    /**
     * Phrased as a property of the view, not as damage to it.
     *
     * The first wording was `sessionsOmitted: 276` plus a note about a size
     * budget, and the live model read that as a broken result: it refused to
     * name the day's longest session and reported the tool as truncated —
     * though the longest sessions are exactly the ones this view guarantees.
     * A field that says what is MISSING invites that reading; one that says
     * what is PRESENT, and that the ranking is intact, does not.
     */
    sessionsNote: `${kept.length} sessions shown of ${timeline.length} moments — every session over ${SUMMARY_MIN_MS / 60_000} minutes that fits, longest kept first, so the longest and the totals here are complete. ${timeline.length - worthReading.length} were shorter than that${omitted > 0 ? ` and ${omitted} more mid-length ones are on the next page — call gnomon_today_summary again for this same date with offset: ${sessionPage.nextOffset} to read them, rather than re-running the day` : ''}; gnomon_signals has the raw stream and gnomon_moment_detail has any single session in full.`,
    /**
     * The count is useless unless the model knows it can spend it.
     *
     * A bare `heardChars: 600` beside a session is just another number; the
     * sentence is what turns it into "there is a transcript here and here is
     * how to open it". Present only on a day that actually heard something, so
     * a silent day adds no words to the result — and so its presence is itself
     * the answer to "was anything recorded today".
     */
    ...(heard.length > 0
      ? {
          heardNote: `Ambient hearing captured speech during ${heard.length} of these sessions (${heard.reduce((sum, entry) => sum + (entry.heardChars ?? 0), 0)} characters in total). \`heardChars\` on a session means a transcript of what was said in it IS on the record: call gnomon_moment_detail with that session's id to read it, and use gnomon_semantic_search to find spoken words across days. Sessions with no \`heardChars\` were not listened to — the microphone only wakes for a meeting, a call, or when the owner turns it on.`,
        }
      : {}),
  };
}

/**
 * "What is happening, and what has happened" — the moment-and-window tools,
 * moved verbatim out of `packages/mcp/src/mcp-tools.ts`.
 *
 * The descriptions are carried over unchanged and deliberately so. They were
 * written against real failure modes — `gnomon_current_context`'s warning about
 * `ambientProjectPointer` exists because that pointer can differ from the
 * focused window several hundred times a day, and a model that treats it as a
 * peer of `resolvedProject` reports the wrong project with confidence. Shortening
 * that text to fit a tool list would delete the part that does the work.
 */
export const CONTEXT_TOOLS: GnomonTool[] = [
  {
    name: 'gnomon_current_context',
    description:
      "Get the current activity context per the daemon's latest known state — and `situation`, the one summary the owner's screen also shows: what is next on the calendar, what is open on the project they are in (commitments, unpushed commits, hot files), and where they left off on each recent project. Answer \"where am I / what is open / where did I leave X\" from `situation` first. Also: the active window and open moment, plus `resolvedProject` — the focused window's own project attribution, which is null when the window carries no reliable project locator (a browser tab, a chat app). Treat that null as the answer; `ambientProjectPointer` is a labelled low-confidence fallback, not a peer of it. May lag live reality by up to the daemon's snapshot interval (60s).",
    schema: {},
    readOnly: true,
    handler: async (_args, env) => {
      const state = await env.state();
      if (!state) return { note: 'No snapshot yet — the daemon may not have run since Phase 2.' };
      const { window, moment, project, focusMode } = state;
      // The live slices the fold keeps beside the window (2026-09-05): what is
      // in the browser, whether a call is on, a command that keeps failing,
      // commits nobody has seen, the files worked in most today. Same facts the
      // presence line gives the chat model, here for an MCP client (Claude Code).
      const s = state;
      const hot = Object.values(s.files?.hot ?? {})
        .sort((a, b) => b.changes - a.changes)
        .slice(0, 3)
        .map((f) => ({ path: `${f.projectRoot}/${f.relPath}`, changesToday: f.changes }));
      const live = {
        page: s.browser?.current ? { app: s.browser.current.app, url: `${s.browser.current.host}${s.browser.current.path}`, title: s.browser.current.title, since: s.browser.current.since, updatedAt: s.browser.current.updatedAt } : null,
        call: s.av?.call ?? null,
        // A run of consecutive failures, whatever was typed — `lastCommand` is
        // the most recent one, NOT a command that failed `count` times.
        failingRun: s.shell?.streak && s.shell.streak.count >= 2 ? { lastCommand: s.shell.streak.command, count: s.shell.streak.count, exitCode: s.shell.streak.exitCode, cwd: s.shell.streak.cwd, lastAt: s.shell.streak.lastAt } : null,
        unpushed: Object.entries(s.git?.unpushed ?? {}).map(([cwd, u]) => ({ cwd, branch: u.branch, ahead: u.ahead, since: u.since })),
        hotFilesToday: hot,
        // What is on screen, as references: the ticket or PR the owner is looking at.
        screen: s.screen?.app ? { app: s.screen.app, refs: s.screen.refs ?? [] } : null,
        symbolsEdited: moment?.rollup.symbolsEdited ?? [],
        // Every coding-agent session the owner has open: where, and whether it
        // is working, waiting for them (`waiting`), or on a tool call (`tool`).
        // For a Claude Code client, these are its siblings.
        agents: s.agent?.fleet ?? [],
        // Folders two sessions work in at once: a build or commit in one ships
        // the other's unsaved edits. If yours is here, you have a sibling.
        sharedCheckouts: sharedCheckouts(s.agent?.fleet ?? [], env.now.toISOString()),
        // lane D — #6: where an interruption would go now: mac, phone, or hold (a call, a focus mode).
        route: s.route ?? null,
      };
      const { projectId, source, confidence } = window.attribution;
      const resolvedProject = projectId
        ? { projectId, source, confidence }
        : { projectId: null, note: 'The focused window has no resolved project attribution — do not substitute ambientProjectPointer for this.' };
      return {
        window,
        moment,
        resolvedProject,
        ambientProjectPointer: {
          current: project.current,
          org: project.org,
          known: project.known,
          note: "Low-confidence fallback: the last project a background sensor sweep (git/shell activity) touched, which can differ from the focused window several hundred times a day. Prefer resolvedProject; only fall back to this when resolvedProject.projectId is null and a rough guess is acceptable.",
        },
        focusMode,
        live,
        // The question Gnomon is waiting on, with its id — so a model that
        // lost the wake-up turn can still record the answer against it.
        ownerAsk: openAsk(s) ? { askId: openAsk(s)!.askId, question: openAsk(s)!.question, choices: openAsk(s)!.choices, askedAt: openAsk(s)!.ts } : null,
        // S1 — the one situation the screen draws too: what is next, what is
        // open on this project, where the owner left off on each. Read this
        // first for "where am I", "what is open", "where did I leave X".
        situation: await readSituation({ state: s, now: env.now.getTime() }),
      };
    },
  },
  {
    name: 'gnomon_tickets',
    description:
      "Ticket threads: every ticket key (e.g. BOX-538) the owner's own machine has seen in the last 30 days, stitched across window titles, browser tabs, screen text, pages, shell, speech, calendar, branches, commits and pull requests — no issue tracker involved. Each thread says on how many days it was seen, where, and how far work got (`stage`: seen / branch / commit / pr, with the PR's state). `radar` lists tickets that keep coming back but were never started. Pass `id` for one ticket; for the rows themselves, call gnomon_signals with contains=<id>. Answer \"what is going on with BOX-538\", \"which tickets am I on\", \"what did I look at but never start\". A pull request with no ticket key in it is not here: for every PR's state on a project, as GitHub reported it, use gnomon_project_handoff.",
    schema: {
      id: z.string().optional().describe('One ticket key, e.g. BOX-538'),
      days: z.number().int().positive().max(30).optional().describe('Only tickets seen in the last N days (default 14)'),
    },
    readOnly: true,
    handler: async ({ id, days }, env) => {
      const state = await env.state();
      if (!state) return { note: 'No snapshot yet.' };
      const all = Object.values(state.tickets ?? {});
      if (typeof id === 'string' && id.trim() !== '') {
        const key = id.trim().toUpperCase();
        const thread = all.find((t) => t.id === key);
        return thread ? { thread, evidence: `gnomon_signals with contains="${key}" (and a date) returns the rows` } : { note: `${key} has not been seen in the last 30 days.` };
      }
      const since = new Date(env.now.getTime() - ((days as number | undefined) ?? 14) * 86_400_000).toISOString();
      // A key only ever seen in a list (a board, a backlog) was in view, never looked at.
      const threads = all.filter((t) => t.lastSeen >= since && t.days.length > 0).sort((a, b) => b.days.length - a.days.length || b.lastSeen.localeCompare(a.lastSeen));
      // Seen on three days or more, from two kinds of source or more, and never
      // started: what the owner keeps looking at without a branch or a commit.
      const radar = threads.filter((t) => t.stage === 'seen' && t.days.length >= 3 && Object.keys(t.sources).filter((s) => s !== 'list').length >= 2).map((t) => t.id);
      return { count: threads.length, radar, threads: threads.slice(0, 25).map((t) => ({ id: t.id, stage: t.stage, days: t.days.length, lastSeen: t.lastSeen, sources: t.sources, commits: t.commits, pr: t.pr })) };
    },
  },
  {
    name: 'gnomon_test_rule',
    description:
      `Backtest a WATCH RULE — a small spec Gnomon can adopt to notice something on its own — against the owner's real log, or (no \`rule\`) list the adopted ones. ${WATCH_GRAMMAR} Returns how often it matched, how often it fired, and under \`gate\` how many of those fires the owner would actually have heard — interrupting (phasic), on the list (tonic) or held back (suppressed, with reasons) — under their current dial, so the owner sees exactly what adopting it means. Report \`gate\`, not \`fired\`, as what they will hear. \`holdout\` splits the days in two halves: a rule tuned on the older half must still fire in the recent one. \`byKey\` counts fires per thing (hashed); each example lists the signal ids behind it; \`nearest\` says how close a rule that never fired came. Always test before proposing, show the result, and adopt (gnomon_adopt_rule) only on the owner's yes. Tune a rule that fires more than a few times a day.`,
    schema: {
      rule: z.any().optional().describe('The spec, as an object (see description). Omit to list adopted rules.'),
      days: z.number().int().positive().max(60).optional().describe('How many past days to replay (default 14, at most 60 — a rule that holds for days needs weeks of history)'),
    },
    readOnly: true,
    handler: async ({ rule, days }, env) => {
      const state = await env.state();
      const zone = state?.config.timezone ?? ownerTimeZone();
      if (rule === undefined || rule === null) {
        const w = state?.watch ?? { rules: [], runtime: {} };
        const last = (id: string) => w.stats?.[id]?.recent.at(-1) ?? w.runtime[id]?.lastFiredAt ?? null;
        return { adopted: w.rules.map((r) => ({ ...r, words: describeRule(r), paused: w.paused?.includes(r.id) ?? false, version: w.stats?.[r.id]?.version ?? 1, fires: w.stats?.[r.id]?.fires ?? 0, verdicts: w.stats?.[r.id]?.verdicts ?? null, lastFiredAt: last(r.id) })) };
      }
      let spec: unknown = rule;
      if (typeof spec === 'string') {
        try {
          spec = JSON.parse(spec);
        } catch {
          return { valid: false, error: 'rule must be a JSON object' };
        }
      }
      const checked = validateWatchRule(resolvePeople(spec, state?.memory.aliasNames ?? {}));
      if ('error' in checked) return { valid: false, error: checked.error };
      const span = (days as number | undefined) ?? 14;
      const now = env.now.toISOString();
      const from = new Date(env.now.getTime() - span * 86_400_000).toISOString();
      const events: { id: string; type: string; ts: string; payload: unknown }[] = [];
      const PAGE = 5000;
      for (let offset = 0; offset < 400_000; offset += PAGE) {
        const rows = await getSignalsInRange(from, now, PAGE, backtestTypes(checked.rule), offset);
        for (const r of rows) events.push({ id: r.id, type: `${r.signalType}:${r.eventType}`, ts: r.capturedAt, payload: r.data });
        if (rows.length < PAGE) break;
      }
      const hour = (ts: string) => localHour(ts, zone);
      const settings = state?.settings;
      return summarizeBacktest(checked.rule, events, { days: span, zone, dial: settings?.noticeBias ?? 0, silent: settings?.autonomy === 'off', now, daytime: (ts) => hour(ts) >= 6 && hour(ts) < 18 });
    },
  },
  {
    name: 'gnomon_mine_rules',
    description:
      "Find watch rules worth proposing, from the owner's own record and without a model: high values held or repeated, long silences, a routine that stops short, an app or site they asked about on three days, types behind notices they rated useful. Each candidate was replayed over the older and the recent half of 30 days and kept only with 1–10 fires in each half and a steady rate, and dropped when half its fires coincide with a notice Gnomon already raises. Returns up to 5 specs with their numbers. Their titles and sentences are placeholders: write them in the owner's words, then test the result with gnomon_test_rule before proposing it.",
    schema: {},
    readOnly: true,
    handler: async (_args, env) => {
      const state = await env.state();
      const zone = state?.config.timezone ?? ownerTimeZone();
      const days = 30;
      const now = env.now.toISOString();
      const from = new Date(env.now.getTime() - days * 86_400_000).toISOString();
      const read = async (types: string[]) => {
        const out: { id: string; type: string; ts: string; payload: unknown }[] = [];
        for (let offset = 0; offset < 400_000; offset += 5000) {
          const rows = await getSignalsInRange(from, now, 5000, types, offset);
          for (const r of rows) out.push({ id: r.id, type: `${r.signalType}:${r.eventType}`, ts: r.capturedAt, payload: r.data });
          if (rows.length < 5000) break;
        }
        return out;
      };
      const [events, asks, verdicts, notices] = await Promise.all([read([...MINE_TYPES, ...WATCH_FLAG_TYPES]), read(['ask:route-predicted', 'chat:owner']), read(['feedback:verdict']), read(['notice:candidate'])]);
      const rules = state?.watch?.rules ?? [];
      const useful = new Map<string, { kind: string; type?: string; n: number }>();
      for (const v of verdicts) {
        const p = v.payload as { artifactKind?: string; artifactId?: string; verdict?: string };
        if (p.verdict !== 'useful' || p.artifactKind !== 'notice' || typeof p.artifactId !== 'string') continue;
        const [head, id] = p.artifactId.split(':');
        const kind = head === 'watch' ? `watch:${id}` : head!;
        const entry = useful.get(kind) ?? { kind, ...(head === 'watch' ? { type: rules.find((r) => r.id === id)?.when.type } : {}), n: 0 };
        useful.set(kind, { ...entry, n: entry.n + 1 });
      }
      const mined = mineRules({
        events,
        now,
        days,
        zone,
        routines: Object.values(state?.routines?.learned ?? {}).filter((r) => r.support >= 3),
        // The owner's words: the retired route prediction's `query` before W5 step 8, `chat:owner` since.
        asks: asks.map((a) => ({ ts: a.ts, query: String((a.payload as { query?: unknown; text?: unknown }).query ?? (a.payload as { text?: unknown }).text ?? '') })),
        useful: [...useful.values()],
        builtins: notices.filter((n) => !String((n.payload as { kind?: unknown }).kind ?? '').startsWith('watch:')).map((n) => n.ts),
      });
      return {
        days,
        candidates: mined.map((m) => ({ source: m.source, spec: m.spec, words: describeRule(m.spec), fired: { older: m.older, recent: m.recent, perHalfDays: days / 2 }, overlapWithBuiltins: m.overlap })),
        note: mined.length === 0 ? 'Nothing in the record held up on both halves. Propose nothing.' : "Titles and sentences are placeholders. Word the best one for the owner, test it with gnomon_test_rule, and shelve it only if its examples are worth hearing.",
      };
    },
  },
  {
    name: 'gnomon_today_summary',
    description:
      "Get a day's shape: per-project minutes, meetings, breaks, focus split, app-to-app flows, and a timeline of the sessions over three minutes with each one's id. Use this for \"what did I do on <date>\" and for totalling a day. Sessions under three minutes are left out — pass a timeline id to gnomon_moment_detail for one session's full record, or use gnomon_signals for the literal event stream. `sessionCount` is how many sessions the day holds in all; when `nextSessionOffset` is present, call this tool again for the SAME date with that offset to read the rest instead of re-running the day. Note the intent text is a model's earlier narration of the moment, not primary evidence — prefer gnomon_code_activity or gnomon_signals when the question is about specific files, commands, or commits.",
    schema: {
      date: z.string().optional().describe('YYYY-MM-DD in the owner timezone, defaults to today'),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Where in the session list to start. Use the `nextSessionOffset` from a previous call for the same date to read the rest, rather than asking for the day again.'),
      limit: z.number().int().positive().max(200).optional().describe('How many sessions to return on this page. Default 60, and the size budget may return fewer.'),
    },
    readOnly: true,
    handler: async ({ date, offset, limit }, env) =>
      summarizeDay((date as string | undefined) ?? today(env.now), { offset: offset as number | undefined, limit: limit as number | undefined }),
  },
  {
    name: 'gnomon_moment_detail',
    description: 'Get full detail for a single moment by id.',
    schema: { momentId: z.string().describe('The moment id') },
    readOnly: true,
    // A missing moment is usually not a wrong id. A moment's id is minted when
    // it OPENS, and `closeMoment` drops any moment shorter than twenty seconds
    // without ever writing a row — so every `llm_audit` row stamped during one
    // of those keeps a pointer to a moment that will never exist. Chasing such
    // an id from the ledger looked like a broken reader during the audit. Say
    // which of the three it is instead of "not found".
    handler: async ({ momentId }) => {
      const moment = await getMomentById(momentId as string);
      if (moment === null) {
        return {
          error: `No moment is stored under ${momentId}. Either it is still open and has not been written yet, or it lasted under twenty seconds and was dropped rather than stored — a ledger row can name a moment that was never persisted. Do not report this as a broken lookup.`,
        };
      }
      // What Gnomon spent understanding this one. Every ledger row has carried a
      // `momentId` since it was written and no surface ever showed it, which the
      // audit named the unmade accountability loop: a card saying what the owner
      // did, beside no statement of what it cost to read. Absent, not zero, when
      // nothing was spent — most moments are never thought about, and a `$0.00`
      // on all of them would train the eye to skip the line.
      const cost = await getMomentCost(momentId as string);
      return cost.calls === 0 ? moment : { ...moment, data: { ...(moment.data as Record<string, unknown>), cost } };
    },
  },
  {
    name: 'gnomon_recent_activity',
    description:
      'Get the most recent raw signals from the event log (window changes, git activity, calendar events, etc.) — for answering "what just happened." For a specific past day or a specific kind of evidence, use gnomon_signals instead; this one is anchored to now. Returns one page; when `nextOffset` is present, call again with it to walk further back.',
    schema: {
      limit: z.number().int().positive().max(200).optional().describe(`Max rows, defaults to ${DEFAULT_PAGE_ROWS}`),
      offset: z.number().int().min(0).optional().describe('How many of the newest rows to skip, for reading further back. Use the `nextOffset` from a previous call.'),
    },
    readOnly: true,
    handler: async ({ limit, offset }) => {
      // Filtered to the owner-evidence types, the SAME list `gnomon_signals`
      // uses. Unfiltered, this returned the newest rows of the whole log — and
      // `screen:ocr` and `input:activity` are the two highest-volume sensors
      // (38,509 and 110,433 rows on the live record), so "what just happened"
      // answered with screen dumps and input ticks: 20 rows, 15,003 characters,
      // and no activity among them.
      const from = Math.max(0, Math.floor((offset as number | undefined) ?? 0));
      const want = Math.max(1, Math.floor((limit as number | undefined) ?? DEFAULT_PAGE_ROWS));
      // Fetched from the top each time and paged in memory. "What just happened"
      // is anchored to now, so the newest rows are the answer and an offset is
      // only ever a short walk back from them — a database offset would be more
      // machinery for a window that is never deep.
      const rows = await getRecentSignals(from + want, OWNER_EVIDENCE_TYPES);
      // No `total` here, deliberately: this tool's list is the whole event log,
      // and "247,891 rows exist" tells the model nothing it can act on. A
      // `nextOffset` does — it is the only question worth answering about a feed.
      const page = pageWithinBudget(
        rows.map((row) => ({ ...row, data: slimSignalData(row.data) })),
        { offset: from, limit: want, budget: RESULT_BUDGET_CHARS },
      );
      return {
        signals: page.rows,
        count: page.rows.length,
        offset: page.offset,
        ...(page.rows.length === want ? { nextOffset: from + page.rows.length, note: `Older rows are available — call again with offset: ${from + page.rows.length}.` } : {}),
      };
    },
  },
  {
    name: 'gnomon_project_status',
    description: 'Get recent moments for a given project id, most recent first — use this to answer "what has the user been doing on project X." Returns one page; when `nextOffset` is present, call again with it rather than re-asking with a larger limit.',
    schema: {
      projectId: z.string().describe('The project id (its root path)'),
      limit: z.number().int().positive().max(200).optional().describe(`How many moments on this page, newest first. Default ${DEFAULT_PAGE_ROWS}.`),
      offset: z.number().int().min(0).optional().describe('Where to start. Use the `nextOffset` from a previous call rather than re-asking with a bigger limit.'),
    },
    readOnly: true,
    handler: async ({ projectId, limit, offset }) => {
      const from = Math.max(0, Math.floor((offset as number | undefined) ?? 0));
      const want = Math.max(1, Math.floor((limit as number | undefined) ?? DEFAULT_PAGE_ROWS));
      // 67% of this tool's live results came back cut, at a default of 50 rows
      // carrying a moment each. The rows are fetched one page deeper than asked
      // so `nextOffset` can be honest about whether there is more.
      const rows = await getMomentsForProject(projectId as string, from + want + 1);
      const page = pageWithinBudget(rows, { offset: from, limit: want, budget: RESULT_BUDGET_CHARS });
      return {
        projectId,
        moments: page.rows,
        count: page.rows.length,
        offset: page.offset,
        ...(rows.length > from + page.rows.length
          ? { nextOffset: from + page.rows.length, note: `More moments are on this project — call again with offset: ${from + page.rows.length}.` }
          : {}),
      };
    },
  },
  {
    name: 'gnomon_open_commitments',
    description:
      'Get the open threads of work and the owner\'s open PROMISES. A promise row has `promise`: who it is owed to (or, with direction `awaiting`, who owes the owner), the thing, when it is due and why then (said, the next meeting with that person, or a three-working-day default), whether the owner confirmed it, and the evidence seen. `reliability` is how the owner keeps promises, overall and per person, with n on every count — never state a rate it does not give. Threads of work are pieces of work spanning hours to weeks, each identified by the git branch it was done on, with when it started, when it was last touched, and how many distinct days it spanned. Use this for "what am I in the middle of", "what did I leave unfinished", and "what was I doing on X last week". `activeDays` is the count of separate days the thread was returned to, which is what distinguishes a real multi-session piece of work from an afternoon. A thread is closed automatically after 14 days without a touch and no longer appears here; nothing observable tells Gnomon a branch was merged, so an absent thread means it went quiet, NOT that it was finished. `total` is how many threads are open in all — itself an answer worth reporting — and when `nextOffset` is present, call again with it for the next page.',
    schema: {
      limit: z.number().int().positive().max(100).optional().describe(`How many threads on this page. Default ${DEFAULT_PAGE_ROWS}.`),
      offset: z.number().int().min(0).optional().describe('Where to start. Use the `nextOffset` from a previous call.'),
      multiDayOnly: z.boolean().optional().describe('Only threads spanning more than one day — the ones that are genuinely "picked up again later" rather than a single session.'),
    },
    readOnly: true,
    handler: async ({ limit, offset, multiDayOnly }) => {
      const from = Math.max(0, Math.floor((offset as number | undefined) ?? 0));
      const want = Math.max(1, Math.floor((limit as number | undefined) ?? DEFAULT_PAGE_ROWS));
      // Both underlying queries are already bounded lists of open threads, so
      // the whole set is fetched once and paged here — `total` is then the real
      // number of open threads, which is itself an answer ("you have 31 things
      // open") that no page of rows could give.
      const [all, promises, aliasNames] = await Promise.all([multiDayOnly === true ? getMultiDayCommitments(100) : getOpenCommitments(100), getPromises(500), loadAliasNames()]);
      const page = pageWithinBudget(all, { offset: from, limit: want, budget: RESULT_BUDGET_CHARS });
      return {
        reliability: promiseReliability(promises, (who) => {
          const named = aliasNames[who] ?? who;
          return /^person-[0-9a-f]{10}$/.test(named) ? null : named;
        }),
        commitments: page.rows,
        count: page.rows.length,
        total: page.total,
        offset: page.offset,
        ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset, note: page.note } : {}),
      };
    },
  },
  {
    name: 'gnomon_routines',
    description:
      'Get what the owner habitually does: the sequences of apps they repeat (the procedural tier), strongest first, plus `forecast` — the step they usually take next from where they are right now, when a learned routine predicts one. A step is `App/class`, where class is work or personal by the owner\'s own taxonomy; a routine never carries window content. Use this for "what do I usually do after standup", "am I in my normal flow", and to notice when the owner is off their usual path — but hold it lightly: `note` says how often such a forecast held, with its n, and it is a tendency to mention once, never a rule to enforce. `support` is how many times the exact sequence recurred.',
    schema: {
      limit: z.number().int().positive().max(64).optional().describe('How many routines to return. Default 10.'),
    },
    readOnly: true,
    handler: async ({ limit }, env) => {
      const state = await env.state();
      if (!state) return { note: 'No snapshot yet — the daemon may not have run since Phase 2.' };
      const { trail, learned } = state.routines;
      const forecast = routineForecast(trail, learned);
      return {
        routines: topRoutines(learned, (limit as number | undefined) ?? 10).map((r) => ({
          routine: routineLabel(r),
          steps: r.steps,
          support: r.support,
          lastSeenAt: r.lastSeenAt,
        })),
        learnedCount: Object.keys(learned).length,
        recentSteps: trail,
        forecast:
          forecast === null
            ? null
            : { next: forecast.expectedProcess, from: routineLabel(forecast.routine), support: forecast.routine.support, matchedSteps: forecast.matched },
        note: `Forecasts of the next step held ${formatParam(param(state, 'routine.next'))}. Mention a tendency once; never enforce it.`,
      };
    },
  },
  {
    name: 'gnomon_board_traffic',
    description:
      "What happens on the owner's board, and how much of it is Gnomon's doing. Rows along one axis: `day` (owner-local, newest first) or `card`. Each row carries `placed`, `removed`, `moved`, `placedByGnomon`, and the one that matters — `sweptWithin60s`, cards Gnomon placed that the owner took off again inside a minute — plus `medianKeptSeconds`, how long they left a Gnomon card standing when they removed it at all. Use it to answer how well you are managing the owner's space, not how busy it was: a high placement count with a high sweep count is not help, it is clutter the owner had to clear.",
    schema: {
      days: z.number().int().min(1).max(365).optional().describe('How many owner-local days back, ending today. Default 7.'),
      groupBy: z.enum(['day', 'card']).optional().describe('The axis. Default day.'),
    },
    readOnly: true,
    handler: async ({ days, groupBy }, env) => {
      const timeZone = ownerTimeZone();
      const span = (days as number | undefined) ?? 7;
      const axis = ((groupBy as string | undefined) ?? 'day') as 'day' | 'card';
      // Calendar-day arithmetic, for the same DST reason as the ledger below.
      const [y, m, d] = today(env.now).split('-').map(Number);
      const from = new Date(Date.UTC(y, m - 1, d - (span - 1))).toISOString().slice(0, 10);
      const rows = await getBoardTraffic(axis, timeZone, localDayRange(from, timeZone).start);
      return { groupBy: axis, days: span, from, to: today(env.now), rows };
    },
  },
  {
    name: 'gnomon_llm_ledger',
    description:
      "Gnomon's own model spend, as rows along ONE axis: `day` (owner-local, newest first), `purpose` (which part of Gnomon spent it), `model`, or `errorClass` (only the failures, so those rows sum to the failure count, not the call count). Every row carries calls, failed, tokens, costUsd at list price, `cacheReadTokens` (the part of the input served from the provider's prefix cache — a SUBSET of tokens, priced at roughly a twentieth of the input rate, so a row where this is most of the input costs far less than its token count reads), `billedOnFailureTokens` (prompt uploaded by calls that died — spend with nothing to show for it), and `failedMs` (wall clock burned inside failures). Use it for questions about what the thinking costs, what is failing and how much that waste is worth. `costUsd` is an ESTIMATE at list price, never a bill. Rows written before 2026-09-18 carry `cacheReadTokens: 0` because the column did not exist, and their `costUsd` reads high as a result — do not compare a cost before that date with one after it.",
    schema: {
      days: z.number().int().min(1).max(365).optional().describe('How many owner-local days back, ending today. Default 7.'),
      groupBy: z.enum(['day', 'purpose', 'model', 'errorClass']).optional().describe('The axis. Default day.'),
    },
    readOnly: true,
    handler: async ({ days, groupBy }, env) => {
      const timeZone = ownerTimeZone();
      const span = (days as number | undefined) ?? 7;
      const axis = ((groupBy as string | undefined) ?? 'day') as LlmLedgerGroupBy;
      // Calendar-day arithmetic, not 24h subtraction: a DST boundary inside the
      // window would otherwise move the oldest day by an hour and drop or
      // double-count whatever sat against its edge.
      const [y, m, d] = today(env.now).split('-').map(Number);
      const from = new Date(Date.UTC(y, m - 1, d - (span - 1))).toISOString().slice(0, 10);
      const since = localDayRange(from, timeZone).start;
      const rows = await getLlmLedgerRows(axis, timeZone, since);
      return { groupBy: axis, days: span, from, to: today(env.now), rows };
    },
  },
];
