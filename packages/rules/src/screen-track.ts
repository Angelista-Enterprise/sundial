import type { Rule } from '@sundial/kernel/types.js';
import { filterScreenLines, rawLineSet, screenRefs } from './screen-text-filter.js';
import { screenFactsOf } from './screen-facts.js';

interface ScreenOcrPayload {
  timestamp?: string;
  region?: string;
  processName?: string;
  bundleId?: string | null;
  screenText?: string;
  topics?: string[];
}

/**
 * Runs BEFORE `momentRollup` (see the manifest). Turns the raw, sanitized
 * `screenText` of a capture into the lines worth keeping, using the previous
 * capture of the SAME app in the SAME region as the furniture reference, and leaves the result in
 * `state.screen` for the rollup to read on the same event. Also keeps the
 * per-capture audit counts — how much was furniture, how much noise — which is
 * what makes the filter measurable instead of asserted.
 *
 * A `[private]` capture (hidden or sensitive app) resets nothing and keeps
 * nothing: the previous app's furniture set stays for when the owner returns.
 *
 * `facts` are the capture's typed facts (`screen-facts.ts`); `read` and `frame`
 * (Jev's) ride along untouched, `screenRead` owns them.
 */
export const screenTrack: Rule = (state, event) => {
  if (event.type !== 'screen:ocr') return { state, effects: [] };
  const payload = event.payload as ScreenOcrPayload;
  const text = typeof payload.screenText === 'string' ? payload.screenText : '';
  if (text.trim() === '' || text === '[private]') return { state, effects: [] };

  const app = (typeof payload.bundleId === 'string' && payload.bundleId) || (typeof payload.processName === 'string' ? payload.processName : '') || null;
  const region = payload.region === 'cursor' ? 'cursor' : 'focused';
  // The previous capture of the same app AND region; an older snapshot has only `prevLines`.
  const before = state.screen.prevByRegion?.[region] ?? (state.screen.prevByRegion ? null : { app: state.screen.app, lines: state.screen.prevLines });
  const previous = new Set(before && before.app !== null && before.app === app ? before.lines : []);
  const result = filterScreenLines(text, app, previous);
  const lines = rawLineSet(text);

  return {
    state: {
      ...state,
      screen: {
        ...state.screen,
        app,
        prevLines: [],
        prevByRegion: { ...state.screen.prevByRegion, [region]: { app, lines } },
        eventId: event.id,
        kept: result.kept,
        refs: screenRefs(result.kept),
        facts: screenFactsOf(lines, app, typeof payload.processName === 'string' ? payload.processName : null),
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
