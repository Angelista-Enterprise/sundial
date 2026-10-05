// W5 step 2: a circuit breaker per model route.
import type { LlmRouteReliability, Rule } from '@sundial/kernel/types.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { healthCandidate } from './sensor-health.js';

/** Failed calls in a row on one route that open its breaker. */
export const BREAKER_FAILURES = 10;
/** While open, one half-open probe per this long. */
export const BREAKER_PROBE_MS = 2 * 60_000;
/** A 429 with no `Retry-After` cools background calls on its route for this, doubling per 429 in a row up to `RATE_LIMIT_MAX_MS`. */
export const RATE_LIMIT_BASE_MS = 5_000;
export const RATE_LIMIT_MAX_MS = 2 * 60_000;
/** Routes kept (the least recently used goes): a bound, not a policy. */
const MAX_ROUTES = 16;
const DAYS = 7;

const closed = (): LlmRouteReliability => ({ streak: 0, openedAt: null, openUntil: null, days: [] });
const later = (ts: string, ms: number) => new Date(Date.parse(ts) + ms).toISOString();

function count(r: LlmRouteReliability, day: string, field: 'calls' | 'failed'): LlmRouteReliability['days'] {
  const last = r.days[r.days.length - 1];
  const days = last?.day === day ? r.days.slice(0, -1) : r.days;
  const today = last?.day === day ? last : { day, calls: 0, failed: 0 };
  return [...days, { ...today, [field]: today[field] + 1 }].slice(-DAYS);
}

/**
 * The single writer of `state.reliability`. Folds `llm:dispatched {route}`
 * (a call reserved; `probe` marks the half-open one), `llm:failed {route,
 * errorClass}` and `llm:recovered {route}` (the first success after a
 * failure). After `BREAKER_FAILURES` failures in a row the breaker opens:
 * `openUntil` tells `reserveLlmCall` to refuse the route until then, one
 * probe goes through after it, and a failed probe holds it open another
 * `BREAKER_PROBE_MS`. A success closes it. The opening is said once, as a
 * `sensor-health` notice. A cancelled call (the owner pressed stop) is not
 * the route failing. A dispatch without a route (every one before W5) is
 * not counted, so the record replays unchanged. A 429 (`rate-limit`) is the
 * provider asking to slow down, not failing: it leaves the streak alone and
 * sets `cooldownUntil` (its `retryAfterMs`, else 5 s doubling to 2 min), which
 * holds background reservations and never the chat's.
 */
export const llmReliability: Rule = (state, event) => {
  const t = event.type;
  if (t !== 'llm:dispatched' && t !== 'llm:failed' && t !== 'llm:recovered') return { state, effects: [] };
  const p = (event.payload ?? {}) as { route?: unknown; probe?: unknown; errorClass?: unknown; retryAfterMs?: unknown };
  if (typeof p.route !== 'string' || p.route === '') return { state, effects: [] };
  const route = p.route;
  const ts = event.ts;
  const prior = state.reliability?.llm?.[route] ?? closed();
  let r = prior;
  const effects: ReturnType<Rule>['effects'] = [];
  if (t === 'llm:dispatched') {
    r = { ...r, days: count(r, localDate(ts, state.config.timezone), 'calls') };
    // The probe holds the route while it is in flight: one probe, not one per caller.
    if (p.probe === true && r.openedAt !== null) r = { ...r, openUntil: later(ts, BREAKER_PROBE_MS) };
  } else if (t === 'llm:recovered') r = { ...r, streak: 0, openedAt: null, openUntil: null, rateLimited: 0 };
  else if (p.errorClass === 'rate-limit') {
    const k = r.rateLimited ?? 0;
    const wait = typeof p.retryAfterMs === 'number' && p.retryAfterMs >= 0 ? p.retryAfterMs : Math.min(RATE_LIMIT_MAX_MS, RATE_LIMIT_BASE_MS * 2 ** k);
    r = { ...r, rateLimited: k + 1, cooldownUntil: later(ts, wait), days: count(r, localDate(ts, state.config.timezone), 'failed') };
  } else if (p.errorClass !== 'cancelled') {
    // Row 2 is the run the breaker let through: a failed probe (or a retry still in flight) after it opened is the breaker working, not the run.
    r = { ...r, streak: r.streak + 1, longestClosed: r.openedAt === null ? Math.max(r.longestClosed ?? 0, r.streak + 1) : (r.longestClosed ?? 0), days: count(r, localDate(ts, state.config.timezone), 'failed') };
    if (r.openedAt !== null) r = { ...r, openUntil: later(ts, BREAKER_PROBE_MS) };
    else if (r.streak >= BREAKER_FAILURES) {
      r = { ...r, openedAt: ts, openUntil: later(ts, BREAKER_PROBE_MS) };
      effects.push(
        healthCandidate(state, ts, event.id, `llm-breaker:${route}`, ts, `The model route "${route}" failed ${r.streak} calls in a row, so Sundial has paused calls to it. It tries one call every 2 minutes and resumes when one works.`, [
          `${r.streak} failures in a row`,
          ...(typeof p.errorClass === 'string' ? [`last: ${p.errorClass}`] : []),
        ]),
      );
    }
  }
  if (r === prior) return { state, effects };
  const others = Object.entries(state.reliability?.llm ?? {}).filter(([k]) => k !== route);
  const kept = others.length >= MAX_ROUTES ? others.sort(([, a], [, b]) => (a.days.at(-1)?.day ?? '').localeCompare(b.days.at(-1)?.day ?? '')).slice(1) : others;
  return { state: { ...state, reliability: { ...state.reliability, llm: { ...Object.fromEntries(kept), [route]: r } } }, effects };
};
