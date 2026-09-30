import { isRedactedPlaceholder } from '@sundial/helpers/redact/redact-policy.js';
import { canonicalProjectRoot } from '@sundial/helpers/redact/redact-url.js';
import type { KernelState, MomentRollup, Rule } from '@sundial/kernel/types.js';
import { aliasedKnownRoot, longestPrefixRoot } from './attribution.js';

const MAX_NOTABLE_COMMANDS = 12;
const MAX_LIFE_EVENTS = 20;
const MAX_SCREEN_TOPICS = 12;
const MAX_SCREEN_FACTS = 6;
const MAX_PAGE_EXCERPT_CHARS = 600;
/** Distinct pages kept per moment — a browsing burst is many pages, a reading moment one. */
const MAX_PAGES = 8;
const MAX_SCREEN_EXCERPT_CHARS = 240;
/** Speech runs longer than a screen line, so the spoken excerpt gets more room — still bounded, because a moment is a summary and the raw utterances are in the log. */
const MAX_SPOKEN_EXCERPT_CHARS = 600;
const MAX_SPOKEN_LANGUAGES = 4;
const MAX_SCREEN_REFS_PER_MOMENT = 8;
const MAX_SYMBOLS_PER_MOMENT = 12;
/** Shortest identifier worth naming; `id`, `db`, `fn` say nothing. */
const MIN_SYMBOL_CHARS = 4;

/**
 * Commands that say nothing about the work: looking around, moving about.
 *
 * A deny-list, because the allow-list that stood here was a DEPLOY detector
 * wearing a notability filter's name — `git commit|push|merge|rebase`, `npm`,
 * `yarn`, docker, kubectl, terraform, borrowed loosely from
 * `life-event/deploy.ts`. On this machine it matched almost nothing: the work
 * is `pnpm`, `vitest`, `tsc`, `sqlite3`, `git status|diff|log`, and long
 * pipelines. So a 31-minute session reported `shellCommandCount: 32` beside
 * `notableCommands: []`, and the analysis prompt — which shows the list when
 * it has one and the bare count otherwise — was told thirty-two commands ran
 * and not one of them. Nothing was redacted and nothing failed to extract; the
 * filter simply asked the wrong question.
 */
const TRIVIAL_COMMAND = /^(ls|ll|la|cd|pwd|cat|less|head|tail|echo|clear|exit|which|true|whoami|date|open|man|history)\b/;

/**
 * One command as a prompt can read it, or null when it says nothing.
 *
 * A `cd somewhere && real-work` prefix is bookkeeping, so it goes; what is kept
 * is the first stage of the pipeline, which is the thing that was attempted.
 * Truncated because a 500-character `sqlite3 … | python3 - <<EOF` is context the
 * prompt pays for and cannot use. The string is already sanitized at ingest —
 * this trims an already-safe value, it does not re-derive policy.
 */
function notableCommand(command: string): string | null {
  const head = command.trim().replace(/^cd\s+[^&;|]+?\s*(?:&&|;)\s*/, '').trim();
  if (head === '' || TRIVIAL_COMMAND.test(head)) return null;
  return head.length > 72 ? `${head.slice(0, 71)}…` : head;
}

const LIFE_EVENT_TYPES = new Set([
  'event:deploy',
  'event:big-commit',
  'event:test-recovery',
  'event:thrashing',
  'event:focus-flow',
  'event:interruption',
  'event:context-switch',
  'document:opened',
  'search:performed',
  // C1 (docs/audit/production-proposal-and-enhancements.md, fixes A§4.1) —
  // rare, discrete, already-self-gated-by-their-own-sensor events; a bare
  // type string in `lifeEvents` is enough context for the analysis prompt,
  // the same as the original nine above.
  'git:push',
  'git:pr-status',
  'calendar:context-event',
  'audio:device-changed',
  'clipboard:activity',
]);

interface ShellCommandPayload {
  command?: string;
  cwd?: string;
}

interface GitCommitPayload {
  branch?: string;
  cwd?: string;
}

interface GitStatusPayload {
  branch?: string;
  ahead?: number | null;
  cwd?: string;
}

interface CalendarActivePayload {
  event?: { title?: string; attendees?: string[] };
}

interface ScreenOcrPayload {
  topics?: string[];
  /** Named `screenText` (not `text`) so sanitize-at-ingest's OCR/sensitive-field handling covers it — this is the already-sanitized value by the time the rollup sees it. */
  screenText?: string;
}

interface SymbolEditedPayload {
  edits?: { file: string; symbols: string[] }[];
  totalSymbolCount?: number;
}

function appendCapped(list: string[], item: string, max: number): string[] {
  return [...list, item].slice(-max);
}

function withRollup(state: KernelState, patch: Partial<MomentRollup>) {
  const moment = state.moment;
  if (!moment) return { state, effects: [] };
  return { state: { ...state, moment: { ...moment, rollup: { ...moment.rollup, ...patch } } }, effects: [] };
}

/**
 * Tally a dev event's own `cwd` under the known root it resolves to — the
 * evidence `closeMoment`'s `git-activity` fallback attributes from, instead of
 * the ambient `state.project.current` pointer. A cwd that resolves under no
 * known root contributes nothing rather than guessing.
 */
function devActivityPatch(rollup: MomentRollup, known: KernelState['project']['known'], aliases: Record<string, string>, cwd: string | undefined): Partial<MomentRollup> {
  if (typeof cwd !== 'string' || cwd.length === 0) return {};
  const resolved = longestPrefixRoot(known, canonicalProjectRoot(cwd));
  if (!resolved) return {};
  // Honour the owner's alias map the same way the resolver's locator tiers do,
  // so dev activity inside an aliased checkout counts toward its declared project.
  const root = aliasedKnownRoot(known, resolved, aliases);
  const map = rollup.devActivityByProject ?? {};
  return { devActivityByProject: { ...map, [root]: (map[root] ?? 0) + 1 } };
}

/**
 * B4 (docs/audit/production-proposal-and-enhancements.md, fixes A§4.3) —
 * accumulates onto the currently-open moment's rollup as ITS OWN triggering
 * events arrive (shell commands, git commits, calendar activity, input
 * activity, derived life-events). No ordering constraint with `momentClose`
 * or any "runs before momentClose" rule: unlike those, this rule doesn't
 * read `state.moment` as "the about-to-close moment" on a shared
 * `window:changed` trigger — it just writes into whatever moment happens to
 * be open when one of ITS OWN event types fires, and life-event annotations
 * arrive via their own separate `EmitEvent`-triggered fold pass anyway (same
 * non-dependency as `entityExtract`/`contradictionCheck`).
 *
 * Before this, `MomentRollup` was frozen at `{processName, windowTitles}` —
 * the LLM analyzing a moment saw one window title and nothing else, even
 * though shell commands, git activity, calendar context, and life events
 * during that same span were all already sitting in the log.
 *
 * C1 (fixes A§4.1's "or (b) it joins the rollup" disposition) adds
 * `git:status` (feeds the same `gitBranch` field `git:commit` does),
 * `media:usage` (retired in W6 P17: `media:state` replaced it) and `symbol:edited`
 * (one summary line per batch) as their own branches, plus `git:push`/
 * `git:pr-status`/`calendar:context-event`/`audio:device-changed`/
 * `clipboard:activity` folded into the generic `lifeEvents` list alongside
 * the original nine life-event types.
 */
export const momentRollup: Rule = (state, event) => {
  if (!state.moment) return { state, effects: [] };
  const rollup = state.moment.rollup;

  if (event.type === 'shell:command') {
    const payload = event.payload as ShellCommandPayload;
    const command = typeof payload.command === 'string' ? payload.command : '';
    // Distinct: a loop that ran `pnpm test` nine times is one thing the moment
    // did, and nine identical lines would crowd out the other eight.
    const notable = command ? notableCommand(command) : null;
    const notableCommands = notable !== null && !rollup.notableCommands.includes(notable) ? appendCapped(rollup.notableCommands, notable, MAX_NOTABLE_COMMANDS) : rollup.notableCommands;
    return withRollup(state, { shellCommandCount: rollup.shellCommandCount + 1, notableCommands, ...devActivityPatch(rollup, state.project.known, state.config.projectAliases, payload.cwd) });
  }

  if (event.type === 'git:commit') {
    const payload = event.payload as GitCommitPayload;
    const branch = typeof payload.branch === 'string' ? payload.branch : rollup.gitBranch;
    return withRollup(state, { gitCommitCount: rollup.gitCommitCount + 1, gitBranch: branch, ...devActivityPatch(rollup, state.project.known, state.config.projectAliases, payload.cwd) });
  }

  // P2b — keep the calendar event's title + attendees (previously flattened
  // to a bare `calendarActive: true`), so `computeMomentKind`'s meeting truth
  // and the daily's Meetings section have real attendee/title data. Merged,
  // not overwritten with empties: a later `calendar:active` for the same
  // moment that happens to carry a thinner payload won't erase what an earlier
  // one captured.
  if (event.type === 'calendar:active') {
    const ev = (event.payload as CalendarActivePayload).event;
    const title = typeof ev?.title === 'string' && ev.title ? ev.title : rollup.meetingTitle;
    const attendees = Array.isArray(ev?.attendees) && ev.attendees.length > 0 ? ev.attendees.filter((a): a is string => typeof a === 'string') : rollup.meetingAttendees;
    return withRollup(state, { calendarActive: true, meetingTitle: title, meetingAttendees: attendees });
  }

  if (event.type === 'input:activity') {
    // `typingEventCount` keeps counting EMISSIONS (presence) for every existing
    // reader. The real counts the sensor has always sent are accumulated alongside
    // it, so a consumer can finally ask whether anyone was actually working rather
    // than only whether the daemon was watching.
    const payload = event.payload as { keyDownCount?: unknown; mouseClickCount?: unknown; windowMs?: unknown };
    const keys = typeof payload.keyDownCount === 'number' && payload.keyDownCount > 0 ? payload.keyDownCount : 0;
    const clicks = typeof payload.mouseClickCount === 'number' && payload.mouseClickCount > 0 ? payload.mouseClickCount : 0;
    const events = keys + clicks;
    // Credit the emission's own window, not a fixed constant — the sensor reports
    // `windowMs` per emission and it drifts (10021ms, 10009ms, 10007ms observed).
    const windowMs = typeof payload.windowMs === 'number' && payload.windowMs > 0 ? Math.min(payload.windowMs, 60_000) : 0;
    // W6 D1: never more attended time than the moment has been open. A 10-s
    // window that began before the moment did was credited whole, and 36% of
    // the record's moments ended with `activeMs` over their duration.
    const openMs = Math.max(0, Date.parse(event.ts) - Date.parse(state.moment.carriedFrom ?? state.moment.startTime));
    return withRollup(state, {
      typingEventCount: rollup.typingEventCount + 1,
      inputEventCount: rollup.inputEventCount + events,
      activeMs: Math.min(rollup.activeMs + (events > 0 ? windowMs : 0), Math.max(rollup.activeMs, openMs)),
    });
  }

  // C1 — `git:status` fires far more often than `git:commit` (every shell
  // command in a repo, not just commits) and often knows the branch when no
  // commit has happened yet this moment; shares the same `gitBranch` field
  // rather than adding a second one.
  if (event.type === 'git:status') {
    const payload = event.payload as GitStatusPayload;
    const branch = typeof payload.branch === 'string' ? payload.branch! : rollup.gitBranch;
    // `ahead` (commits made but not pushed) had a producer on all 15,120
    // `git:status` emissions and NO reader anywhere — captured at some cost and
    // then discarded, so nothing could ever answer "what have I not pushed".
    // Taking the maximum seen during the moment rather than the last value: the
    // moment's story is how much unpushed work it involved, and a `git push`
    // midway through resetting the counter to 0 should not erase that.
    const ahead = typeof payload.ahead === 'number' ? Math.max(rollup.unpushedCommits ?? 0, payload.ahead) : rollup.unpushedCommits;
    return withRollup(state, { gitBranch: branch, unpushedCommits: ahead, ...devActivityPatch(rollup, state.project.known, state.config.projectAliases, payload.cwd) });
  }

  /**
   * The sampled replacement for `media:usage`. Only CHANGES reach the log (the
   * ingest gate drops an identical sample), so every event here is a transition —
   * which is what makes a boolean sample usable as one.
   *
   * `micActive`/`cameraActive` stay sticky-true for the moment once seen, exactly as
   * the start/end version behaved: a moment that overlapped a call is a moment that
   * overlapped a call, even if the mic went quiet before it closed. The lifeEvents
   * marker is appended only if absent, so a call that toggles repeatedly does not
   * flood the capped list.
   */
  if (event.type === 'media:state') {
    const media = event.payload as { audioInput?: boolean; audioOutput?: boolean; camera?: boolean; audioOutputProcess?: string | null };
    const patch: Partial<MomentRollup> = {};
    let lifeEvents = rollup.lifeEvents;

    const note = (kind: string) => {
      const marker = `media:${kind}:on`;
      if (!lifeEvents.includes(marker)) lifeEvents = appendCapped(lifeEvents, marker, MAX_LIFE_EVENTS);
    };

    if (media.audioInput) {
      if (!rollup.micActive) patch.micActive = true;
      note('audio-input');
    }
    if (media.camera) {
      if (!rollup.cameraActive) patch.cameraActive = true;
      note('camera');
    }
    if (media.audioOutput) {
      note('audio-output');
      // C17 — sticky-true for the moment, like mic/camera. `audioApp` records the
      // app driving playback (the last non-empty output process), so a call can
      // be told from music from a video at close. A hidden/blank name is skipped
      // rather than stored as a wrong fact.
      if (!rollup.playbackActive) patch.playbackActive = true;
      const app = typeof media.audioOutputProcess === 'string' ? media.audioOutputProcess.trim() : '';
      if (app && !isRedactedPlaceholder(app)) patch.audioApp = app;
    }

    if (lifeEvents !== rollup.lifeEvents) patch.lifeEvents = lifeEvents;
    return Object.keys(patch).length > 0 ? withRollup(state, patch) : { state, effects: [] };
  }

  // W6 P17: the pre-cutover `media:usage` start/end branch went: the retired sensor's rows are all
  // gone from the log (0 on the record), so no replay needs it.

  // C1 — one summary line per file-change batch (already capped at 20 files
  // per event by the sensor itself), not one entry per edited symbol.
  if (event.type === 'symbol:edited') {
    const { edits, totalSymbolCount } = event.payload as SymbolEditedPayload;
    if (!edits || edits.length === 0) return { state, effects: [] };
    const summary = `symbol:edited (${totalSymbolCount ?? 0} symbols across ${edits.length} file${edits.length === 1 ? '' : 's'})`;
    // The names, not only the count: 13,000 file changes a week fed a hot-files
    // ring and nothing else, and the identifiers were the largest wasted signal.
    // They ride on the moment for the intent prompt and `gnomon_code_activity`;
    // they are NOT facts (that producer was retired the same day).
    const names = [...(rollup.symbolsEdited ?? [])];
    for (const edit of edits) for (const symbol of edit.symbols ?? []) {
      if (typeof symbol === 'string' && symbol.length >= MIN_SYMBOL_CHARS && !names.includes(symbol)) names.push(symbol);
    }
    return withRollup(state, { lifeEvents: appendCapped(rollup.lifeEvents, summary, MAX_LIFE_EVENTS), symbolsEdited: names.slice(-MAX_SYMBOLS_PER_MOMENT) });
  }

  // P7 — screen OCR (opt-in). Accumulate deduped topic tags; keep the most-recent salient line
  // as the excerpt (capped). The text is already sanitized at ingest, so this is a plain trim.
  if (event.type === 'browser:tab') {
    const payload = event.payload as { host?: string; path?: string };
    const host = typeof payload.host === 'string' ? payload.host : '';
    if (host === '') return { state, effects: [] };
    const path = typeof payload.path === 'string' && payload.path !== '/' ? payload.path : '';
    const page = `${host}${path}`.slice(0, 160);
    const pages = rollup.pages ?? [];
    if (pages.includes(page)) return { state, effects: [] };
    return withRollup(state, { pages: appendCapped(pages, page, MAX_PAGES) });
  }

  // J3.3: a local vision model's facts about the screen. Short, deduplicated, bounded.
  if (event.type === 'screen:fact') {
    const facts = (event.payload as { facts?: unknown }).facts;
    if (!Array.isArray(facts)) return { state, effects: [] };
    const clean = facts.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map((f) => f.trim().slice(0, 160));
    if (clean.length === 0) return { state, effects: [] };
    return withRollup(state, { screenFacts: [...new Set([...(rollup.screenFacts ?? []), ...clean])].slice(-MAX_SCREEN_FACTS) });
  }

  // J3.4: the page's own words, clipped — the last page read wins.
  if (event.type === 'page:text') {
    const text = (event.payload as { text?: unknown }).text;
    if (typeof text !== 'string' || text.trim() === '') return { state, effects: [] };
    return withRollup(state, { pageExcerpt: text.trim().slice(0, MAX_PAGE_EXCERPT_CHARS) });
  }

  if (event.type === 'screen:ocr') {
    const { topics, screenText } = event.payload as ScreenOcrPayload;
    const nextTopics = Array.isArray(topics)
      ? [...new Set([...rollup.screenTopics, ...topics.filter((t): t is string => typeof t === 'string' && t.length > 0)])].slice(-MAX_SCREEN_TOPICS)
      : rollup.screenTopics;
    // Skip a redacted excerpt ('[private]') so a sensitive-app capture never becomes the shown line.
    const usable = typeof screenText === 'string' && screenText.trim().length > 0 && screenText !== '[private]';
    // `screenTrack` (the rule before this one) has already decided which lines
    // of this capture are content; a capture that was ALL furniture and noise
    // leaves the previous excerpt standing rather than blanking it.
    const filtered = state.screen.eventId === event.id ? state.screen.kept : null;
    const excerptSource = filtered !== null ? filtered.join('\n') : usable ? screenText.trim() : '';
    const nextExcerpt = usable && excerptSource.length > 0 ? excerptSource.slice(0, MAX_SCREEN_EXCERPT_CHARS) : rollup.screenExcerpt;
    const refs = state.screen.eventId === event.id ? state.screen.refs ?? [] : [];
    const nextRefs = refs.length > 0 ? [...new Set([...(rollup.screenRefs ?? []), ...refs])].slice(-MAX_SCREEN_REFS_PER_MOMENT) : rollup.screenRefs;
    if (nextTopics === rollup.screenTopics && nextExcerpt === rollup.screenExcerpt && nextRefs === rollup.screenRefs) return { state, effects: [] };
    return withRollup(state, { screenTopics: nextTopics, screenExcerpt: nextExcerpt, ...(nextRefs !== undefined ? { screenRefs: nextRefs } : {}) });
  }

  if (event.type === 'audio:transcript') {
    const { spokenText, language } = event.payload as { spokenText?: unknown; language?: unknown };
    const said = typeof spokenText === 'string' ? spokenText.trim() : '';
    if (said === '' || said === '[private]') return { state, effects: [] };
    // The TAIL, not the head: the excerpt is bounded, and when a moment has
    // held a long conversation the most recent thing said is the part that
    // explains what the moment became. The screen excerpt keeps its own
    // most-recent-line rule for the same reason.
    const joined = rollup.spokenExcerpt ? `${rollup.spokenExcerpt} ${said}` : said;
    const nextExcerpt = joined.length > MAX_SPOKEN_EXCERPT_CHARS ? joined.slice(joined.length - MAX_SPOKEN_EXCERPT_CHARS) : joined;
    const languages = rollup.spokenLanguages ?? [];
    const nextLanguages =
      typeof language === 'string' && language !== '' && language !== 'unknown' && !languages.includes(language)
        ? [...languages, language].slice(-MAX_SPOKEN_LANGUAGES)
        : languages;
    return withRollup(state, { spokenExcerpt: nextExcerpt, spokenLanguages: nextLanguages });
  }

  if (event.type === 'git:pr-status') {
    // The state itself, not only the fact that a status arrived. `commitmentTrack`
    // reads this to tell an open PR under review from a merged one.
    const pr = event.payload as { number?: number; state?: string; reviewState?: string | null; branch?: string };
    const patch: Partial<MomentRollup> = { lifeEvents: appendCapped(rollup.lifeEvents, event.type, MAX_LIFE_EVENTS) };
    // Only the PR of THIS moment's branch. The sensor emits one event per
    // tracked repo in a single poll, so without this the last repo polled won a
    // moment on a different branch — and `commitmentTrack` reads the field as
    // "the PR of the branch I am tracking", which would have marked a live
    // branch merged (sticky, never un-set) from another repo's merge.
    const sameBranch = typeof pr.branch === 'string' && pr.branch !== '' && pr.branch === rollup.gitBranch;
    if (sameBranch && typeof pr.number === 'number' && typeof pr.state === 'string') {
      patch.pr = { number: pr.number, state: pr.state, reviewState: typeof pr.reviewState === 'string' ? pr.reviewState : null };
    }
    return withRollup(state, patch);
  }

  if (LIFE_EVENT_TYPES.has(event.type)) {
    return withRollup(state, { lifeEvents: appendCapped(rollup.lifeEvents, event.type, MAX_LIFE_EVENTS) });
  }

  return { state, effects: [] };
};
