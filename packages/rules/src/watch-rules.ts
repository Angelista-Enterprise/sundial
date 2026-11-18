import type { KernelState, Rule, SanitizedEvent } from '@sundial/kernel/types.js';
import { deriveId } from '@sundial/helpers/derive-id.js';
import {
  emptyWatchFlags,
  emptyWatchRuntime,
  MAX_RECENT_FIRES,
  newWatchStats,
  predictedFrom,
  reviewAskId,
  ruleReview,
  stepWatch,
  stepWatchFlags,
  validateWatchRule,
  asksInstead,
  MAX_JUDGED,
  MAX_REACH_ASKS,
  watchActions,
  watchCandidate,
  watchEmit,
  type WatchStats,
} from '@sundial/kernel/watch.js';
import { flowFrom, autoReach, reachAutoAskId, reachOffer, reachYes, watchRoomFor } from '@sundial/kernel/watch-flow.js';

/**
 * The interpreter for the rules Gnomon writes (see `@sundial/kernel/watch.ts`).
 *
 * `rule:adopted` adds or replaces a watch (by id; the same id again is its
 * next version), `rule:dropped` removes one, `rule:paused` / `rule:resumed`
 * keep one without stepping it. An adoption may name its `flow` ({id, title,
 * step}); the record keeps it, and `MAX_WATCH_RULES` counts flows. Every other event steps every watch; a fire
 * becomes one `notice:candidate` of kind `watch:<id>`, and the gate decides as
 * it does for every rule a person wrote. A rule with `emit` also raises that
 * `custom:*` event, which re-enters the fold, so the next step of a flow hears
 * it; one with no `say` raises only the event. A spec that fails validation in the
 * log is ignored, so a bad row can never break the fold.
 *
 * Each rule keeps a record (`stats`): the backtest it was adopted on, its
 * fires, and the owner's verdicts on its notices. On a day boundary a rule
 * that is mostly wrong, silent for a month, or drifting from its backtest is
 * put to the owner as a question; the answer drops or pauses it.
 *
 * A rule's `reach` is asked every time: the fire opens a question whose yes
 * appends `reach:approved` (the owner's tap, for the action gate's performer),
 * and counts. After `REACH_AUTO_AFTER` yeses in a row the review offers to let
 * the rule run that tool alone; "Let it run" appends `rule:auto-granted`, and
 * from then a fire appends `reach:approved` with `auto: true` instead of
 * asking, until `rule:auto-revoked`.
 */
export const watchRules: Rule = (state, event) => {
  const watch = state.watch ?? { rules: [], runtime: {} };

  if (event.type === 'rule:adopted') {
    const checked = validateWatchRule((event.payload as { rule?: unknown })?.rule);
    if (!('rule' in checked)) return { state, effects: [] };
    const id = checked.rule.id;
    // A step of a flow: kept on its record, and kept across a version adopted without one (the rules card's edit).
    const given = (event.payload as { flow?: unknown }).flow;
    const parsed = given === undefined ? undefined : flowFrom(given);
    const flow = parsed && !('error' in parsed) ? parsed : watch.stats?.[id]?.flow;
    // Full is full, as the adopt tool says: a 21st flow is ignored, never allowed to evict the oldest rule in silence.
    if (watchRoomFor(watch, id, flow) !== null) return { state, effects: [] };
    const rules = [...watch.rules.filter((r) => r.id !== id), checked.rule];
    const stats = { ...watch.stats, [id]: newWatchStats(event.ts, (watch.stats?.[id]?.version ?? 0) + 1, predictedFrom((event.payload as { predicted?: unknown }).predicted), flow) };
    const paused = (watch.paused ?? []).filter((p) => p !== id);
    return { state: { ...state, watch: { ...watch, rules, runtime: { ...watch.runtime, [id]: emptyWatchRuntime() }, stats, paused } }, effects: [] };
  }
  if (event.type === 'rule:dropped') {
    const id = (event.payload as { id?: unknown })?.id;
    if (!watch.rules.some((r) => r.id === id)) return { state, effects: [] };
    const { [id as string]: _gone, ...runtime } = watch.runtime;
    const { [id as string]: _record, ...stats } = watch.stats ?? {};
    return { state: { ...state, watch: { ...watch, rules: watch.rules.filter((r) => r.id !== id), runtime, stats, paused: (watch.paused ?? []).filter((p) => p !== id) } }, effects: [] };
  }
  if (event.type === 'rule:paused' || event.type === 'rule:resumed') {
    const id = (event.payload as { id?: unknown })?.id;
    if (typeof id !== 'string' || !watch.rules.some((r) => r.id === id)) return { state, effects: [] };
    const was = watch.paused ?? [];
    if (event.type === 'rule:paused') return was.includes(id) ? { state, effects: [] } : { state: { ...state, watch: { ...watch, paused: [...was, id] } }, effects: [] };
    if (!was.includes(id)) return { state, effects: [] };
    // Resumed from scratch: a stretch held before the pause is not held now.
    return { state: { ...state, watch: { ...watch, paused: was.filter((p) => p !== id), runtime: { ...watch.runtime, [id]: emptyWatchRuntime() } } }, effects: [] };
  }
  // The owner's verdict on one fire (the sheet's tap): counted where a notice's verdict is, so the gate's precision moves, and kept with its time.
  if (event.type === 'rule:verdict') {
    const { id, fireId, useful } = event.payload as { id?: unknown; fireId?: unknown; useful?: unknown };
    const record = typeof id === 'string' ? watch.stats?.[id] : undefined;
    if (!record || typeof fireId !== 'string' || fireId === '' || typeof useful !== 'boolean') return { state, effects: [] };
    // The same fire judged again: the later verdict replaces the earlier one, in the counts too.
    const before = record.judged?.find((j) => j.fireId === fireId);
    const verdicts = { ...record.verdicts };
    if (before) verdicts[before.useful ? 'useful' : 'wrong'] -= 1;
    verdicts[useful ? 'useful' : 'wrong'] += 1;
    const judged = [...(record.judged ?? []).filter((j) => j.fireId !== fireId), { fireId: fireId.slice(0, 120), useful, ts: event.ts }].slice(-MAX_JUDGED);
    return { state: { ...state, watch: { ...watch, stats: { ...watch.stats, [id as string]: { ...record, verdicts, judged } } } }, effects: [] };
  }
  // The owner's say on one rule's reach: let it run that tool alone, or ask again.
  if (event.type === 'rule:auto-granted' || event.type === 'rule:auto-revoked') {
    const { id, tool } = event.payload as { id?: unknown; tool?: unknown };
    const record = typeof id === 'string' ? watch.stats?.[id] : undefined;
    const rule = watch.rules.find((r) => r.id === id);
    if (!record || !rule || typeof tool !== 'string' || !(rule.do ?? []).some((a) => 'reach' in a && a.reach.tool === tool)) return { state, effects: [] };
    const was = record.reach?.[tool] ?? { approvals: 0, auto: false };
    const granted = event.type === 'rule:auto-granted';
    // Revoked: back to asking, and the count starts again.
    const next: WatchStats = { ...record, reach: { ...record.reach, [tool]: { ...was, auto: granted, ...(granted ? {} : { approvals: 0 }) } } };
    return { state: { ...state, watch: { ...watch, stats: { ...watch.stats, [id as string]: next } } }, effects: [] };
  }
  // The owner's answer to a review question, or to a rule's reach — and, like any event, a step for the rules that watch answers (a flow's branch).
  if (event.type === 'ask:owner-answered') {
    const out = answered(state, event);
    const stepped = stepRules(out.state, event);
    return { state: stepped.state, effects: [...out.effects, ...stepped.effects] };
  }
  if (event.type === 'day:boundary') {
    // A rule adopted before rules kept a record starts one here, so its month of silence is counted from today.
    const missing = watch.rules.filter((r) => !watch.stats?.[r.id]);
    if (missing.length > 0) return { state: { ...state, watch: { ...watch, stats: { ...watch.stats, ...Object.fromEntries(missing.map((r) => [r.id, newWatchStats(event.ts, 1)])) } } }, effects: [] };
    for (const rule of watch.rules) {
      if (watch.paused?.includes(rule.id)) continue;
      const review = ruleReview(rule, watch.stats?.[rule.id], event.ts);
      // A reach that has earned it is offered to run alone; the owner confirms, nothing is granted unasked.
      const offer = review === null ? reachOffer(rule, watch.stats?.[rule.id], event.ts) : null;
      if (offer !== null) {
        const record = watch.stats![rule.id]!;
        const stats = { ...watch.stats, [rule.id]: { ...record, reachOffer: offer.tool, reach: { ...record.reach, [offer.tool]: { ...record.reach![offer.tool]!, offeredAt: event.ts } } } };
        const ask = { askId: reachAutoAskId(rule.id), question: offer.question, reason: `watch rule "${rule.title}" (${rule.id}): reach ${offer.tool}`, choices: offer.choices };
        return { state: { ...state, watch: { ...watch, stats } }, effects: [{ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'watch-rules', 'reach-offer'), type: 'ask:owner-opened', ts: event.ts, payload: ask } }] };
      }
      if (review === null) continue;
      const stats = { ...watch.stats, [rule.id]: { ...watch.stats![rule.id]!, askedAt: event.ts } };
      const ask = { askId: reviewAskId(rule.id), question: review.question, reason: `watch rule "${rule.title}" (${rule.id}): ${review.reason}`, choices: review.choices };
      // One question a day at most: the rest wait for the next boundary.
      return { state: { ...state, watch: { ...watch, stats } }, effects: [{ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'watch-rules', 'review'), type: 'ask:owner-opened', ts: event.ts, payload: ask } }] };
    }
  }
  // A rule Gnomon proposed on the shelf (a `rule-idea` job), held until the owner answers the card.
  if (event.type === 'work:shelved') {
    const checked = validateWatchRule((event.payload as { rule?: unknown })?.rule);
    if (!('rule' in checked)) return { state, effects: [] };
    const id = deriveId(event.ts, event.id, 'shelf');
    const proposed = Object.fromEntries([...Object.entries(watch.proposed ?? {}), [id, checked.rule]].slice(-10));
    // What it stands on, for the proposals card: the job `workbench` just closed (it folds first) names its seed.
    const job = state.workbench.recent.find((r) => r.id === (event.payload as { jobId?: unknown }).jobId);
    const seed = typeof job?.detail.seed === 'string' ? job.detail.seed : null;
    const from = { ...watch.proposedFrom, [id]: { at: event.ts, seed, days: Number(job?.detail.days) || 0 } };
    const proposedFrom = Object.fromEntries(Object.entries(from).filter(([k]) => k in proposed));
    return { state: { ...state, watch: { ...watch, proposed, proposedFrom } }, effects: [] };
  }
  if (event.type === 'feedback:verdict') {
    const v = event.payload as { artifactKind?: unknown; artifactId?: unknown; verdict?: unknown };
    const rule = v.artifactKind === 'knowledge_entry' && typeof v.artifactId === 'string' ? watch.proposed?.[v.artifactId] : undefined;
    if (!rule) {
      // A verdict on a rule's notice: on the gate key itself (phasic), or through the insight the tonic path wrote.
      const key = v.artifactKind === 'notice' ? v.artifactId : v.artifactKind === 'knowledge_entry' ? state.memory.recentInsights.find((i) => i.id === v.artifactId)?.noticeKey : undefined;
      const id = typeof key === 'string' && key.startsWith('watch:') ? key.split(':')[1] : undefined;
      const verdict = v.verdict === 'useful' || v.verdict === 'wrong' || v.verdict === 'not-now' ? v.verdict : null;
      const record = id ? watch.stats?.[id] : undefined;
      if (!record || verdict === null) return { state, effects: [] };
      const next: WatchStats = { ...record, verdicts: { ...record.verdicts, [verdict]: record.verdicts[verdict] + 1 } };
      return { state: { ...state, watch: { ...watch, stats: { ...watch.stats, [id!]: next } } }, effects: [] };
    }
    const { [v.artifactId as string]: _answered, ...proposed } = watch.proposed ?? {};
    const { [v.artifactId as string]: _from, ...proposedFrom } = watch.proposedFrom ?? {};
    // Keep is the owner's yes. Adopted through the same event a chat adoption appends, so the log says so.
    const effects: ReturnType<Rule>['effects'] =
      v.verdict === 'useful' ? [{ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'watch-rules', 'adopt'), type: 'rule:adopted', ts: event.ts, payload: { rule, via: v.artifactId } } }] : [];
    return { state: { ...state, watch: { ...watch, proposed, proposedFrom } }, effects };
  }
  return stepRules(state, event);
};

/** Every adopted rule, one event further: what fires speaks, asks, reaches and emits. */
function stepRules(state: KernelState, event: SanitizedEvent): ReturnType<Rule> {
  const watch = state.watch ?? { rules: [], runtime: {} };
  if (watch.rules.length === 0 || event.type === 'notice:candidate') return { state, effects: [] };

  const daytime = state.mind.circadian === 'day';
  // The same reducer the backtest folds, over the same types: an active-time clock means one thing.
  const flagsBefore = watch.flags ?? emptyWatchFlags();
  const flags = stepWatchFlags(flagsBefore, event);
  const runtime = { ...watch.runtime };
  const effects: ReturnType<Rule>['effects'] = [];
  let changed = flags !== flagsBefore;
  let stats = watch.stats;
  for (const rule of watch.rules) {
    if (watch.paused?.includes(rule.id)) continue;
    const before = runtime[rule.id] ?? emptyWatchRuntime();
    const { rt, fires } = stepWatch(rule, before, event, { daytime, flags, timeZone: state.config.timezone });
    if (rt !== before) {
      runtime[rule.id] = rt;
      changed = true;
    }
    for (const f of fires) {
      let record = stats?.[rule.id] ?? newWatchStats(event.ts, 1);
      const auto = autoReach(record);
      watchActions(rule, f, event.ts, auto).forEach((a, i) => {
        effects.push({ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'watch-rules', rule.id, f.key ?? '', `do${i}`), type: a.type, ts: event.ts, payload: a.payload } });
        // A reach's question is remembered, so its answer finds the tool it would run.
        const reach = a.payload.reach as { tool: string; brief: string } | undefined;
        if (reach) record = { ...record, reachAsks: Object.fromEntries([...Object.entries(record.reachAsks ?? {}), [a.payload.askId as string, reach]].slice(-MAX_REACH_ASKS)) };
      });
      // A rule that emits raises its event for the next step to hear, as the built-in rules raise theirs.
      const emitted = watchEmit(rule, f, record.flow?.id);
      if (emitted) effects.push({ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'watch-rules', rule.id, f.key ?? '', f.escalated ? 'again' : '', 'emit'), type: emitted.type, ts: event.ts, payload: emitted.payload } });
      // A silent step (no `say`) speaks through nothing but its event.
      if (!asksInstead(rule, auto) && rule.say !== '') effects.push({ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'watch-rules', rule.id, f.key ?? '', f.escalated ? 'again' : ''), type: 'notice:candidate', ts: event.ts, payload: { ...watchCandidate(rule, f.text, f.payload, event.ts, f.key, record, f.escalated) } } });
      stats = { ...stats, [rule.id]: { ...record, fires: record.fires + 1, recent: [...record.recent, event.ts].slice(-MAX_RECENT_FIRES) } };
    }
  }
  return changed || effects.length > 0 ? { state: { ...state, watch: { ...watch, runtime, flags, ...(stats ? { stats } : {}) } }, effects } : { state, effects: [] };
}

/** The owner's answer: to a reach's question, to the offer to let a reach run alone, or to a review question. */
function answered(state: KernelState, event: SanitizedEvent): ReturnType<Rule> {
  const watch = state.watch ?? { rules: [], runtime: {} };
  const askId = typeof event.payload.askId === 'string' ? event.payload.askId : '';
  const said = typeof event.payload.answer === 'string' ? event.payload.answer.trim() : '';
  // A reach's question: a yes is the tap that performs it (journaled as `reach:approved`) and counts toward acting alone; anything else starts the count again.
  const asked = Object.entries(watch.stats ?? {}).find(([, r]) => r.reachAsks?.[askId] !== undefined);
  if (asked) {
    const [id, record] = asked;
    const { [askId]: ask, ...reachAsks } = record.reachAsks!;
    const yes = reachYes(said);
    const was = record.reach?.[ask!.tool] ?? { approvals: 0, auto: false };
    const next: WatchStats = { ...record, reachAsks, reach: { ...record.reach, [ask!.tool]: { ...was, approvals: yes ? was.approvals + 1 : 0 } } };
    const effects: ReturnType<Rule>['effects'] = yes ? [{ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'watch-rules', 'reach', id), type: 'reach:approved', ts: event.ts, payload: { rule: id, tool: ask!.tool, brief: ask!.brief, askId } } }] : [];
    return { state: { ...state, watch: { ...watch, stats: { ...watch.stats, [id]: next } } }, effects };
  }
  const offered = watch.rules.find((r) => reachAutoAskId(r.id) === askId);
  const tool = offered ? watch.stats?.[offered.id]?.reachOffer : undefined;
  if (offered && tool) {
    if (!/^let\b/i.test(said)) return { state, effects: [] };
    return { state, effects: [{ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'watch-rules', 'reach-auto', offered.id), type: 'rule:auto-granted', ts: event.ts, payload: { id: offered.id, tool, via: 'review' } } }] };
  }
  const rule = watch.rules.find((r) => reviewAskId(r.id) === askId);
  const answer = said.toLowerCase();
  const type = answer.startsWith('drop') ? 'rule:dropped' : answer.startsWith('pause') ? 'rule:paused' : null;
  if (!rule || type === null) return { state, effects: [] };
  return { state, effects: [{ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'watch-rules', 'review', rule.id), type, ts: event.ts, payload: { id: rule.id, via: 'review' } } }] };
}
