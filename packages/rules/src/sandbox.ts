import { createInitialState } from '@sundial/kernel/initial-state.js';
import { isRigSession, SANDBOX_CHANNEL, SANDBOX_LANE, SANDBOX_SLICES, sandboxOf } from '@sundial/kernel/read/rig-session.js';
import type { Effect, KernelState, Rule, SanitizedEvent, SandboxSlices } from '@sundial/kernel/types.js';
import { draftTrack } from './draft-track.js';
import { loopTrack } from './loop-track.js';
import { ownerAsk } from './owner-ask.js';
import { promiseTrack } from './promise-track.js';
import { watchRules } from './watch-rules.js';
import { workbench } from './workbench.js';

/**
 * S4: the sandbox lane, the one rule a sandboxed row reaches (`reduce` skips every other for it, `sandboxOf`).
 *
 * A rig chat may run the daily tools that write the record, so the rig can test that they work. What they write folds
 * here, by the owner's own rules, over the owner's state with the chat's own copy of their slices in place
 * (`state.sandbox[sessionId]`), and only those slices are kept: the owner's never move. What the rules ask for is
 * contained to the chat: a notice becomes one line in its own thread (`SANDBOX_CHANNEL`, never the gate, the companion,
 * ntfy, a banner or a knock); an emitted row carries the sandbox mark, so it folds here too; a job runs, marked, so its
 * result never reaches the owner's shelf or phone; every write to the owner's tables (the promise ledger, the asks, the
 * shelf), every judge and every other effect is dropped. A rule the chat adopts is folded (adopted, paused, resumed,
 * dropped) and never stepped: it never reads the owner's data.
 *
 * The sandbox is made when the chat is marked rig (`thread:model {rig: true}`, after `rigSessions`), the newest five kept.
 * A clock tick fires each sandbox's due wake-ups and lets its question expire, as the owner's. It never queues a repeat:
 * a sandbox's repeating job is kept and stopped, and its schedule never fires.
 *
 * One job at a time per rig chat: a request while its job is open or queued is dropped (the tool says so first). The
 * work loop runs a sandbox job prompt-only, on a runtime, under a small cap and outside the owner's hand budget
 * (sundial-proactive work.js), and every report on it carries the mark.
 */
export const SANDBOXES_KEPT = 5;

/** Which of the owner's rules fold each sandboxed row, in the manifest's order. */
const LANE: Record<string, readonly Rule[]> = {
  'wakeup:scheduled': [loopTrack],
  'wakeup:cancelled': [loopTrack],
  'ask:owner-opened': [loopTrack, ownerAsk],
  'ask:owner-answered': [loopTrack, ownerAsk],
  'assistant:draft': [draftTrack],
  'draft:closed': [draftTrack],
  'commitment:heard': [promiseTrack],
  'commitment:closed': [promiseTrack],
  'work:requested': [workbench],
  'work:repeat-stopped': [workbench],
  'work:shelved': [workbench],
  'work:closed': [workbench],
  'work:stop-requested': [workbench],
  'rule:adopted': [watchRules],
  'rule:paused': [watchRules],
  'rule:resumed': [watchRules],
  'rule:dropped': [watchRules],
};
/** A tick: the wake-ups due and the question gone, never a job picked or a rule stepped. */
const TICK: readonly Rule[] = [loopTrack, ownerAsk];

const slicesOf = (state: KernelState): SandboxSlices => Object.fromEntries(SANDBOX_SLICES.map((k) => [k, state[k]])) as SandboxSlices;
const EMPTY: SandboxSlices = slicesOf(createInitialState('sandbox'));

/** One effect of a sandboxed fold, kept inside the chat `sessionId`, or nothing. */
function contain(effect: Effect, sessionId: string): Effect[] {
  if (effect.type === 'EmitEvent') {
    const p = effect.event.payload as Record<string, unknown>;
    if (effect.event.type !== 'notice:candidate') return [{ ...effect, event: { ...effect.event, payload: { ...p, sandbox: sessionId } } }];
    // A job's result is said where it is: in this test chat, never "on your shelf".
    const observation = typeof p.observation === 'string' ? p.observation.replace(' on your shelf', ' in this test chat (not on your shelf)') : p.observation;
    const line = { noticeKey: p.key, kind: p.kind, observation, evidence: p.evidence, ...(typeof p.askId === 'string' ? { askId: p.askId } : {}) };
    return [{ type: 'Notify', channel: SANDBOX_CHANNEL, payload: { ...line, sessionId, sandbox: sessionId } }];
  }
  if (effect.type === 'StartSubagent') return [{ ...effect, job: { ...effect.job, sandbox: sessionId } }];
  if (effect.type === 'StopSubagent') return [{ ...effect, sandbox: sessionId }];
  return [];
}

/** Fold `event` with `rules` over the owner's state with the sandbox's slices in place; keep only the sandbox's. */
function fold(state: KernelState, sessionId: string, rules: readonly Rule[], event: SanitizedEvent): { state: KernelState; effects: Effect[] } {
  const was = state.sandbox?.[sessionId];
  if (!was) return { state, effects: [] };
  let view: KernelState = { ...state, ...was };
  const effects: Effect[] = [];
  for (const rule of rules) {
    const out = rule(view, event);
    view = out.state;
    effects.push(...out.effects.flatMap((e) => contain(e, sessionId)));
  }
  const kept = slicesOf(view);
  const moved = SANDBOX_SLICES.some((k) => kept[k] !== was[k]);
  return { state: moved ? { ...state, sandbox: { ...state.sandbox, [sessionId]: kept } } : state, effects };
}

export const sandbox: Rule = (state, event) => {
  if (event.type === 'thread:model') {
    const id = event.payload.sessionId;
    if (!isRigSession(state, id)) return { state, effects: [] };
    const was = state.sandbox ?? {};
    const kept = Object.entries(was).filter(([k]) => k !== id);
    return { state: { ...state, sandbox: Object.fromEntries([...kept, [id as string, was[id as string] ?? EMPTY]].slice(-SANDBOXES_KEPT)) }, effects: [] };
  }
  if (event.type === 'clock:tick') {
    let next = state;
    const effects: Effect[] = [];
    for (const id of Object.keys(state.sandbox ?? {})) {
      const out = fold(next, id, TICK, event);
      next = out.state;
      effects.push(...out.effects);
    }
    return { state: next, effects };
  }
  const id = sandboxOf(state, event);
  const rules = LANE[event.type];
  if (!id || !rules) return { state, effects: [] };
  const bench = state.sandbox?.[id]?.workbench;
  const repeat = typeof event.payload.repeat === 'string' && event.payload.repeat.trim() !== '';
  if (event.type === 'work:requested' && !repeat && (bench?.open || (bench?.queue ?? []).length > 0)) return { state, effects: [] };
  return fold(state, id, rules, event);
};
Object.defineProperty(sandbox, 'name', { value: SANDBOX_LANE });
