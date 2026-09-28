import type { FocusQuality, MomentRollup } from '@sundial/kernel/types.js';

export type { FocusQuality };

/** 15+ uninterrupted minutes on one activity reads as full-duration focus. */
const FULL_DURATION_MIN = 15;
/** Each within-moment thrash/interruption docks this much, capped. */
const DISRUPTION_PENALTY = 0.2;
const MAX_DISRUPTION_PENALTY = 0.6;
/** A confirmed focus-flow life event floors the score here regardless of duration. */
const FOCUS_FLOW_FLOOR = 0.7;
/** Active engagement (typing/commands/commits) vs a passive idle-ish span. */
const ENGAGEMENT_BONUS = 0.1;

const DEEP_THRESHOLD = 0.7;
const STEADY_THRESHOLD = 0.4;

/**
 * P2a (docs/design/07) — a per-moment focus score in [0,1], computed once at
 * close from the rollup + duration. Deliberately duration-led: a long
 * single-process/single-project moment is, by construction, uninterrupted
 * focus — this is exactly the case WCS's `deepWorkBlocks` detector
 * false-negatived (it required internal switches a single long moment never
 * has). Within-moment `event:thrashing`/`event:interruption` lower it; a
 * confirmed `event:focus-flow` floors it high. Heuristic and tunable — the
 * day-level derivations (P3: flows, deep-work blocks, energy) complement it;
 * this is not meant to be the last word on "was this deep work."
 */
/**
 * The minutes a focus score is computed over. Wall-clock for a moment that
 * never recorded input counts (pre-2026-08-14 rows, or a read-only moment
 * with no key or click at all); the input-covered span otherwise — a window
 * left open for an hour while the owner was elsewhere is not an hour of focus.
 * Activity Frames' 45%-presence-only finding, applied where it costs most.
 */
export function attendedMs(rollup: MomentRollup, durationMs: number): number {
  const wall = Math.max(0, durationMs);
  if ((rollup.inputEventCount ?? 0) <= 0 || (rollup.activeMs ?? 0) <= 0) return wall;
  return Math.min(wall, rollup.activeMs);
}

export function computeFocusScore(rollup: MomentRollup, durationMs: number): number {
  const minutes = attendedMs(rollup, durationMs) / 60_000;
  const durationScore = Math.min(1, minutes / FULL_DURATION_MIN);

  const disruptions = rollup.lifeEvents.filter((e) => e === 'event:thrashing' || e === 'event:interruption').length;
  const penalty = Math.min(MAX_DISRUPTION_PENALTY, disruptions * DISRUPTION_PENALTY);

  const floor = rollup.lifeEvents.includes('event:focus-flow') ? FOCUS_FLOW_FLOOR : 0;
  const engaged = rollup.typingEventCount > 0 || rollup.shellCommandCount > 0 || rollup.gitCommitCount > 0;
  const engagementBonus = engaged ? ENGAGEMENT_BONUS : 0;

  const raw = Math.max(floor, durationScore) - penalty + engagementBonus;
  return Math.max(0, Math.min(1, raw));
}

export function focusQuality(score: number): FocusQuality {
  if (score >= DEEP_THRESHOLD) return 'deep';
  if (score >= STEADY_THRESHOLD) return 'steady';
  return 'shallow';
}
