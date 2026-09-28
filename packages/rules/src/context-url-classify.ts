import { deriveId } from '@sundial/helpers/derive-id.js';
import type { KernelState, Rule } from '@sundial/kernel/types.js';

type DocumentKind = 'jira-ticket' | 'github-pr' | 'github-issue' | 'linear' | 'asana' | 'notion' | 'confluence';
type SearchEngine = 'google' | 'ddg' | 'bing' | 'kagi';

/** Ported from WCS's `document-context/sensor.ts` tracker table. */
const TRACKER_PATTERNS: Array<{ kind: DocumentKind; pattern: RegExp }> = [
  { kind: 'jira-ticket', pattern: /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/ },
  { kind: 'github-pr', pattern: /github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/i },
  { kind: 'github-issue', pattern: /github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/i },
  { kind: 'linear', pattern: /linear\.app\/[^/\s]+\/issue\/([A-Z0-9]+-\d+)/i },
  { kind: 'asana', pattern: /app\.asana\.com\/\d\/\d+\/(\d+)/i },
  { kind: 'notion', pattern: /notion\.so\/[^/\s]*\/[^/\s]*-([a-f0-9]{32})/i },
  { kind: 'confluence', pattern: /\.atlassian\.net\/wiki\/spaces\/[^/]+\/pages\/(\d+)/i },
];

/** Ported from WCS's `packages/helpers/src/search-query.ts` TITLE_PATTERNS — includes the Dutch "Google Zoeken" variant. */
const SEARCH_TITLE_PATTERNS: Array<{ re: RegExp; engine: SearchEngine }> = [
  { re: /^(.+?) - Google Search(?: - .+)?$/i, engine: 'google' },
  { re: /^(.+?) - Google Zoeken(?: - .+)?$/i, engine: 'google' },
  { re: /^(.+?) - DuckDuckGo(?: - .+)?$/i, engine: 'ddg' },
  { re: /^(.+?) - Bing(?: - .+)?$/i, engine: 'bing' },
  { re: /^(.+?) - Kagi Search(?: - .+)?$/i, engine: 'kagi' },
];

const DOCUMENT_DEDUPE_MS = 5 * 60 * 1000;
const SEARCH_DEDUPE_MS = 30_000;

interface WindowChangedPayload {
  processName?: string;
  windowTitle?: string;
}

function extractTitle(text: string, marker: string): string | undefined {
  const i = text.indexOf(marker);
  if (i < 0) return undefined;
  const after = text
    .slice(i + marker.length)
    .replace(/^[\s\-:|—–]+/, '')
    .trim();
  if (!after) return undefined;
  return after.length > 120 ? after.slice(0, 117) + '…' : after;
}

function matchTracker(windowTitle: string): { kind: DocumentKind; id: string; title?: string } | null {
  for (const { kind, pattern } of TRACKER_PATTERNS) {
    const m = pattern.exec(windowTitle);
    if (m?.[1]) return { kind, id: m[1], title: extractTitle(windowTitle, m[0]) };
  }
  return null;
}

function matchSearch(windowTitle: string): { engine: SearchEngine; query: string } | null {
  for (const { re, engine } of SEARCH_TITLE_PATTERNS) {
    const m = windowTitle.match(re);
    if (m?.[1]) return { engine, query: m[1].trim() };
  }
  return null;
}

function isDebounced(state: KernelState, key: string, ts: string, windowMs: number): boolean {
  const last = state.pending.debounces[key];
  if (!last) return false;
  return Date.parse(ts) - Date.parse(last) < windowMs;
}

// A§1.4 — nothing ever deleted a `pending.debounces` key before this: every
// distinct document/search key ever seen accumulated forever (~36k/year for
// a moderately active user, per the production audit). `DOCUMENT_DEDUPE_MS`
// is the larger of this rule's two windows, so evicting anything older than
// it also covers every `search:*` key that's fallen out of its own (shorter)
// window — the map stays bounded by "keys touched recently," not "keys ever
// touched."
function withDebounce(debounces: Record<string, string>, key: string, ts: string): Record<string, string> {
  const cutoff = Date.parse(ts) - DOCUMENT_DEDUPE_MS;
  const next: Record<string, string> = { [key]: ts };
  for (const [k, v] of Object.entries(debounces)) {
    if (k !== key && Date.parse(v) >= cutoff) next[k] = v;
  }
  return next;
}

/**
 * Merges WCS's `document-context` and `search-query` sensors into one rule
 * (Gap 1's resolution, docs/phase-3-implementation-plan.md) — neither had a
 * natural sidecar writer in Gnomon (both read a `context:captured` sidecar
 * WCS's intent analyzer produced, which Gnomon doesn't have), but both are
 * pure classifications of `window:changed`'s already-available `windowTitle`
 * — a rule, not a sensor. Tracker patterns checked first (first-match-wins,
 * mutually exclusive with search patterns): a ticket-shaped title takes
 * priority over a coincidental search-engine-shaped one.
 *
 * Gnomon's `window:changed` carries no separate URL field (unlike WCS's
 * `context:captured`, which came from an LSP/browser-URL integration Gnomon
 * doesn't have) — classification here is title-only. `github-pr`/
 * `github-issue`/`linear`/`asana`/`notion`/`confluence` patterns match
 * literal URL text, so they'll only fire when a browser's window title
 * happens to embed the URL directly; that's a real, honest precision loss
 * versus WCS, not a bug — most of these will only fire for `jira-ticket`
 * (ID-shaped, appears in titles directly) until a URL-carrying signal exists.
 *
 * Dedup uses the existing `state.pending.debounces` map (no new state slice
 * needed) — `docUrl:${kind}:${id}` for 5min, `search:${engine}:${query}`
 * for 30s, matching WCS's windows exactly.
 */
export const contextUrlClassify: Rule = (state, event) => {
  if (event.type !== 'window:changed') return { state, effects: [] };

  const payload = event.payload as WindowChangedPayload;
  const windowTitle = typeof payload.windowTitle === 'string' ? payload.windowTitle : '';
  const processName = typeof payload.processName === 'string' ? payload.processName : undefined;
  if (!windowTitle) return { state, effects: [] };

  const tracker = matchTracker(windowTitle);
  if (tracker) {
    const key = `docUrl:${tracker.kind}:${tracker.id}`;
    if (isDebounced(state, key, event.ts, DOCUMENT_DEDUPE_MS)) return { state, effects: [] };

    return {
      state: { ...state, pending: { ...state.pending, debounces: withDebounce(state.pending.debounces, key, event.ts) } },
      effects: [
        {
          type: 'EmitEvent',
          event: {
            id: deriveId(event.ts, event.id, 'context-url-classify', 'document', key),
            type: 'document:opened',
            ts: event.ts,
            payload: { timestamp: event.ts, kind: tracker.kind, id: tracker.id, title: tracker.title ?? null, sourceApp: processName ?? null },
          },
        },
      ],
    };
  }

  const search = matchSearch(windowTitle);
  if (search) {
    const key = `search:${search.engine}:${search.query.toLowerCase()}`;
    if (isDebounced(state, key, event.ts, SEARCH_DEDUPE_MS)) return { state, effects: [] };

    return {
      state: { ...state, pending: { ...state.pending, debounces: withDebounce(state.pending.debounces, key, event.ts) } },
      effects: [
        {
          type: 'EmitEvent',
          event: {
            id: deriveId(event.ts, event.id, 'context-url-classify', 'search', key),
            type: 'search:performed',
            ts: event.ts,
            payload: { timestamp: event.ts, engine: search.engine, query: search.query, host: `${search.engine}.search`, source: 'title', processName: processName ?? null },
          },
        },
      ],
    };
  }

  return { state, effects: [] };
};
