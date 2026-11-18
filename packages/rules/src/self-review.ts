import { deriveId } from '@sundial/helpers/derive-id.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { goalName, skillLabel } from '@sundial/helpers/screen-routes.js';
import { isRigSession } from '@sundial/kernel/read/rig-session.js';
import type { Effect, KernelState, ReviewCluster, ReviewProposal, Rule, SanitizedEvent, SelfReviewSlice } from '@sundial/kernel/types.js';
import { byGnomonMarked, isRigWindow } from './by-gnomon.js';
import { entityId } from './entity-extract.js';
import { keepWords, proposalOf } from './review-proposal.js';
import { part } from './route-promote.js';
import { spareSlot } from './workbench.js';

/**
 * Round 5: Gnomon reviews its own failures, on the events that make a review cheap, never on a clock.
 *
 * Counted, per app, chat and kind: a step that failed (`screen:step` with `ok: false`, which a refused act always
 * writes too, under the same id, so `seen` counts the pair once), an app's refusal (`screen:acted` refused), a
 * gate deny (`action:decided` `deny`), the owner's no to an ask (`approval:answered` by the owner), and a reply
 * Gnomon itself marked as claiming an act it never ran (`review:unbacked-claim`, filed under `GNOMON`). Never the
 * rig's: a step in its test window or its chat, a deny in an unattended run (`testMode`), an answer the rig gave.
 * Gnomon's own acts are exactly what is reviewed, so the `ownerOnly` fence is not applied here.
 *
 * A cluster of `CLUSTER_MIN` is reviewed on the first event that says the foreground does not need the slot: the
 * owner went idle (`idle:start`), the chat that held the failures ended its turn (`chat:said`), or another job
 * freed the slot (`work:closed`, `work:shelved`), and the review's slot is spare (`spareSlot`: none open or
 * queued, the 30 min gap after the last review, a ceiling of 12 a day, the breaker). Then one `work:requested` of `by: 'review'`, once
 * per cluster. Set 3 R4: the review used to wait on the day's 3 jobs, which Gnomon's own spare-time picks spend
 * first; on a copy of the record it asked 6 times in two weeks against 1637 ripe triggers that found them spent.
 * The job reads the cluster and shelves one proposal (`review`): drop a route,
 * an app note for the brief, or a fact about the app. A kept skill whose route fails `DROP_SKILL_AFTER` times is
 * shelved for dropping. Nothing is applied before the owner's Keep (`feedback:verdict` useful); any other verdict
 * dismisses it. `review:proposed`, `review:accepted` and `review:dismissed` are on the log, so the rates can be read.
 *
 * A route that ran clean `SKILL_MIN` times on `SKILL_DAYS` owner-local days with no failed step is offered as a
 * skill with no model, the moment its run lands: one quiet question, "Keep this as a skill?", as Gnomon's proposal
 * (`assistant:proposal`, Today's and the shelf card's "Gnomon suggests") and as a notice whose one button keeps it
 * (`gnomon_record_outcome` accepted, the slip's offer). Either answer (`assistant:response`) settles both.
 * Set 4: at 5 clean runs of one key the record offered nothing (19 routeWorks facts, 18 keys, one at 2). Replayed
 * over every step on the record: owner routes at 2, 3, 4, 5 clean runs were 8, 4, 0, 0; at 2 or 3, all but one ran
 * on a single day (same-minute double runs, rig fixture routes in an unmarked chat). 3 runs on 2 days offers that one.
 */
export const CLUSTER_MIN = 3;
export const SKILL_MIN = 3;
export const SKILL_DAYS = 2;
const MAX_ROUTE_DAYS = 7;
/** An offer to keep a skill stays worth its line for a day: a list row, never an interruption. */
const SKILL_OFFER_LIFE_MS = 24 * 60 * 60 * 1000;
export const DROP_SKILL_AFTER = 3;
/** The app a failure of Gnomon's own reply is filed under: not a screen app, so its notes reach every turn's brief. */
export const GNOMON = 'Gnomon';
const MAX_PENDING = 8;
const MAX_SEEN = 32;
const MAX_PROPOSED = 10;
const MAX_ROUTES = 32;
const MAX_SKILLS = 20;
const MAX_NOTES = 20;
const MAX_STEPS = 5;
const MAX_DISMISSED = 32;

/** Set 5 R3: what a proposal is about, whatever row put it: the owner's no to it is kept by this, so it is never put again. */
export function proposalSignature(p: ReviewProposal): string {
  const what = p.kind === 'drop-route' || p.kind === 'skill' ? p.routeKey : p.kind === 'app-note' ? p.line : p.kind === 'fact' ? `${p.predicate} ${p.object}` : p.name;
  return `${p.kind}\n${p.app}\n${what}`;
}
const refused = (slice: SelfReviewSlice, p: ReviewProposal): boolean => (slice.dismissed ?? []).includes(proposalSignature(p));
/** A no that says the proposal is wrong, not that the moment was: `not-now` may come back. */
const NO = new Set(['wrong', 'rejected', 'dismissed']);

const EMPTY: SelfReviewSlice = { pending: {}, seen: [], proposed: {}, routes: {}, skills: {}, notes: [] };
const str = (v: unknown, n = 200): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, n) : undefined);
const newest = <T>(map: Record<string, T>, key: string, value: T, max: number): Record<string, T> =>
  Object.fromEntries([...Object.entries(map).filter(([k]) => k !== key), [key, value] as [string, T]].slice(-max));
const without = <T>(map: Record<string, T>, key: string): Record<string, T> => Object.fromEntries(Object.entries(map).filter(([k]) => k !== key));
type CountedRoute = SelfReviewSlice['routes'][string];
/**
 * Set 5 R3: the routes kept past `MAX_ROUTES` are the strongest, never the newest. Replayed on a copy of the record,
 * one task's growing route writes a key per call and most keys run once, so 32 one-off keys pushed out the one owner
 * route that had run clean 3 times on 2 days before its third run could offer it. Out first: the fewest clean runs,
 * then the oldest; an offered route (a kept skill counts its failures on it) last; the newest always stays.
 */
const strongest = (routes: Record<string, CountedRoute>, key: string, route: CountedRoute): Record<string, CountedRoute> => {
  const rest = Object.entries(routes).filter(([k]) => k !== key);
  const weak = (r: CountedRoute) => (r.offeredAt ? Number.MAX_SAFE_INTEGER : r.clean);
  const out = rest.length < MAX_ROUTES ? [] : rest.map(([k, r], i) => ({ k, w: weak(r), i })).sort((a, b) => a.w - b.w || a.i - b.i).slice(0, rest.length - MAX_ROUTES + 1).map((x) => x.k);
  return Object.fromEntries([...rest.filter(([k]) => !out.includes(k)), [key, route] as [string, CountedRoute]]);
};
const emit = (event: SanitizedEvent, tag: string, type: string, payload: Record<string, unknown>): Effect => ({ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'self-review', tag), type, ts: event.ts, payload } });

/** The rig's: a step in its test window, while its window is in front, or in its chat. */
const rigs = (state: KernelState, event: SanitizedEvent, title: unknown, session: unknown): boolean =>
  byGnomonMarked(state, event) === 'rig' || state.byGnomon?.focus === 'rig' || isRigWindow(title) || isRigSession(state, session);

/** The chat that last looked or acted in an app (`marks.chats`), for an app's refusal, which names none. */
const chatOf = (state: KernelState, app: string): string =>
  Object.entries(state.marks?.chats ?? {}).filter(([, c]) => c.app?.app === app).sort((a, b) => String(b[1].app?.at).localeCompare(String(a[1].app?.at)))[0]?.[0] ?? '';

/** One failure the event reports, or null: whose, where, what kind, the step in words. */
function failureOf(state: KernelState, event: SanitizedEvent): { id: string; app: string; session: string; kind: string; line: string; weight?: number } | null {
  const p = event.payload;
  if (event.type === 'screen:step' && p.ok === false) {
    const app = str(p.processName, 80);
    if (!app || rigs(state, event, p.windowTitle, p.session)) return null;
    const name = Array.isArray(p.screenText) && typeof p.screenText[0] === 'string' ? p.screenText[0] : '';
    const kind = str(p.reason, 40) ?? 'unknown';
    return { id: str(p.id, 80) ?? event.id, app, session: str(p.session) ?? '', kind, line: `${part({ verb: str(p.verb), role: str(p.role), key: str(p.key), screenText: name ? [name] : [] }) || 'a step'} (${kind})` };
  }
  if (event.type === 'screen:acted' && p.outcome === 'refused') {
    const target = (p.target ?? {}) as Record<string, unknown>;
    const app = str(target.processName, 80);
    const session = app ? chatOf(state, app) : '';
    if (!app || rigs(state, event, target.windowTitle, session)) return null;
    const kind = str(p.reason, 40) ?? 'unknown';
    return { id: str(p.id, 80) ?? event.id, app, session, kind, line: `an act the app refused (${kind})` };
  }
  if (event.type === 'action:decided' && p.verdict === 'deny') {
    const inputs = (p.inputs ?? {}) as { testMode?: unknown; facts?: { app?: unknown } };
    const app = str(inputs.facts?.app, 80) ?? str(p.tool, 80);
    // The record names no chat for a decision: its own `sessionId` when it has one, else the chat that last acted in the app.
    const session = str(p.sessionId) ?? (app ? chatOf(state, app) : '');
    if (!app || inputs.testMode === true || state.byGnomon?.focus === 'rig' || isRigSession(state, session)) return null;
    // The loop breaker (sundial-actions loop-breaker.js) stopped a turn: one stop is already a loop, so it is a ripe cluster alone.
    const breaker = p.breaker === 'loop' ? 'loop' : p.breaker === 'hunt' ? 'shell-hunt' : null;
    if (breaker) return { id: str(p.callId, 120) ?? event.id, app, session, kind: breaker, line: str(p.reason, 160) ?? `${str(p.tool, 80) ?? 'a tool'} stopped`, weight: CLUSTER_MIN };
    return { id: str(p.callId, 120) ?? event.id, app, session, kind: 'denied', line: `${str(p.tool, 80) ?? 'a tool'} denied by the gate` };
  }
  // Gnomon's own mark (`route-log.js`): a reply that said an act was done with no act in its turn. Its own app, `Gnomon`.
  if (event.type === 'review:unbacked-claim') {
    const session = str(p.sessionId) ?? '';
    if (isRigSession(state, session)) return null;
    return { id: `claim:${str(p.turnId, 120) ?? event.id}`, app: GNOMON, session, kind: 'unbacked-claim', line: `said "${str(p.claim, 20) ?? 'done'}" with no act in the turn` };
  }
  if (event.type === 'approval:answered' && p.by === 'owner' && !String(p.answer ?? '').startsWith('allowed')) {
    const ask = (state.approvals?.recent ?? []).find((a) => a.id === p.approvalId);
    const tool = str(ask?.tool ?? p.tool, 80);
    const app = str(ask?.app, 80) ?? tool;
    if (!app || isRigSession(state, ask?.sessionId ?? p.sessionId)) return null;
    // The tool and the app only: the ask's line can hold a preview of what was to be typed.
    return { id: `ask:${String(p.approvalId)}`, app, session: str(ask?.sessionId ?? p.sessionId) ?? '', kind: 'refused', line: `${tool ?? 'an ask'}${app !== tool ? ` in ${app}` : ''}: the owner said no` };
  }
  return null;
}

/** A shelf row Gnomon writes with no job, and the proposal it holds until the owner answers. */
function shelve(slice: SelfReviewSlice, event: SanitizedEvent, proposal: ReviewProposal, title: string, body: string): { slice: SelfReviewSlice; effects: Effect[] } {
  const id = deriveId(event.ts, event.id, 'self-review', 'shelf', proposal.kind, proposal.app);
  return {
    slice: { ...slice, proposed: newest(slice.proposed, id, proposal, MAX_PROPOSED) },
    effects: [
      { type: 'WriteDB', table: 'knowledge_entries', row: { id, kind: 'shelf', title, body: `${body}\n\n${keepWords(proposal)} Wrong throws it away.`, severity: null, dedupeKey: `shelf:${id}`, sourceEventId: event.id, createdAt: event.ts, importanceScore: 6 } },
      emit(event, `proposed:${id}`, 'review:proposed', { shelfId: id, app: proposal.app, kind: proposal.kind }),
    ],
  };
}

/** What the owner's Keep does: the event that applies it, or the note kept for the brief. A skill carries the verdict's chat, and `rig` when it is the rig's. */
function apply(state: KernelState, slice: SelfReviewSlice, event: SanitizedEvent, p: ReviewProposal): { slice: SelfReviewSlice; effects: Effect[] } {
  const session = str(event.payload.sessionId) ?? str(event.payload.session);
  switch (p.kind) {
    case 'drop-route':
      return { slice, effects: [emit(event, 'drop-route', 'screen:route-dropped', { app: p.app, routeKey: p.routeKey, by: 'review' })] };
    case 'app-note':
      return { slice: { ...slice, notes: [...slice.notes, { app: p.app, line: p.line, at: event.ts }].slice(-MAX_NOTES) }, effects: [] };
    case 'fact':
      return { slice, effects: [emit(event, 'fact', 'entity:fact-candidate', { entityId: entityId('app', p.app), entityKind: 'app', canonicalName: p.app, predicate: p.predicate, object: p.object, confidence: 70, sourceEventId: event.id, projectId: null, provenance: 'act' })] };
    case 'skill':
      return { slice, effects: [emit(event, 'skill', 'skill:adopted', { name: p.name, app: p.app, routeKey: p.routeKey, ...(session ? { session } : {}), ...(isRigSession(state, session) ? { rig: true } : {}) })] };
    case 'drop-skill':
      return { slice, effects: [emit(event, 'drop-skill', 'skill:dropped', { name: p.name })] };
  }
}

const done = (state: KernelState, slice: SelfReviewSlice, effects: Effect[] = []) => ({ state: { ...state, selfReview: slice }, effects });

/** One `work:requested` for the biggest ripe cluster (of one chat, when `session` names it), if the review's slot is spare. */
function ask(state: KernelState, slice: SelfReviewSlice, event: SanitizedEvent, session?: string): { state: KernelState; effects: Effect[] } {
  const ripe = Object.entries(slice.pending)
    .filter(([, c]) => c.n >= CLUSTER_MIN && (session === undefined || c.session === session))
    .sort((a, b) => b[1].n - a[1].n || a[1].firstAt.localeCompare(b[1].firstAt))[0];
  if (!ripe || !spareSlot(state, event.ts)) return { state, effects: [] };
  const [key, c] = ripe;
  const brief = `Review my own failed steps in ${c.app}: ${c.n} times "${c.kind}"${c.session ? ` in one chat` : ''}.`;
  return done(state, { ...slice, pending: without(slice.pending, key) }, [emit(event, `request:${key}`, 'work:requested', { subject: c.app, brief, by: 'review', review: c })]);
}

export const selfReview: Rule = (state, event) => {
  const slice = state.selfReview ?? EMPTY;
  const p = event.payload;

  // A failure: counted once, into its cluster.
  const failure = failureOf(state, event);
  if (failure) {
    const key = `${failure.app}\n${failure.session}\n${failure.kind}`;
    const was = slice.pending[key];
    const cluster: ReviewCluster = { app: failure.app, session: failure.session, kind: failure.kind, n: (was?.n ?? 0) + (failure.weight ?? 1), firstAt: was?.firstAt ?? event.ts, steps: [...(was?.steps ?? []), failure.line].slice(-MAX_STEPS) };
    let next: SelfReviewSlice = slice.seen.includes(failure.id) ? slice : { ...slice, seen: [...slice.seen, failure.id].slice(-MAX_SEEN), pending: newest(slice.pending, key, cluster, MAX_PENDING) };
    // A failed step counts against every counted route of its app that holds the same step.
    const step = event.type === 'screen:step' ? part({ verb: str(p.verb), role: str(p.role), key: str(p.key), screenText: Array.isArray(p.screenText) ? p.screenText.filter((x): x is string => typeof x === 'string').slice(0, 1) : [] }) : '';
    const effects: Effect[] = [];
    for (const [k, r] of Object.entries(next.routes)) {
      if (step === '' || r.app !== failure.app || !r.key.split(' > ').includes(step)) continue;
      const route = { ...r, failed: r.failed + 1 };
      next = { ...next, routes: { ...next.routes, [k]: route } };
      const skill = Object.entries(next.skills).find(([, s]) => s.app === r.app && s.routeKey === r.key)?.[0];
      if (skill && route.failed >= DROP_SKILL_AFTER && !route.dropOfferedAt && !refused(next, { kind: 'drop-skill', app: r.app, name: skill })) {
        // Set 5 R1: named by id and clean name (`skillLabel`): the kept name is an old run's goal, with its values.
        const label = skillLabel(r.app, skill, r.key);
        const out = shelve(next, event, { kind: 'drop-skill', app: r.app, name: skill }, `Drop the skill ${label}?`, `${r.app}: the route of ${label} failed ${route.failed} times since you kept it.`);
        next = { ...out.slice, routes: { ...out.slice.routes, [k]: { ...route, dropOfferedAt: event.ts } } };
        effects.push(...out.effects);
      }
    }
    return next === slice ? { state, effects: [] } : done(state, next, effects);
  }

  // The trigger: the owner went idle, a chat ended its turn, or the slot came free; then the biggest ripe cluster.
  if (event.type === 'idle:start' || event.type === 'chat:said' || event.type === 'work:closed') {
    const session = event.type === 'chat:said' ? str(p.sessionId) : undefined;
    if (event.type === 'chat:said' && session === undefined) return { state, effects: [] };
    return ask(state, slice, event, session);
  }

  // The job shelved its one proposal: held under the shelf row's id (the workbench writes that row) until the owner answers.
  if (event.type === 'work:shelved') {
    const job = [state.workbench.open, ...state.workbench.recent].find((j) => j?.id === p.jobId);
    const proposal = job?.kind === 'self-review' ? proposalOf(p.review, job.subject) : null;
    // Another job's result freed the slot: a cluster that waited on it goes now (a review's own, after the gap).
    if (!job || !proposal) return ask(state, slice, event);
    if (refused(slice, proposal)) return { state, effects: [] };
    const id = deriveId(event.ts, event.id, 'shelf');
    const meta = { cluster: String(job.detail.cluster ?? ''), n: Number(job.detail.failures ?? 0) };
    return done(state, { ...slice, proposed: newest(slice.proposed, id, { ...proposal, ...meta }, MAX_PROPOSED) }, [emit(event, `proposed:${id}`, 'review:proposed', { shelfId: id, app: proposal.app, kind: proposal.kind, ...meta })]);
  }

  // The owner's answer: Keep on the shelf, or accepted on Gnomon's proposal (by its id, or the newest open one, as
  // `loopTrack` closed it on this event), applies it; anything else dismisses it.
  const answered = event.type === 'feedback:verdict'
    ? { id: p.artifactKind === 'knowledge_entry' && typeof p.artifactId === 'string' ? p.artifactId : '', keep: p.verdict === 'useful', verdict: str(p.verdict, 20) ?? null }
    : event.type === 'assistant:response'
      ? ((l) => ({ id: l?.subject ?? '', keep: l?.detail?.outcome === 'accepted', verdict: String(l?.detail?.outcome ?? '') }))(state.loops.recent.find((l) => l.kind === 'proposal' && l.detail?.byEventId === event.id))
      : null;
  if (answered) {
    const { id, keep, verdict } = answered;
    const proposal = slice.proposed[id];
    if (!proposal) return { state, effects: [] };
    const rest = { ...slice, proposed: without(slice.proposed, id) };
    const remembered = NO.has(verdict ?? '') ? { ...rest, dismissed: [...(rest.dismissed ?? []).filter((s) => s !== proposalSignature(proposal)), proposalSignature(proposal)].slice(-MAX_DISMISSED) } : rest;
    if (!keep) return done(state, remembered, [emit(event, `dismissed:${id}`, 'review:dismissed', { shelfId: id, app: proposal.app, kind: proposal.kind, verdict })]);
    const out = apply(state, rest, event, proposal);
    return done(state, out.slice, [...out.effects, emit(event, `accepted:${id}`, 'review:accepted', { shelfId: id, app: proposal.app, kind: proposal.kind })]);
  }

  // A route that ran clean (`routePromote`'s offer, one per run): counted, and at SKILL_MIN on SKILL_DAYS with no failure offered as a skill.
  if (event.type === 'entity:fact-candidate' && p.predicate === 'routeWorks' && p.provenance === 'act' && p.entityKind === 'app') {
    const app = str(p.canonicalName, 80);
    const routeKey = str(p.object, 300);
    if (!app || !routeKey) return { state, effects: [] };
    const k = `${app}\n${routeKey}`;
    // The run's goal names the skill: `routePromote` remembers which run offered this key.
    const goal = Object.entries(state.routePromote?.said ?? {}).find(([run, key]) => key === routeKey && run.startsWith(`${app}\n`))?.[0].split('\n')[1];
    const was = slice.routes[k];
    const day = localDate(event.ts, state.config.timezone);
    const days = [...(was?.days ?? []).filter((d) => d !== day), day].slice(-MAX_ROUTE_DAYS);
    const route = { app, key: routeKey, name: was?.name ?? str(goal, 60) ?? routeKey.slice(0, 60), clean: (was?.clean ?? 0) + 1, days, failed: was?.failed ?? 0, ...(was?.offeredAt ? { offeredAt: was.offeredAt } : {}), ...(was?.dropOfferedAt ? { dropOfferedAt: was.dropOfferedAt } : {}) };
    const next: SelfReviewSlice = { ...slice, routes: strongest(slice.routes, k, route) };
    const kept = Object.values(slice.skills).some((s) => s.app === app && s.routeKey === routeKey);
    if (route.clean < SKILL_MIN || days.length < SKILL_DAYS || route.failed > 0 || route.offeredAt || kept || refused(slice, { kind: 'skill', app, name: route.name, routeKey })) return done(state, next);
    const id = deriveId(event.ts, event.id, 'self-review', 'shelf', 'skill', app);
    const line = `Keep this as a skill? "${goalName(route.name) ?? routeKey.slice(0, 60)}" in ${app} worked ${route.clean} of ${route.clean} times, on ${days.length} days.`;
    const candidate = { timestamp: event.ts, shape: 'self-report', kind: 'skill-offer', key: `skill-offer:${id}`, surprise: 1, precision: 1, valueHalfLifeMs: SKILL_OFFER_LIFE_MS, plain: true, observation: line, evidence: [`${app}: ${routeKey}`], concerns: [], offer: { tool: 'gnomon_record_outcome', args: { verdict: 'accepted', proposalId: id }, label: 'Keep as a skill' } };
    return done(state, { ...next, proposed: newest(next.proposed, id, { kind: 'skill', app, name: route.name, routeKey }, MAX_PROPOSED), routes: { ...next.routes, [k]: { ...route, offeredAt: event.ts } } }, [
      emit(event, `proposed:${id}`, 'review:proposed', { shelfId: id, app, kind: 'skill' }),
      emit(event, `propose:${id}`, 'assistant:proposal', { proposalId: id, summary: line, kind: 'skill' }),
      emit(event, `offer:${id}`, 'notice:candidate', candidate),
    ]);
  }

  // Skills the owner kept, and dropped. A kept skill's route counts its failures from here.
  if (event.type === 'skill:adopted') {
    const [name, app, routeKey] = [str(p.name, 60), str(p.app, 80), str(p.routeKey, 300)];
    if (!name || !app || !routeKey) return { state, effects: [] };
    const k = `${app}\n${routeKey}`;
    const routes = slice.routes[k] ? { ...slice.routes, [k]: { ...slice.routes[k]!, failed: 0 } } : slice.routes;
    // Set 2 R3: a skill the rig keeps (its chat's, or a row that says so) is never offered to the owner.
    const rig = p.rig === true || isRigSession(state, p.session) ? { rig: true as const } : {};
    return done(state, { ...slice, routes, skills: newest(slice.skills, name, { app, routeKey, at: event.ts, ...rig }, MAX_SKILLS) });
  }
  if (event.type === 'skill:dropped') {
    const name = str(p.name, 60);
    if (!name || !slice.skills[name]) return { state, effects: [] };
    return done(state, { ...slice, skills: without(slice.skills, name) });
  }
  return { state, effects: [] };
};
