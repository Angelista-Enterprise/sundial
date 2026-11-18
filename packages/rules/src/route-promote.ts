import { deriveId } from '@sundial/helpers/derive-id.js';
import { isRedactedPlaceholder } from '@sundial/helpers/redact/redact-policy.js';
import { part, routeKeyOf, routesOf, type StepRow } from '@sundial/helpers/screen-routes.js';
import { isRigSession } from '@sundial/kernel/read/rig-session.js';
import type { KernelState, Rule } from '@sundial/kernel/types.js';
import { byGnomonMarked } from './by-gnomon.js';
import { entityId, type FactCandidate } from './entity-extract.js';

/**
 * Gnomon's acts as knowledge. A screen route that ran clean (the call ended
 * well and its last step worked: ok, and the screen changed) is offered as a
 * fact about its app: `app routeWorks <route key>`, provenance `act`, so it is
 * never mistaken for a belief about the owner. The key is the route `routesOf`
 * keeps for the run (the final attempt, without tidying, circles or a typed
 * value), written as its steps' verbs, roles and names, never the goal's free
 * text: the same route twice is the same key, and `contradictionCheck`'s two
 * observations promote it.
 *
 * Bounded: the newest 8 runs of 16 steps, and one offer per run and key, so a
 * run that ends clean five times offers its route once. A run that touched the
 * screen rig's test window is not learned from at all: when any of its steps is
 * marked `rig`, or the window in front when a step came was (a run's first step,
 * an app switch, carries no title of its own), or the step's chat session is
 * one of the rig's (`isRigSession`, Round 4: its run thread is on the record),
 * the whole run is dropped. A rig run that fell back to the companion thread is
 * not marked (`rigSessions`), so only its rig windows drop it.
 */
const MAX_RUNS = 8;
const MAX_STEPS = 16;
const SCREEN_TOOLS = new Set(['screen_act', 'screen_undo']);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** A record with `key` set last, the oldest dropped past `max`. */
const newest = <T>(map: Record<string, T>, key: string, value: T, max: number): Record<string, T> =>
  Object.fromEntries([...Object.entries(map).filter(([k]) => k !== key), [key, value] as [string, T]].slice(-max));

/** One step of a route as the key spells it (in helpers, so screen_act's replay reads the same key). */
export { part };

/** The stable key of the route `routesOf` keeps for one run's steps, or null when the run holds no route. */
export function routeKey(steps: readonly StepRow[]): string | null {
  const route = routesOf(steps)[0];
  const key = route ? routeKeyOf(route.steps) : '';
  return key === '' ? null : key;
}

const EMPTY: NonNullable<KernelState['routePromote']> = { runs: {}, last: null, said: {} };

export const routePromote: Rule = (state, event) => {
  const slice = state.routePromote ?? EMPTY;
  const p = event.payload;

  if (event.type === 'screen:step') {
    const app = str(p.processName);
    if (!app || isRedactedPlaceholder(app) || !str(p.verb)) return { state, effects: [] };
    const step: StepRow = {
      verb: str(p.verb),
      ...(str(p.role) ? { role: str(p.role) } : {}),
      ...(Array.isArray(p.screenText) ? { screenText: p.screenText.filter((x): x is string => typeof x === 'string').slice(0, 1) } : {}),
      ...(str(p.goal) ? { goal: str(p.goal) } : {}),
      ...(str(p.session) ? { session: str(p.session) } : {}),
      ...(typeof p.ok === 'boolean' ? { ok: p.ok } : {}),
      ...(typeof p.changed === 'boolean' ? { changed: p.changed } : {}),
      ...(typeof p.typed === 'number' ? { typed: p.typed } : {}),
      ...(str(p.key) ? { key: str(p.key) } : {}),
      ...(p.replaced === true ? { replaced: true } : {}),
      ...(byGnomonMarked(state, event) === 'rig' || state.byGnomon?.focus === 'rig' || isRigSession(state, p.session) ? { rig: true } : {}),
      at: event.ts,
    };
    const run = `${app}\n${step.goal ?? ''}\n${step.session ?? ''}`;
    const runs = newest(slice.runs, run, [...(slice.runs[run] ?? []), step].slice(-MAX_STEPS), MAX_RUNS);
    return { state: { ...state, routePromote: { ...slice, runs, last: run } }, effects: [] };
  }

  if (event.type !== 'action:performed' || !SCREEN_TOOLS.has(String(p.tool)) || slice.last === null) return { state, effects: [] };
  const run = slice.last;
  const steps = slice.runs[run] ?? [];
  const end = steps.at(-1);
  const key = p.outcome === 'ok' && end?.ok === true && end.changed === true && !steps.some((s) => s.rig === true) ? routeKey(steps) : null;
  const done = { ...state, routePromote: { ...slice, last: null } };
  if (key === null || slice.said[run] === key) return { state: done, effects: [] };

  const app = run.split('\n')[0]!;
  const candidate: FactCandidate = {
    entityId: entityId('app', app),
    entityKind: 'app',
    canonicalName: app,
    predicate: 'routeWorks',
    object: key,
    confidence: 70,
    sourceEventId: event.id,
    projectId: null,
    provenance: 'act',
  };
  return {
    state: { ...done, routePromote: { ...done.routePromote, said: newest(slice.said, run, key, MAX_RUNS) } },
    effects: [{ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'route-promote', run), type: 'entity:fact-candidate', ts: event.ts, payload: candidate as unknown as Record<string, unknown> } }],
  };
};
