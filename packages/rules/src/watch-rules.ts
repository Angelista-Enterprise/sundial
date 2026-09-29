import type { Rule } from '@sundial/kernel/types.js';
import { deriveId } from '@sundial/helpers/derive-id.js';
import {
  emptyWatchFlags,
  emptyWatchRuntime,
  MAX_RECENT_FIRES,
  MAX_WATCH_RULES,
  newWatchStats,
  predictedFrom,
  reviewAskId,
  ruleReview,
  stepWatch,
  stepWatchFlags,
  validateWatchRule,
  asksInstead,
  watchActions,
  watchCandidate,
  type WatchStats,
} from '@sundial/kernel/watch.js';

/**
 * The interpreter for the rules Gnomon writes (see `@sundial/kernel/watch.ts`).
 *
 * `rule:adopted` adds or replaces a watch (by id; the same id again is its
 * next version), `rule:dropped` removes one, `rule:paused` / `rule:resumed`
 * keep one without stepping it. Every other event steps every watch; a fire
 * becomes one `notice:candidate` of kind `watch:<id>`, and the gate decides as
 * it does for every rule a person wrote. A spec that fails validation in the
 * log is ignored, so a bad row can never break the fold.
 *
 * Each rule keeps a record (`stats`): the backtest it was adopted on, its
 * fires, and the owner's verdicts on its notices. On a day boundary a rule
 * that is mostly wrong, silent for a month, or drifting from its backtest is
 * put to the owner as a question; the answer drops or pauses it.
 */
export const watchRules: Rule = (state, event) => {
  const watch = state.watch ?? { rules: [], runtime: {} };

  if (event.type === 'rule:adopted') {
    const checked = validateWatchRule((event.payload as { rule?: unknown })?.rule);
    if (!('rule' in checked)) return { state, effects: [] };
    // Full is full, as the adopt tool says: a 21st id is ignored, never allowed to evict the oldest rule in silence.
    if (watch.rules.length >= MAX_WATCH_RULES && !watch.rules.some((r) => r.id === checked.rule.id)) return { state, effects: [] };
    const id = checked.rule.id;
    const rules = [...watch.rules.filter((r) => r.id !== id), checked.rule];
    const stats = { ...watch.stats, [id]: newWatchStats(event.ts, (watch.stats?.[id]?.version ?? 0) + 1, predictedFrom((event.payload as { predicted?: unknown }).predicted)) };
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
  // The owner's answer to a review question.
  if (event.type === 'ask:owner-answered') {
    const askId = typeof event.payload.askId === 'string' ? event.payload.askId : '';
    const rule = watch.rules.find((r) => reviewAskId(r.id) === askId);
    const answer = typeof event.payload.answer === 'string' ? event.payload.answer.trim().toLowerCase() : '';
    const type = answer.startsWith('drop') ? 'rule:dropped' : answer.startsWith('pause') ? 'rule:paused' : null;
    if (!rule || type === null) return { state, effects: [] };
    return { state, effects: [{ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'watch-rules', 'review', rule.id), type, ts: event.ts, payload: { id: rule.id, via: 'review' } } }] };
  }
  if (event.type === 'day:boundary') {
    // A rule adopted before rules kept a record starts one here, so its month of silence is counted from today.
    const missing = watch.rules.filter((r) => !watch.stats?.[r.id]);
    if (missing.length > 0) return { state: { ...state, watch: { ...watch, stats: { ...watch.stats, ...Object.fromEntries(missing.map((r) => [r.id, newWatchStats(event.ts, 1)])) } } }, effects: [] };
    for (const rule of watch.rules) {
      if (watch.paused?.includes(rule.id)) continue;
      const review = ruleReview(rule, watch.stats?.[rule.id], event.ts);
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
    const proposed = Object.fromEntries([...Object.entries(watch.proposed ?? {}), [deriveId(event.ts, event.id, 'shelf'), checked.rule]].slice(-10));
    return { state: { ...state, watch: { ...watch, proposed } }, effects: [] };
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
    // Keep is the owner's yes. Adopted through the same event a chat adoption appends, so the log says so.
    const effects: ReturnType<Rule>['effects'] =
      v.verdict === 'useful' ? [{ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'watch-rules', 'adopt'), type: 'rule:adopted', ts: event.ts, payload: { rule, via: v.artifactId } } }] : [];
    return { state: { ...state, watch: { ...watch, proposed } }, effects };
  }
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
      const record = stats?.[rule.id] ?? newWatchStats(event.ts, 1);
      watchActions(rule, f, event.ts).forEach((a, i) => effects.push({ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'watch-rules', rule.id, f.key ?? '', `do${i}`), type: a.type, ts: event.ts, payload: a.payload } }));
      if (!asksInstead(rule)) effects.push({ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'watch-rules', rule.id, f.key ?? '', f.escalated ? 'again' : ''), type: 'notice:candidate', ts: event.ts, payload: { ...watchCandidate(rule, f.text, f.payload, event.ts, f.key, record, f.escalated) } } });
      stats = { ...stats, [rule.id]: { ...record, fires: record.fires + 1, recent: [...record.recent, event.ts].slice(-MAX_RECENT_FIRES) } };
    }
  }
  return changed || effects.length > 0 ? { state: { ...state, watch: { ...watch, runtime, flags, ...(stats ? { stats } : {}) } }, effects } : { state, effects: [] };
};
