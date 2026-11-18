// Plan 15 step 2: the quiet summon. What the owner did first after the panel came up, held against the guess made at the summon.
import { deriveId } from '@sundial/helpers/derive-id.js';
import { summonEvidence } from '@sundial/kernel/read/summon-evidence.js';
import type { Effect, KernelState, Rule } from '@sundial/kernel/types.js';

/** No first move for this long is a glance. */
export const GLANCE_MS = 8_000;
const MOVES = new Set(['type', 'look', 'talk', 'step-back']);
/** The moves that say the owner came for Gnomon. */
const CAME_FOR_IT = new Set(['type', 'look', 'talk']);

type Overlay = NonNullable<KernelState['overlay']>;
const EMPTY: Overlay = { open: null, tally: {} };

/**
 * Single writer of `state.overlay`. The app says `overlay:summoned` and `overlay:dismissed`; the page and the app say
 * `overlay:first-move`. The first move settles a summon once, as one `overlay:settled` row: the rates are read from the log.
 */
export const overlayTrack: Rule = (state, event) => {
  const overlay = state.overlay ?? EMPTY;
  const p = event.payload as { summonId?: unknown; kind?: unknown };
  const effects: Effect[] = [];
  let next = overlay;
  const sinceOpen = () => (next.open ? Date.parse(event.ts) - Date.parse(next.open.at) : 0);

  const settle = (move: string) => {
    const open = next.open;
    if (!open || open.firstMove !== null) return;
    const was = open.guess === null ? null : (next.tally[open.guess] ?? { n: 0, hits: 0 });
    next = {
      open: { ...open, firstMove: move },
      tally: open.guess === null || was === null ? next.tally : { ...next.tally, [open.guess]: { n: was.n + 1, hits: was.hits + (CAME_FOR_IT.has(move) ? 1 : 0) } },
    };
    effects.push({ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'overlay-track', open.summonId), type: 'overlay:settled', ts: event.ts, payload: { summonId: open.summonId, firstMove: move, guess: open.guess, evidence: open.evidence, ms: sinceOpen() } } });
  };

  switch (event.type) {
    case 'overlay:summoned': {
      settle('glance');
      const { evidence, guess } = summonEvidence(state, event.ts);
      next = { ...next, open: { summonId: typeof p.summonId === 'string' ? p.summonId : event.id, at: event.ts, evidence, guess, firstMove: null } };
      break;
    }
    case 'overlay:first-move':
      if (next.open && (typeof p.summonId !== 'string' || p.summonId === next.open.summonId)) settle(typeof p.kind === 'string' && MOVES.has(p.kind) && sinceOpen() <= GLANCE_MS ? p.kind : 'glance');
      break;
    case 'overlay:dismissed':
      settle('glance');
      if (next.open) next = { ...next, open: null };
      break;
    case 'clock:tick':
      if (sinceOpen() > GLANCE_MS) settle('glance');
      break;
  }

  return next === overlay ? { state, effects } : { state: { ...state, overlay: next }, effects };
};
