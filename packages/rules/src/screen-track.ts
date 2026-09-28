import type { Rule } from '@sundial/kernel/types.js';
import { filterScreenLines, rawLineSet, screenRefs } from './screen-text-filter.js';

interface ScreenOcrPayload {
  timestamp?: string;
  processName?: string;
  bundleId?: string | null;
  screenText?: string;
  topics?: string[];
}

/**
 * Runs BEFORE `momentRollup` (see the manifest). Turns the raw, sanitized
 * `screenText` of a capture into the lines worth keeping, using the previous
 * capture of the SAME app as the furniture reference, and leaves the result in
 * `state.screen` for the rollup to read on the same event. Also keeps the
 * per-capture audit counts — how much was furniture, how much noise — which is
 * what makes the filter measurable instead of asserted.
 *
 * A `[private]` capture (hidden or sensitive app) resets nothing and keeps
 * nothing: the previous app's furniture set stays for when the owner returns.
 */
export const screenTrack: Rule = (state, event) => {
  if (event.type !== 'screen:ocr') return { state, effects: [] };
  const payload = event.payload as ScreenOcrPayload;
  const text = typeof payload.screenText === 'string' ? payload.screenText : '';
  if (text.trim() === '' || text === '[private]') return { state, effects: [] };

  const app = (typeof payload.bundleId === 'string' && payload.bundleId) || (typeof payload.processName === 'string' ? payload.processName : '') || null;
  const sameApp = state.screen.app !== null && state.screen.app === app;
  const previous = new Set(sameApp ? state.screen.prevLines : []);
  const result = filterScreenLines(text, app, previous);

  return {
    state: {
      ...state,
      screen: {
        app,
        prevLines: rawLineSet(text),
        eventId: event.id,
        kept: result.kept,
        refs: screenRefs(result.kept),
        audit: {
          captures: state.screen.audit.captures + 1,
          lines: state.screen.audit.lines + result.total,
          kept: state.screen.audit.kept + result.kept.length,
          furniture: state.screen.audit.furniture + result.furniture,
          noise: state.screen.audit.noise + result.noise,
        },
      },
    },
    effects: [],
  };
};
