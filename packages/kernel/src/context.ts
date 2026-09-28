import { findEntitiesByName, getCurrentEntityFacts, getMomentsForDate, scoredSearch, type ScoredSearchHit } from '@sundial/db/index.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js';
import { loadLatestSnapshot } from './snapshot.js';

const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'who', 'when', 'where', 'why', 'how', 'did', 'do', 'does', 'on', 'in', 'at', 'to', 'of', 'for', 'with', 'and', 'or', 'my', 'me']);

/** Cheap `findEntitiesByName` candidates from a free-text question — every token is a `LIKE` scan, so filtering stopwords/short tokens keeps this from firing on every word of a long question. */
function extractQueryTokens(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
  return Array.from(new Set(tokens));
}

/**
 * Resolutions before the assistant's acceptance rate is worth stating.
 *
 * Matches `assistantAcceptanceRate`'s own floor. A rate computed from two
 * resolutions is noise wearing a percentage, and putting it in a prompt would have
 * the model calibrate itself against nothing.
 */
const MIN_RESOLVED_FOR_RATE = 10;

export interface BuildContextOptions {
  limit?: number;
  now?: string;
}

export interface ContextTraceStep {
  step: string;
  ms: number;
  detail: string;
}

export interface ContextBuildResult {
  lines: string[];
  /** The top-K scored hits themselves (not just their `.text`) — `/ask`'s "sources" list, docs/design/06-macos-ui-data-wiring.md's Ask-page trace. */
  hits: ScoredSearchHit[];
  trace: ContextTraceStep[];
}

/**
 * D3 (docs/audit/production-proposal-and-enhancements.md, fixes A§4.5, A§5.2,
 * A§5.3) — one shared context-assembly function for `gnomon ask` (and a
 * future MCP `gnomon_ask`), rather than each caller building its own. Lives
 * in `@sundial/kernel` (not `@sundial/db`, where `scoredSearch` lives, and not
 * `@sundial/memory`, which doesn't have a DB dependency) because it's the
 * only package that already depends on both `@sundial/db` (search/entities/
 * moments) and needs `loadLatestSnapshot` (kernel-local) for "what's the
 * user doing right now" — both CLI and MCP already depend on `@sundial/kernel`
 * for the latter, so this doesn't add a new dependency edge for either.
 *
 * Four layers, in the order the proposal names them:
 * 1. Top-K scored hits (moments, knowledge entries, and — new as of D3 —
 *    entity facts, since `contradictionCheck` now embeds them too).
 * 2. Current facts for entities named in the query itself — a cheap
 *    heuristic (token → `findEntitiesByName`), not semantic matching, so a
 *    question like "who am I working with on gnomon" pulls gnomon's facts
 *    even if no moment/knowledge-entry embedding happens to rank it highly.
 * 3. Today's summary line — cheap orientation the LLM wouldn't otherwise
 *    have (a question asked at 9am shouldn't need a top-K hit to know
 *    "today" has barely started).
 * 4. Current context — the live snapshot's active window/project, so "what
 *    am I doing" has an answer even when nothing about the current moment
 *    has been embedded yet (it's still open, not yet closed).
 *
 * `buildContextWithTrace` is the instrumented form the daemon's `/ask` route
 * uses for its "HOW THIS WAS ANSWERED" trace (docs/design/06-macos-ui-data-wiring.md)
 * — same four layers, but timed and returning the structured search hits
 * (`sources`) instead of just their flattened text. `buildContext` stays a
 * thin wrapper so its existing callers (the CLI's `askDirect`, `POST
 * /context`) are unaffected; layers 3-4 are timed together as "packContext"
 * since neither is expensive enough on its own to warrant a separate step.
 */
export async function buildContextWithTrace(query: string, options?: BuildContextOptions): Promise<ContextBuildResult> {
  const now = options?.now ?? new Date().toISOString();
  const lines: string[] = [];
  const trace: ContextTraceStep[] = [];

  const searchStart = Date.now();
  const hits = await scoredSearch(query, options?.limit ?? 8, now);
  lines.push(...hits.map((hit) => hit.text));
  trace.push({ step: 'scoredSearch', ms: Date.now() - searchStart, detail: `${hits.length} hit${hits.length === 1 ? '' : 's'}` });

  const entityStart = Date.now();
  const seenEntityIds = new Set<string>();
  let factCount = 0;
  for (const token of extractQueryTokens(query)) {
    const matches = await findEntitiesByName(token);
    for (const entity of matches) {
      if (seenEntityIds.has(entity.id)) continue;
      seenEntityIds.add(entity.id);
      const facts = await getCurrentEntityFacts(entity.id);
      for (const fact of facts) {
        lines.push(`${entity.canonicalName} ${fact.predicate} ${fact.object}`);
        factCount++;
      }
    }
  }
  trace.push({ step: 'entityLookup', ms: Date.now() - entityStart, detail: `${seenEntityIds.size} entit${seenEntityIds.size === 1 ? 'y' : 'ies'}, ${factCount} fact${factCount === 1 ? '' : 's'}` });

  const packStart = Date.now();
  // The owner's local day. `now.slice(0, 10)` is a UTC day, which put the boundary
  // at 02:00 in Amsterdam and made "today's moments" start mid-night. Read from
  // config rather than `state` because this is a read path, not a rule — it already
  // does I/O, so it has no purity to preserve.
  const timeZone = loadSundialConfig().timezone;
  const todaysMoments = await getMomentsForDate(localDate(now, timeZone), timeZone);
  if (todaysMoments.length > 0) {
    const totalMinutes = Math.round(todaysMoments.reduce((sum, moment) => sum + moment.durationMs, 0) / 60_000);
    const activeMinutes = Math.round(todaysMoments.reduce((sum, moment) => sum + (typeof moment.data.activeMs === 'number' ? moment.data.activeMs : 0), 0) / 60_000);
    const mostRecent = todaysMoments[todaysMoments.length - 1];
    lines.push(`Today so far: ${todaysMoments.length} activity session(s), about ${totalMinutes}m tracked${activeMinutes > 0 ? ` (${activeMinutes}m with hands on keyboard or mouse)` : ''}, most recently in ${mostRecent.processName}.`);
  }

  const snapshot = await loadLatestSnapshot();
  const active = snapshot?.state.window.active;
  if (active) {
    const project = snapshot!.state.project.current?.name;
    lines.push(`Right now: ${active.processName}${active.windowTitle ? ` — ${active.windowTitle}` : ''}${project ? ` (project: ${project})` : ''}.`);
  }

  // The assistant's own track record, so an answer can be calibrated by how often
  // this assistant has actually been right rather than by how fluent it sounds.
  //
  // A COUNT, not an inference, which is the reason this one is safe to state and
  // `state.routines` is not: proposals accepted over proposals resolved is arithmetic
  // over the owner's own verdicts. `assistantAcceptanceRate` returns null below ten
  // resolutions and nothing is said in that case — the same refuse-to-report-a-rate
  // -from-a-small-sample discipline the claims registry uses.
  const assistant = snapshot?.state.assistant;
  if (assistant) {
    const resolved = assistant.acceptedCount + assistant.rejectedCount;
    if (resolved >= MIN_RESOLVED_FOR_RATE) {
      const rate = Math.round((100 * assistant.acceptedCount) / resolved);
      lines.push(`Your track record with this owner: ${assistant.acceptedCount} of ${resolved} proposals accepted (${rate}%). Weigh your confidence accordingly.`);
    }
  }
  trace.push({ step: 'packContext', ms: Date.now() - packStart, detail: `${lines.length} line${lines.length === 1 ? '' : 's'} packed` });

  return { lines, hits, trace };
}

export async function buildContext(query: string, options?: BuildContextOptions): Promise<string[]> {
  return (await buildContextWithTrace(query, options)).lines;
}
