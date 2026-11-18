// S6 (owner decision 2026-11-17): offer help with what the owner is doing right now. Every other producer needs days of
// record (an expectation, a promise, a chore, a stuck sign), so a fresh record never had a candidate at all. This one needs
// one window held for a few minutes: on a clock tick it puts that context to the model once, under its own purpose and
// budget, and an answer other than "none" becomes an ordinary `offer-now` candidate for the notice gate to weigh.
import { deriveId } from '@sundial/helpers/derive-id.js';
import { formatClock, localDate } from '@sundial/helpers/local-day.js';
import { isRedactedPlaceholder } from '@sundial/helpers/redact/redact-policy.js';
import { DEFAULT_PRIVATE_HOSTS } from '@sundial/helpers/privacy-config.js';
import { resolveDailyCaps } from '@sundial/kernel/budgets.js';
import { habituatedGain, OFFER_KIND as GATE_OFFER_KIND, phasicBarFor, policyForBias } from '@sundial/kernel/gate.js';
import { isQuieted } from '@sundial/kernel/notice-groups.js';
import type { ChatMessage, KernelState, Rule } from '@sundial/kernel/types.js';
import { offersSaidOn } from './notice-gate.js';

type OfferNow = NonNullable<KernelState['offerNow']>;
type Context = NonNullable<OfferNow['context']>;

/** A context held this long is worth one look. Rapid switching never gets here. */
export const HOLD_MS = 2 * 60_000;
/** At most one question per this long, whatever the app. */
export const ASK_GAP_MS = 10 * 60_000;
/** The contexts before this one that go with it, from this far back, at most this many. */
export const RECENT_MS = 10 * 60_000;
export const MAX_RECENT = 6;
/** A deliberately asked thing carries a fixed surprise of 2, as an owner question or a wake-up does; the model's confidence is the precision. */
export const OFFER_SURPRISE = 2;
export const MAX_PRECISION = 0.9;
/** Below this the model is guessing: no candidate. */
export const MIN_CONFIDENCE = 0.5;
/** An offer for what the owner is doing now is worth little ten minutes later. */
export const OFFER_HALF_LIFE_MS = 10 * 60_000;
export const OFFER_KIND = GATE_OFFER_KIND;
const MAX_TITLE = 120;

const EMPTY: OfferNow = { context: null, recent: [], lastAskAt: null };
const age = (from: string, to: string) => Date.parse(to) - Date.parse(from);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const none = (state: KernelState) => ({ state, effects: [] });

/**
 * The habituation key: per app. A key has to recur for habituation to gate (a title rarely comes back; an app does), so
 * a delivered offer or a "not now" in one app quiets the next offer there for days, and a "useful" restores it.
 */
export const offerKey = (app: string) => `${OFFER_KIND}:${app.toLowerCase()}`;

/** Whether a context may never reach the model: a private or hidden app (its title is a placeholder at ingest), or a private host in front. */
export function privateContext(state: KernelState, c: { app: string; title: string; since?: string }): boolean {
  if (c.app === '' || isRedactedPlaceholder(c.app) || isRedactedPlaceholder(c.title)) return true;
  const hosts = state.config.privateHosts ?? [...DEFAULT_PRIVATE_HOSTS];
  const title = c.title.toLowerCase();
  if (hosts.some((h) => title.includes(h))) return true;
  const tab = state.browser.current;
  if (!tab) return false;
  const inFront = tab.app.toLowerCase() === c.app.toLowerCase() || (c.since !== undefined && tab.updatedAt >= c.since);
  const host = tab.host.toLowerCase();
  return inFront && hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** The question. Only sanitized values: window titles and app names as ingest wrote them, the last failing command as the shell hook's redaction left it. */
export function offerMessages(state: KernelState, c: Context, recent: OfferNow['recent'], ts: string): ChatMessage[] {
  const tz = state.config.timezone;
  const lines = [`Now: ${c.app}, "${clip(c.title, MAX_TITLE)}", in front since ${formatClock(c.since, tz)} (${Math.round(age(c.since, ts) / 60_000)} min).`];
  if (recent.length > 0) lines.push('Before that:', ...recent.map((r) => `- ${formatClock(r.at, tz)} ${r.app}, "${clip(r.title, MAX_TITLE)}"`));
  const failed = Object.values(state.shell.lastFailure ?? {}).filter((f) => age(f.at, ts) >= 0 && age(f.at, ts) <= RECENT_MS).sort((a, b) => b.at.localeCompare(a.at))[0];
  if (failed) lines.push(`Last failing command (${formatClock(failed.at, tz)}): \`${clip(failed.command, 120)}\` (exit ${failed.exitCode}).`);
  return [
    {
      role: 'system',
      content:
        'You are Gnomon, an assistant on the owner\'s Mac. From what is in front of them now, decide whether there is ONE concrete, useful thing you could do for them right now (look something up, draft, summarize, check, find a file). ' +
        'Most of the time there is none: then answer none. Never offer something generic ("let me know if you need help"), never comment on their habits. ' +
        'Answer with JSON only: {"offer": "<one short sentence offering the act, addressed to the owner>", "confidence": <0..1 that they would want it now>} or {"offer": "none"}.',
    },
    { role: 'user', content: lines.join('\n') },
  ];
}

/** The model's answer, or null for none, unparseable, or below `MIN_CONFIDENCE`. */
export function parseOffer(text: string): { offer: string; confidence: number } | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  try {
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    const offer = typeof parsed.offer === 'string' ? parsed.offer.trim() : '';
    const confidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence) ? parsed.confidence : 0;
    if (offer === '' || /^none\.?$/i.test(offer) || confidence < MIN_CONFIDENCE) return null;
    return { offer: clip(offer, 240), confidence: Math.min(1, confidence) };
  } catch {
    return null;
  }
}

/** Whether a tick may spend a call on this context; the reasons are the owner's switches, the budget and the app's habituation. */
function mayAsk(state: KernelState, was: OfferNow, c: Context, ts: string): boolean {
  if (c.asked || age(c.since, ts) < HOLD_MS || privateContext(state, c)) return false;
  if (state.lifeEvent.idle.isIdle || state.settings.autonomy === 'off' || isQuieted(state.settings.quiet, OFFER_KIND)) return false;
  if ((state.budgets.byPurpose.offer?.callsToday ?? 0) >= resolveDailyCaps(state.config.budgets).offer) return false;
  // The gate's own arithmetic, asked before the model is: an offer decays within the gate's urgent window, so it is
  // weighed against the offers' own interrupting bar (`config.offerBar`). When even a sure answer could not clear it (a "not now" on this app, an offer
  // delivered here lately), no call is spent. A "useful" drops the key's habituation and the app is asked again.
  const policy = policyForBias(state.settings.noticeBias, state.config.offerBar);
  const gain = habituatedGain(state.notices.habituation[offerKey(c.app)], Date.parse(ts), policy);
  if (OFFER_SURPRISE * MAX_PRECISION * gain < phasicBarFor(policy, OFFER_KIND)) return false;
  // The day's offers are spent: the gate would refuse any answer, so no call is spent either.
  if (offersSaidOn(state, localDate(ts, state.config.timezone)) >= (policy.offerDailyCap ?? Infinity)) return false;
  return was.lastAskAt === null || age(was.lastAskAt, ts) >= ASK_GAP_MS;
}

/** Single writer of `state.offerNow`. Folds `window:changed` (the context), `clock:tick` (the ask) and its own `llm:result` (the candidate). */
export const offerNow: Rule = (state, event) => {
  const was = state.offerNow ?? EMPTY;
  const p = event.payload as Record<string, unknown>;

  if (event.type === 'window:changed') {
    const app = typeof p.processName === 'string' ? p.processName : '';
    const title = typeof p.windowTitle === 'string' ? p.windowTitle : '';
    const key = `${app}\u0000${title}`;
    if (app === '' || was.context?.key === key) return none(state);
    const prior = was.context && !privateContext(state, was.context) ? [{ app: was.context.app, title: was.context.title, at: was.context.since }] : [];
    const recent = [...was.recent, ...prior].filter((r) => age(r.at, event.ts) <= RECENT_MS).slice(-MAX_RECENT);
    return { state: { ...state, offerNow: { ...was, context: { key, app, title, since: event.ts, asked: false }, recent } }, effects: [] };
  }

  if (event.type === 'clock:tick') {
    const c = was.context;
    if (!c || !mayAsk(state, was, c, event.ts)) return none(state);
    return {
      state: { ...state, offerNow: { ...was, context: { ...c, asked: true }, lastAskAt: event.ts } },
      effects: [{ type: 'ScheduleLLM', purpose: 'offer', momentId: state.moment?.id ?? null, delayMs: 0, messages: offerMessages(state, c, was.recent, event.ts), metadata: { kind: OFFER_KIND, app: c.app, title: c.title, since: c.since } }],
    };
  }

  if (event.type === 'llm:result' && p.purpose === 'offer') {
    const meta = (p.metadata ?? {}) as { app?: unknown; title?: unknown; since?: unknown };
    const found = typeof p.text === 'string' ? parseOffer(p.text) : null;
    if (!found || typeof meta.app !== 'string' || typeof meta.title !== 'string') return none(state);
    const app = meta.app;
    const since = typeof meta.since === 'string' ? meta.since : event.ts;
    // The owner moved on while the model thought: an offer for a window no longer in front is noise.
    if (was.context && was.context.app !== app) return none(state);
    const key = offerKey(app);
    return {
      state,
      effects: [
        {
          type: 'EmitEvent',
          event: {
            id: deriveId(event.ts, event.id, 'offer-now', key),
            type: 'notice:candidate',
            ts: event.ts,
            payload: {
              timestamp: event.ts,
              shape: 'transition',
              kind: OFFER_KIND,
              key,
              surprise: OFFER_SURPRISE,
              precision: Math.min(MAX_PRECISION, found.confidence),
              valueHalfLifeMs: OFFER_HALF_LIFE_MS,
              observation: found.offer,
              evidence: [`${app}: "${clip(meta.title, MAX_TITLE)}" in front since ${formatClock(since, state.config.timezone)}`, `model confidence ${found.confidence.toFixed(2)}`],
              concerns: [],
            },
          },
        },
      ],
    };
  }

  return none(state);
};
