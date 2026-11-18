// Plan 15 step 1: the knock. A sound first; the sentence only after the owner's go, or at once for a kind that may act alone.
import { deriveId } from '@sundial/helpers/derive-id.js';
import { noticeTitle } from '@sundial/kernel/notice-groups.js';
import type { Effect, KernelState, Rule } from '@sundial/kernel/types.js';

/** "Quiet for one hour", the same length as hearing's mute. */
export const MUTE_MS = 60 * 60_000;
/** The app answers a knock inside 5 seconds. No answer for this long: the app never got it. */
export const KNOCK_LOST_MS = 30_000;
/** A job back longer ago than this gets no sound: the shelf and the summon line still show it. */
export const RETURN_STALE_MS = 4 * 60 * 60_000;
/** Plan 15 step 3: a spoken "go" for a waiting knock, when hearing is on. */
const SPOKEN_GO = /^\s*(yes|yeah|go|go on|go ahead|tell me|ja|ga door|ga je gang|vertel)\W*$/i;

type Voice = NonNullable<KernelState['voice']>;
const EMPTY: Voice = { pendingKnock: null, recentLines: [], mutedUntil: null };
/** The events the gate delivers on. */
const DELIVERS = new Set(['notice:candidate', 'clock:tick', 'input:activity', 'boundary:reached']);
const saidOf = (state: KernelState, key: string) => [...state.notices.recentPhasic].reverse().find((n) => n.noticeKey === key);

/**
 * Single writer of `state.voice`. After `noticeGate`: it reads `notices.lastDelivered` on the same event.
 * The gate chose the knock (`DeliveredNotice.knock`); this rule sends it to the app and folds the app's answer:
 * `voice:go` (the turn that waited runs now), `voice:declined` (Esc counts against the notice), `voice:unanswered`.
 */
export const voiceKnock: Rule = (state, event) => {
  const voice = state.voice ?? EMPTY;
  const p = event.payload as { keyDownCount?: unknown; noticeKey?: unknown; off?: unknown; auto?: unknown; reason?: unknown; spokenText?: unknown; line?: unknown; text?: unknown; channel?: unknown; wordCount?: unknown; session?: unknown; turnAt?: unknown; lang?: unknown; seq?: unknown; last?: unknown; reply?: unknown };
  const pending = voice.pendingKnock;
  const mine = pending !== null && p.noticeKey === pending.noticeKey;
  const effects: Effect[] = [];
  let next = voice;

  switch (event.type) {
    case 'input:activity':
      if (typeof p.keyDownCount === 'number' && p.keyDownCount > 0) next = { ...next, typedAt: event.ts };
      break;
    case 'audio:transcript':
      next = { ...next, heardAt: event.ts };
      // A spoken go: the sentence is said now, and the app stops waiting for the key.
      // The room's mic, not the far side of a call, and the go alone: "yeah, so about the release" is talk, not a go.
      if (pending !== null && p.channel !== 'system' && (typeof p.wordCount !== 'number' || p.wordCount <= 4) && typeof p.spokenText === 'string' && SPOKEN_GO.test(p.spokenText)) {
        const said = saidOf(state, pending.noticeKey);
        effects.push(
          { type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'voice-knock', 'spoken-go'), type: 'voice:go', ts: event.ts, payload: { noticeKey: pending.noticeKey, spoken: true } } },
          { type: 'Speak', text: said?.observation ?? null, sound: null, mode: 'notice', noticeKey: pending.noticeKey },
        );
        // Set 2 R3: a notice with one act to take. The host presses it as the strip and the slip do (`offerPress`):
        // `notice:offer-taken` (via knock), then the call through the action gate, so a final still asks the owner.
        const offers = state.notices.offers;
        if (offers && Object.hasOwn(offers, pending.noticeKey)) effects.push({ type: 'Notify', channel: 'offer-take', payload: { noticeKey: pending.noticeKey, via: 'knock' } });
      }
      break;
    case 'voice:turn':
      if (typeof p.session === 'string' && typeof p.turnAt === 'string') next = { ...next, said: { session: p.session, at: p.turnAt, lang: typeof p.lang === 'string' ? p.lang : null, lines: [], seq: 0 } };
      break;
    case 'voice:line': {
      // A reply's own sentence is not a holding line: only the turn's record keeps it.
      if (typeof p.line === 'string' && p.reply !== true) next = { ...next, recentLines: [...next.recentLines, p.line].slice(-8) };
      const said = next.said;
      if (said && typeof p.line === 'string' && p.session === said.session && p.turnAt === said.at) {
        next = { ...next, said: { ...said, lines: p.line === '' ? said.lines : [...said.lines, p.line.slice(0, 400)].slice(-12), seq: typeof p.seq === 'number' ? Math.max(said.seq, p.seq + 1) : said.seq, ...(p.last === true ? { ended: true } : {}) } };
      }
      break;
    }
    case 'voice:said':
      if (typeof p.text === 'string' && p.text !== '') next = { ...next, recentSaid: [...(next.recentSaid ?? []), { text: p.text.slice(0, 400), at: event.ts }].slice(-5) };
      break;
    case 'voice:interrupted':
      next = { ...next, interruptedAt: event.ts };
      break;
    case 'voice:muted':
      next = { ...next, mutedUntil: p.off === true ? null : new Date(Date.parse(event.ts) + MUTE_MS).toISOString() };
      break;
    case 'voice:go': {
      if (!mine) break;
      next = { ...next, pendingKnock: null };
      const said = pending.turn === true && p.auto !== true ? saidOf(state, pending.noticeKey) : undefined;
      // The turn the knock held back. `afterGo`: the delivery plugin does not count this notice a second time.
      if (said) effects.push({ type: 'Notify', channel: 'phasic-notice', payload: { kind: said.kind, observation: said.observation, evidence: said.evidence, weight: said.weight, noticeKey: pending.noticeKey, ...(pending.askId ? { askId: pending.askId } : {}), route: 'mac', title: noticeTitle(said.kind), sessionId: pending.sessionId ?? null, acts: ['turn'], afterGo: true } });
      break;
    }
    case 'voice:declined':
      if (!mine) break;
      next = { ...next, pendingKnock: null };
      if (p.reason === 'esc') effects.push({ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'voice-knock', 'esc'), type: 'feedback:verdict', ts: event.ts, payload: { artifactKind: 'notice', artifactId: pending.noticeKey, verdict: 'not-now', via: 'knock' } } });
      break;
    case 'voice:unanswered':
      if (mine) next = { ...next, pendingKnock: null };
      break;
    case 'work:shelved':
    case 'job:finished':
      if (event.type === 'job:finished' ? (event.payload as { outcome?: unknown }).outcome === 'done' : typeof (event.payload as { title?: unknown }).title === 'string') next = { ...next, returnAt: event.ts };
      break;
    case 'boundary:reached': {
      // Plan 15 4.4: a job that came back plays its sound at the owner's next pause, at the Mac, not muted.
      const at = next.returnAt;
      const knocks = state.notices.lastDelivered?.at === event.ts && state.notices.lastDelivered.items.some((i) => i.knock);
      if (!at || knocks || next.pendingKnock !== null || state.route?.channel !== 'mac') break;
      if (Date.parse(event.ts) - Date.parse(at) > RETURN_STALE_MS) next = { ...next, returnAt: null };
      else if (!(next.mutedUntil && next.mutedUntil > event.ts)) {
        next = { ...next, returnAt: null };
        effects.push({ type: 'Speak', text: null, sound: 'return', mode: 'notice' });
      }
      break;
    }
    case 'clock:tick':
      if (pending === null || Date.parse(event.ts) - Date.parse(pending.at) <= KNOCK_LOST_MS) break;
      next = { ...next, pendingKnock: null };
      effects.push({ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'voice-knock', 'lost'), type: 'voice:unanswered', ts: event.ts, payload: { noticeKey: pending.noticeKey, kind: pending.kind ?? '', reason: 'no-app' } } });
      break;
  }

  const last = state.notices.lastDelivered;
  const item = DELIVERS.has(event.type) && last?.at === event.ts && next.pendingKnock === null ? last.items.find((i) => i.knock) : undefined;
  if (item?.knock) {
    const said = saidOf(state, item.key);
    next = { ...next, pendingKnock: { noticeKey: item.key, kind: item.kind, mode: item.knock.mode, at: event.ts, sessionId: item.sessionId, askId: item.askId, turn: item.knock.turn } };
    effects.push(
      { type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'voice-knock', item.key), type: 'voice:knock', ts: event.ts, payload: { noticeKey: item.key, kind: item.kind, mode: item.knock.mode } } },
      { type: 'Speak', text: said?.observation ?? null, sound: 'knock', mode: item.knock.mode, noticeKey: item.key },
    );
  }

  return next === voice ? { state, effects } : { state: { ...state, voice: next }, effects };
};
