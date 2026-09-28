// `hostOf` comes from helpers, beside `isConferencingHost`: the rule matcher
// and this proposer must agree on what a host is, or a rule fails to fire on
// the very windows the proposer offered it for.
import { cleanWindowTitle, hostOf, isBrowser, isConferencingSurface, isSystemProcess, hostFromTitle } from '@sundial/helpers/window-classification.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { sanitizeProjectRule } from '@sundial/helpers/sundial-config.js';
import type { AttributionCandidate, KernelState, Rule } from '@sundial/kernel/types.js';

/**
 * Gathering the time no rule could place, so the owner can be asked what it was.
 *
 * `resolveAttribution` refuses to guess (decisions/no-ambient-project-
 * attribution). That leaves a residue — hosts and apps that take real time and
 * match nothing — and until this rule the residue was only visible as one
 * "unattributed" row. On 2026-09-07 that row held 1h44m, of which 71 minutes
 * carried puzzles titles in the moments' own rollups; a further 50 minutes sat
 * on hosts no rule named at all (`acme.atlassian.net` while the rule said
 * `newsweb-daily.atlassian.net`; `playerone.web.app`; `tango.com`).
 *
 * WHY PER FOCUS PERIOD, NOT PER MOMENT. A moment under 20s is dropped and its
 * titles folded into the next moment, which keeps its own project — 156 of the
 * 175 puzzles-matching focus periods that day were under 20s. Timing every
 * `window:changed` here, independent of the moment lifecycle, is what lets 156
 * twelve-second visits add up to one candidate.
 *
 * WHAT IT NEVER DOES: attribute anything. It times, and it lets the owner
 * decide. Accepting a proposal arrives as `attribution:rule-decided`, and THAT
 * is when `state.config.projectRules` grows — the same ProjectRule the route
 * wrote to config.json — so the rule applies to the next window, not the next
 * boot.
 */

/** One focus period counts at most this much: a window left open over lunch is not evidence of work on it. */
export const MAX_DWELL_MS = 10 * 60 * 1000;
/** A candidate not seen this long is forgotten; a proposal about last month is noise. */
export const CANDIDATE_TTL_MS = 21 * 24 * 60 * 60 * 1000;
/**
 * Places timed at once. The TTL alone bounded this only by how many distinct
 * hosts three weeks of browsing touches — 161 on the live record after two —
 * and the whole map is shallow-copied on every `window:changed` and serialised
 * into every snapshot. The smallest goes first: a place with seconds on it is
 * the one worth proposing.
 */
export const MAX_CANDIDATES = 300;
export const MAX_TITLES = 6;
/** Distinguishable parts kept per place. Enough to tell three projects apart under one host, not a browsing history. */
export const MAX_PARTS = 8;
/** A part under a second is a redirect, not a place. */
const MIN_PART_MS = 1000;
export const MAX_DAYS = 14;
const usable = (s: unknown): s is string => typeof s === 'string' && s !== '' && s !== '[private]' && s !== '[hidden]';

/**
 * The path under a host, query and fragment REMOVED, at most two segments.
 *
 * The query is where the noise is: `?node-id=1-2`, `?q=koningsdag`,
 * `&authuser=0` differ on every visit, so keeping them would make every visit
 * its own part. Two segments is the depth that separates projects without
 * separating pages — `localhost:8080/puzzlez/scrypto` is one project's work,
 * `/puzzlez/scrypto/2026/07/25` is one page of it.
 */
/**
 * Whether a path segment identifies something to a machine but nothing to a
 * person: `figma.com/file/PjKq2xR9mVb3nT` names one file, and no owner can read
 * which project that is. When the path is opaque the TITLE is the discriminator
 * — "Dr. Denker - DVHN app updates" versus "Puzzel app" — so the part is taken
 * from there instead, and the rule that follows matches on the title.
 */
export function isOpaqueSegment(segment: string): boolean {
  if (segment.length >= 20) return true;
  const hasDigit = /\d/.test(segment);
  const hasLetter = /[a-z]/i.test(segment);
  if (segment.length >= 10 && hasDigit && hasLetter) return true;
  // A generated code: three or more short letter groups joined by dashes,
  // which is what a meeting link and a share slug look like.
  if (/^[a-z]{3,5}(-[a-z]{3,5}){2,}$/i.test(segment)) return true;
  return /^[0-9a-f]{12,}$/i.test(segment);
}

export function pathOf(url: string): string | null {
  const m = /^https?:\/\/[^/?#\s]+([^?#\s]*)/i.exec(url);
  const raw = m?.[1] ?? '';
  const segments = raw.split('/').filter((seg) => seg !== '');
  if (segments.length === 0) return null;
  const kept = segments.slice(0, 2);
  // An opaque segment makes the whole path unreadable as a project name.
  if (kept.some(isOpaqueSegment)) return null;
  return `/${kept.join('/')}`;
}


interface Payload {
  processName?: string;
  windowTitle?: string;
  documentPath?: string | null;
}

/** A place the owner has already called shared work (Slack, Meet, the org vault) is not proposed. */
function isSharedPlace(state: KernelState, key: string): boolean {
  const shared = state.config.sharedPlaces ?? [];
  if (shared.length === 0) return false;
  const bare = key.replace(/^host:/, '');
  return shared.some((entry: string) => entry.toLowerCase() === bare.toLowerCase() || entry.toLowerCase() === key.toLowerCase());
}

/** Where the new window is, as a candidate key — or null when it is nowhere worth timing. */
export interface PlaceCandidate {
  key: string;
  kind: 'host' | 'app';
  label: string;
  /** The window title without its app furniture. Kept as evidence whatever the part turned out to be. */
  cleanTitle: string | null;
  /**
   * The distinguishable part of this visit, and what a rule for it would match
   * on: the calendar event running in a call window, the URL path when it reads
   * as a place, else the cleaned window title.
   */
  part: { kind: 'path' | 'title' | 'meeting'; label: string } | null;
}

export function candidateFor(state: KernelState, p: Payload): PlaceCandidate | null {
  if (state.window.attribution.projectId !== null) return null;
  const processName = typeof p.processName === 'string' ? p.processName : '';
  if (processName === '' || isSystemProcess(processName)) return null;
  const doc = typeof p.documentPath === 'string' ? p.documentPath : '';
  const title = typeof p.windowTitle === 'string' ? p.windowTitle : '';
  const host = (doc !== '' ? hostOf(doc) : null) ?? (isBrowser(processName) && usable(title) ? hostFromTitle(title) : null);
  const clean = usable(title) ? cleanWindowTitle(title, processName) : '';
  // A CALL is timed by the meeting the calendar says is running in it, whatever
  // the window says. `Meet - uth-mkip-zwx` names no project and never will; the
  // event title is the only thing that can, and a rule can now match on it.
  const meeting = state.schedule.active?.title ?? null;
  if (isConferencingSurface(processName, host)) {
    // The meeting, or nothing. A call window's own title is a joining code, so
    // with no event running there is nothing here a rule could ever name.
    const label = host ?? processName;
    return {
      key: host !== null ? `host:${host}` : `app:${processName}`,
      kind: host !== null ? 'host' : 'app',
      label,
      cleanTitle: clean === '' ? null : clean,
      part: usable(meeting) ? { kind: 'meeting', label: meeting } : null,
    };
  }
  if (host !== null) {
    // The path first, when it reads as a place. An opaque one — a file id, a
    // share slug — says nothing to the owner, so the title takes over: that is
    // what separates one Figma file from another.
    const path = doc !== '' ? pathOf(doc) : null;
    const part = path !== null ? ({ kind: 'path', label: path } as const) : clean !== '' ? ({ kind: 'title', label: clean } as const) : null;
    return { key: `host:${host}`, kind: 'host', label: host, cleanTitle: clean === '' ? null : clean, part };
  }
  // A browser with no page is a browser between pages: nothing to name.
  if (isBrowser(processName)) return null;
  return { key: `app:${processName}`, kind: 'app', label: processName, cleanTitle: clean === '' ? null : clean, part: clean === '' ? null : { kind: 'title', label: clean } };
}

/** Fold one visit's dwell into the parts map, evicting the smallest when full. */
function withPart(
  parts: NonNullable<AttributionCandidate['parts']>,
  part: { kind: 'path' | 'title' | 'meeting'; label: string } | null,
  dwellMs: number,
): NonNullable<AttributionCandidate['parts']> {
  if (part === null || dwellMs < MIN_PART_MS) return parts;
  const key = `${part.kind}:${part.label}`;
  const prev = parts[key];
  const next = { ...parts, [key]: { kind: part.kind, label: part.label, seconds: (prev?.seconds ?? 0) + dwellMs / 1000, visits: (prev?.visits ?? 0) + 1 } };
  if (Object.keys(next).length <= MAX_PARTS) return next;
  // Room is made among the ESTABLISHED parts, never by dropping the one just
  // added. Evicting the global smallest evicted the newcomer every time, so a
  // new Figma file under a busy host could never accumulate a second visit —
  // its time kept inflating the host's undifferentiated total instead.
  const others = Object.keys(next).filter((k) => k !== key);
  if (others.length === 0) return next;
  const smallest = others.reduce((a, b) => (next[a]!.seconds <= next[b]!.seconds ? a : b));
  delete next[smallest];
  return next;
}

function pushBounded(list: string[], value: string, max: number): string[] {
  if (list.includes(value)) return list;
  return [...list, value].slice(-max);
}

/** Close the period being timed: add its dwell to the candidate, unless the owner already decided about that key. */
function settleWatching(state: KernelState, ts: string): KernelState['attributionProposals']['candidates'] {
  const ap = state.attributionProposals;
  const w = ap.watching;
  if (w === null || ap.decided[w.key] !== undefined) return ap.candidates;
  const dwellMs = Math.min(MAX_DWELL_MS, Math.max(0, Date.parse(ts) - Date.parse(w.since)));
  if (!(dwellMs > 0)) return ap.candidates;
  const day = localDate(ts, state.config.timezone);
  const prev: AttributionCandidate | undefined = ap.candidates[w.key];
  const next: AttributionCandidate = {
    key: w.key,
    kind: w.kind,
    label: w.label,
    processName: w.processName,
    parts: withPart(prev?.parts ?? {}, w.part ?? null, dwellMs),
    seconds: (prev?.seconds ?? 0) + dwellMs / 1000,
    visits: (prev?.visits ?? 0) + 1,
    days: pushBounded(prev?.days ?? [], day, MAX_DAYS),
    titles: w.title !== null ? pushBounded(prev?.titles ?? [], w.title, MAX_TITLES) : prev?.titles ?? [],
    firstSeenAt: prev?.firstSeenAt ?? w.since,
    lastSeenAt: ts,
  };
  const candidates: Record<string, AttributionCandidate> = { ...ap.candidates, [w.key]: next };
  // Forgetting is done here, on the write, so a quiet system holds no timer.
  const cutoff = Date.parse(ts) - CANDIDATE_TTL_MS;
  for (const [key, c] of Object.entries(candidates)) if (Date.parse(c.lastSeenAt) < cutoff) delete candidates[key];
  // Then the cap, never taking the place just timed — the same rule `withPart`
  // follows, and for the same reason: evicting the newcomer means a new place
  // can never accumulate a second visit.
  let keys = Object.keys(candidates);
  while (keys.length > MAX_CANDIDATES) {
    const others = keys.filter((k) => k !== w.key);
    if (others.length === 0) break;
    const smallest = others.reduce((a, b) => (candidates[a]!.seconds <= candidates[b]!.seconds ? a : b));
    delete candidates[smallest];
    keys = Object.keys(candidates);
  }
  return candidates;
}

export const attributionPropose: Rule = (state, event) => {
  if (event.type === 'window:changed') {
    const candidates = settleWatching(state, event.ts);
    const p = event.payload as Payload;
    const next = candidateFor(state, p);
    // The cleaned title comes back on the candidate, so `cleanWindowTitle` runs
    // once per window change rather than twice.
    const title = next?.cleanTitle ?? null;
    const watching =
      next === null || state.attributionProposals.decided[next.key] !== undefined || isSharedPlace(state, next.key)
        ? null
        : { ...next, processName: typeof p.processName === 'string' ? p.processName : '', since: event.ts, title: title === '' ? null : title };
    return { state: { ...state, attributionProposals: { ...state.attributionProposals, candidates, watching } }, effects: [] };
  }

  if (event.type === 'attribution:rule-decided') {
    const payload = event.payload as { key?: unknown; decision?: unknown; project?: unknown; rule?: unknown; partKey?: unknown };
    const key = typeof payload.key === 'string' ? payload.key.trim() : '';
    // `shared` and `personal` are decisions too: a place can be work that is
    // not one project (Slack, Meet), or not work at all (Spotify). Both stop it
    // being proposed; neither invents a project for it.
    const DECISIONS = ['assigned', 'ignored', 'shared', 'personal', 'ambient'] as const;
    const decision = (DECISIONS as readonly string[]).includes(payload.decision as string) ? (payload.decision as (typeof DECISIONS)[number]) : null;
    if (key === '' || decision === null) return { state, effects: [] };
    const project = typeof payload.project === 'string' && payload.project.trim() !== '' ? payload.project.trim() : null;
    const partKey = typeof payload.partKey === 'string' && payload.partKey.trim() !== '' ? payload.partKey.trim() : null;
    const ap = state.attributionProposals;
    const candidates = { ...ap.candidates };
    // A PART was named, not the whole place: figma.com is Northwind on one file and
    // Puzzles on another, so the new rule takes that path and the rest of the
    // host keeps accumulating. Marking the whole key decided here would blind
    // the timer to every other project sharing the host.
    const scopedToPart = partKey !== null && decision === 'assigned' && candidates[key]?.parts?.[partKey] !== undefined;
    if (scopedToPart) {
      const existing = candidates[key]!;
      const parts = { ...(existing.parts ?? {}) };
      const removed = parts[partKey]!;
      delete parts[partKey];
      candidates[key] = { ...existing, parts, seconds: Math.max(0, existing.seconds - removed.seconds), visits: Math.max(0, existing.visits - removed.visits) };
    } else {
      delete candidates[key];
    }
    const watching = ap.watching?.key === key && !scopedToPart ? null : ap.watching;
    const decided: KernelState['attributionProposals']['decided'] = scopedToPart ? ap.decided : { ...ap.decided, [key]: { decision, project, at: event.ts } };
    // A shared place joins config the same way a rule does, so it applies to
    // the next window rather than the next boot.
    const bare = key.replace(/^host:/, '');
    const sharedNow = decision === 'shared' && !(state.config.sharedPlaces ?? []).some((e) => e.toLowerCase() === bare.toLowerCase()) ? [...(state.config.sharedPlaces ?? []), bare] : null;
    // The ONE validator, shared with config.json's parser and the web route:
    // the copy that used to live here did not know `meetingContains`, so an
    // accepted meeting rule reached disk and was dropped from the live fold.
    const rule = decision === 'assigned' ? sanitizeProjectRule(payload.rule) : null;
    const rules = state.config.projectRules;
    const already = rule !== null && rules.some((r) => JSON.stringify(r) === JSON.stringify(rule));
    const withRule = rule !== null && !already ? { ...state.config, projectRules: [...rules, rule] } : state.config;
    const config = sharedNow !== null ? { ...withRule, sharedPlaces: sharedNow } : withRule;
    return { state: { ...state, attributionProposals: { watching, candidates, decided }, config }, effects: [] };
  }

  return { state, effects: [] };
};
