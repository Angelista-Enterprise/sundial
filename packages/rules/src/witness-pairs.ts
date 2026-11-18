// W6 D6: witness pairs
import type { Effect, KernelState, Rule, SanitizedEvent, WitnessPair, WitnessState } from '@sundial/kernel/types.js';
import { deriveId } from '@sundial/helpers/derive-id.js';
import { isRedactedPlaceholder } from '@sundial/helpers/redact/redact-policy.js';
import { isBrowser } from '@sundial/helpers/window-classification.js';
import { isZeroActivity } from './idle-track.js';

const MINUTE = 60_000;
/** Minutes of left-side evidence with no right-side event before the right sensor counts as blind. */
export const BLIND_AFTER_MS = 30 * MINUTE;

const PRIVATE_WINDOW = /private browsing|incognito|inprivate/i;
const OWN_WINDOW = /sundial|gnomon/i;
const unseen = (value: string): boolean => value === '' || isRedactedPlaceholder(value);

interface Pair {
  /** The event the left side predicts. */
  right: string;
  on: (state: KernelState) => boolean;
  /** Is this event left-side evidence? `w` is the slice before the event. */
  left: (state: KernelState, event: SanitizedEvent, w: WitnessState) => boolean;
  says: (state: KernelState, w: WitnessState) => string;
}

function frontOf(event: SanitizedEvent): WitnessState['front'] {
  const p = (event.payload ?? {}) as { processName?: unknown; windowTitle?: unknown };
  return typeof p.processName === 'string' ? { process: p.processName, title: typeof p.windowTitle === 'string' ? p.windowTitle : '' } : null;
}

/** The fixed table. A pair's id is its key in `state.witness.pairs` and the `blind:<id>` trouble. */
export const PAIRS: Record<string, Pair> = {
  browser: {
    right: 'browser:tab',
    on: () => true,
    // ponytail: a page that renames itself with no new address (an unread count) counts as evidence; compare hosts if the record shows false alarms.
    left: (_state, event, w) => {
      if (event.type !== 'window:changed') return false;
      const front = frontOf(event);
      return front !== null && isBrowser(front.process) && !unseen(front.title) && !PRIVATE_WINDOW.test(front.title) && front.title !== w.browserTitle;
    },
    says: (state, w) => {
      const app = (w.front?.process ?? 'A browser').slice(0, 40);
      return state.browser.unsupported === w.front?.process
        ? `${app} was in front for 30 minutes of use, and Sundial cannot read pages from this browser.`
        : `${app} was in front for 30 minutes of use, and Sundial read no page from it.`;
    },
  },
  screen: {
    right: 'screen:ocr',
    on: (state) => state.config.sensorsOn?.ocr === true,
    left: (_state, event, w) =>
      event.type === 'input:activity' &&
      !isZeroActivity(event.payload as Parameters<typeof isZeroActivity>[0]) &&
      w.front !== null &&
      !OWN_WINDOW.test(w.front.process) &&
      !unseen(w.front.process) &&
      !unseen(w.front.title),
    says: () => 'You typed and clicked for 30 minutes, and the screen reader read nothing. Check Screen Recording for Sundial in System Settings.',
  },
  audio: {
    right: 'audio:transcript',
    on: (state) => state.config.sensorsOn?.audio === true,
    // ponytail: 30 minutes of a call where nobody is heard (the owner silent on headphones) reads as blind; raise the bar per pair if the record shows it.
    left: (state, event) => event.type === 'clock:tick' && state.hearing?.listening === true && state.av.call !== null,
    says: () => 'A call held the microphone for 30 minutes while Sundial was set to listen, and no speech was written down.',
  },
};

const fresh = (): WitnessPair => ({ leftAt: null, rightAt: null, brokenSince: null, leftMs: 0, told: false });

/**
 * Which sensor is blind, from two streams that disagree. A quiet stream alone
 * is never a fault: only left-side evidence counts time, one minute per
 * `clock:tick` that had evidence in it, so a sleep or an idle hour counts
 * nothing. Thirty such minutes with no right-side event emit `sensor:blind`
 * once; the next right-side event emits `sensor:sighted`. `sensorHealth` turns
 * those into the `blind:<pair>` trouble and its one notice.
 */
export const witnessPairs: Rule = (state, event) => {
  const t = event.type;
  if (t !== 'clock:tick' && t !== 'window:changed' && t !== 'input:activity' && !Object.values(PAIRS).some((pair) => pair.right === t)) return { state, effects: [] };
  const before: WitnessState = state.witness ?? { front: null, browserTitle: null, pairs: {} };
  const ts = event.ts;
  const effects: Effect[] = [];
  const emit = (type: 'sensor:blind' | 'sensor:sighted', id: string, payload: Record<string, unknown>): void => {
    effects.push({ type: 'EmitEvent', event: { id: deriveId(ts, event.id, 'witness', `${id}:${type}`), type, ts, payload: { timestamp: ts, pair: id, ...payload } } });
  };

  const pairs: Record<string, WitnessPair> = {};
  for (const [id, pair] of Object.entries(PAIRS)) {
    if (!pair.on(state)) continue;
    let p = before.pairs[id] ?? fresh();
    if (t === pair.right) {
      if (p.told) emit('sensor:sighted', id, {});
      p = { ...fresh(), rightAt: ts };
    } else if (pair.left(state, event, before)) p = { ...p, leftAt: ts, brokenSince: p.brokenSince ?? ts };
    if (t === 'clock:tick' && p.leftAt !== null && Date.parse(ts) - Date.parse(p.leftAt) <= MINUTE) {
      p = { ...p, leftMs: p.leftMs + MINUTE };
      if (!p.told && p.leftMs >= BLIND_AFTER_MS) {
        p = { ...p, told: true };
        emit('sensor:blind', id, { since: p.brokenSince, observation: pair.says(state, before), evidence: [`${Math.round(p.leftMs / MINUTE)} minutes of use`, `no ${pair.right} since ${p.rightAt ?? 'the start'}`] });
      }
    }
    pairs[id] = p;
  }

  let { front, browserTitle } = before;
  if (t === 'window:changed') {
    front = frontOf(event);
    if (front !== null && isBrowser(front.process) && !unseen(front.title)) browserTitle = front.title;
  }
  return { state: { ...state, witness: { front, browserTitle, pairs } }, effects };
};
