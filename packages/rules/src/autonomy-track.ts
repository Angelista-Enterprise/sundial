import { capabilities, computeLevels } from '@sundial/kernel/autonomy.js';
import { isRigSession } from '@sundial/kernel/read/rig-session.js';
import type { AutonomyLevel, AutonomyState, KernelState, Rule } from '@sundial/kernel/types.js';

/*
 * W5 step 10: the single writer of `state.autonomy`. The owner's yes (`autonomy:granted
 * {capability}`) and the owner's ceiling (`autonomy:set {capability, level}`: `off` or `ask`
 * lowers it, `act` lifts the ceiling again) are folded as they come; the levels are recomputed
 * whenever an input to the scorecard rows they read can have moved. After `calibrate`, whose
 * numbers they read on the same event.
 *
 * Round 3: the ladder. The owner's answer to a plain act (`approval:answered`, joined to its call's
 * tool, kind and app by `approvalTrack`, which runs before this rule) moves that tool's rung in that
 * app: a yes up one, a no back to 0. Only `by: 'owner'` counts: the rig answers with `by: 'rig'`, and a
 * timeout or a withdrawn ask is nobody's answer. Round 4, belt and braces: an answer in one of the rig's
 * chat sessions (`isRigSession`) never earns, whoever it says answered. A final carries no app (approvalTrack), so it never
 * climbs. `autonomy:set {reset: app}` (or `reset: true`, every app) clears it.
 */
const LEVELS = new Set<AutonomyLevel>(['off', 'ask', 'act']);
const RECOMPUTE = new Set(['autonomy:granted', 'autonomy:set', 'feedback:verdict', 'action:verified', 'action:performed', 'day:boundary', 'notice:candidate']);
export const LADDER_KEPT = 50;
const YES_CAP = 999;
const EMPTY: AutonomyState = { levels: {}, granted: {}, lowered: {} };

type Rung = NonNullable<AutonomyState['ladder']>[number];
const same = (r: Rung, tool: string, app: string) => r.tool === tool && r.app.toLowerCase() === app.toLowerCase();

/** The ladder after one answer, or null when the answer does not move it. */
function climb(state: KernelState, approvalId: unknown, ts: string): AutonomyState | null {
  const answer = [...(state.approvals?.recent ?? [])].reverse().find((r) => r.id === approvalId && r.answeredAt === ts);
  if (!answer || answer.by !== 'owner' || answer.kind !== 'plain' || !answer.app || isRigSession(state, answer.sessionId)) return null;
  const yes = answer.answer === 'allowed-once' ? true : answer.answer === 'rejected' ? false : null;
  if (yes === null) return null;
  const app = answer.app;
  const a = state.autonomy ?? EMPTY;
  const ladder = a.ladder ?? [];
  const was = ladder.find((r) => same(r, answer.tool, app));
  const rung: Rung = { tool: answer.tool, app, yes: yes ? Math.min((was?.yes ?? 0) + 1, YES_CAP) : 0, at: ts };
  return { ...a, ladder: [...ladder.filter((r) => r !== was), rung].slice(-LADDER_KEPT) };
}

export const autonomyTrack: Rule = (state, event) => {
  const p = (event.payload ?? {}) as { capability?: unknown; level?: unknown; approvalId?: unknown; reset?: unknown };
  if (event.type === 'approval:answered') {
    const a = climb(state, p.approvalId, event.ts);
    return a ? { state: { ...state, autonomy: a }, effects: [] } : { state, effects: [] };
  }
  if (event.type === 'autonomy:set' && (p.reset === true || (typeof p.reset === 'string' && p.reset.trim() !== ''))) {
    const a = state.autonomy ?? EMPTY;
    const ladder = a.ladder ?? [];
    const kept = p.reset === true ? [] : ladder.filter((r) => r.app.toLowerCase() !== String(p.reset).trim().toLowerCase());
    return kept.length === ladder.length ? { state, effects: [] } : { state: { ...state, autonomy: { ...a, ladder: kept } }, effects: [] };
  }
  if (!RECOMPUTE.has(event.type)) return { state, effects: [] };
  const cap = typeof p.capability === 'string' ? p.capability : '';
  let a = state.autonomy ?? EMPTY;
  if (event.type === 'autonomy:granted' || event.type === 'autonomy:set') {
    if (cap === '' || !capabilities(state).includes(cap)) return { state, effects: [] };
    if (event.type === 'autonomy:granted') a = { ...a, granted: { ...a.granted, [cap]: event.ts } };
    else if (LEVELS.has(p.level as AutonomyLevel)) {
      const { [cap]: _, ...rest } = a.lowered;
      a = { ...a, lowered: p.level === 'act' ? rest : { ...rest, [cap]: p.level as AutonomyLevel } };
    } else return { state, effects: [] };
  } else if (event.type === 'notice:candidate' && typeof (event.payload as { kind?: unknown }).kind === 'string' && a.levels[`notice:${(event.payload as { kind: string }).kind}`]) return { state, effects: [] };
  const withA: KernelState = { ...state, autonomy: a };
  const levels = computeLevels(withA, event.ts);
  const unchanged = a === state.autonomy && Object.keys(levels).length === Object.keys(a.levels).length && Object.entries(levels).every(([k, v]) => a.levels[k] === v);
  return unchanged ? { state, effects: [] } : { state: { ...withA, autonomy: { ...a, levels } }, effects: [] };
};
