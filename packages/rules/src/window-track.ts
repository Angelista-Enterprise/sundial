import type { Rule } from '@sundial/kernel/types.js';
import { resolveAttribution } from './attribution.js';

interface WindowChangedPayload {
  processName?: string;
  windowTitle?: string;
  windowId?: string;
  documentPath?: string | null;
}

/**
 * Reacts to `window:changed` — writes `state.window.active`/`.previous`.
 * Nothing populated this field before Wave 3a even though
 * docs/design/02-state-and-reducer.md documents it as the answer to
 * "what's the daemon doing right now" — `momentClose` reacts to the same
 * event but writes `state.moment`, not `state.window`. Runs before
 * `momentClose` in the manifest so momentClose could (if it ever needs to)
 * read the just-updated `state.window.active` — no current dependency, but
 * matches the field's documented role as the more general "current window"
 * fact vs. momentClose's specific "is a moment open" concern.
 */
export const windowTrack: Rule = (state, event) => {
  if (event.type !== 'window:changed') return { state, effects: [] };

  const payload = event.payload as WindowChangedPayload;
  const processName = typeof payload.processName === 'string' ? payload.processName : '';
  const windowTitle = typeof payload.windowTitle === 'string' ? payload.windowTitle : '';
  const windowId = typeof payload.windowId === 'string' ? payload.windowId : '';
  const documentPath = typeof payload.documentPath === 'string' ? payload.documentPath : null;

  const attribution = resolveAttribution(state, { processName, windowTitle, documentPath });

  return {
    state: {
      ...state,
      window: {
        active: { processName, windowTitle, windowId, documentPath },
        previous: state.window.active,
        attribution,
      },
    },
    effects: [],
  };
};
