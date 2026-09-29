// The owner's settings.
//
// One event, one slice: `settings:set` carries any subset of the fields and
// the rest stand. They live in the fold rather than in a file so that a rule
// can read them (`noticeGate` asks whether it may speak at all), the model's
// write tools can be refused by them, and every open tab agrees — and so a
// replay reproduces the settings that were in force at the time.

import { NOTICE_GROUPS } from '@sundial/kernel/notice-groups.js';
import type { OwnerSettings, Rule } from '@sundial/kernel/types.js';

const AUTONOMY = new Set(['off', 'notice', 'act']);
const PAPER = new Set(['system', 'light', 'dark']);
const MOTION = new Set(['full', 'reduced']);
const BLUR = new Set(['off', 'soft', 'full']);
const GROUPS = new Set(NOTICE_GROUPS.map((g) => g.id));

/** How far the bar may be nudged: past this it is an off switch wearing a dial's clothes. */
export const MAX_NOTICE_BIAS = 3;
/** A walk step may not advance faster than this — below it, nobody can read the step. */
export const MIN_AUTO_ADVANCE_MS = 1500;

const oneOf = (value: unknown, allowed: Set<string>, fallback: string): string => (typeof value === 'string' && allowed.has(value) ? value : fallback);

export const settingsTrack: Rule = (state, event) => {
  if (event.type !== 'settings:set') return { state, effects: [] };
  const p = event.payload as Record<string, unknown>;
  const prior = state.settings;

  const bias = typeof p.noticeBias === 'number' && Number.isFinite(p.noticeBias) ? Math.max(-MAX_NOTICE_BIAS, Math.min(MAX_NOTICE_BIAS, p.noticeBias)) : prior.noticeBias;
  // `null` is a real value here (wait for Next), so undefined is the only "leave it".
  const advance =
    p.autoAdvanceMs === undefined
      ? prior.autoAdvanceMs
      : typeof p.autoAdvanceMs === 'number' && Number.isFinite(p.autoAdvanceMs)
        ? Math.max(MIN_AUTO_ADVANCE_MS, Math.round(p.autoAdvanceMs))
        : null;

  const next: OwnerSettings = {
    autonomy: oneOf(p.autonomy, AUTONOMY, prior.autonomy) as OwnerSettings['autonomy'],
    noticeBias: bias,
    autoAdvanceMs: advance,
    paper: oneOf(p.paper, PAPER, prior.paper) as OwnerSettings['paper'],
    motion: oneOf(p.motion, MOTION, prior.motion) as OwnerSettings['motion'],
    // `prior.blur` can be undefined on a state folded before this field existed.
    blur: oneOf(p.blur, BLUR, prior.blur ?? 'full') as OwnerSettings['blur'],
    // A known group id, once each, in catalogue order; anything else is dropped.
    quiet: Array.isArray(p.quiet) ? NOTICE_GROUPS.map((g) => g.id).filter((id) => GROUPS.has(id) && (p.quiet as unknown[]).includes(id)) : (prior.quiet ?? []),
    updatedAt: event.ts,
  };

  // Nothing actually changed: no new state, so no snapshot churn from a tab
  // that re-sends what it already has.
  const same = (Object.keys(next) as (keyof OwnerSettings)[]).every((k) => k === 'updatedAt' || (k === 'quiet' ? (next.quiet ?? []).join() === (prior.quiet ?? []).join() : next[k] === prior[k]));
  if (same) return { state, effects: [] };

  return { state: { ...state, settings: next }, effects: [] };
};
