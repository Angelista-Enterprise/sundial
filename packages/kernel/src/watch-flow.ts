/**
 * Flows and reach: what a watch rule is beside its own trigger (see `watch.ts`).
 *
 * A flow is rules adopted together, in step order, that hear each other's
 * `emit`: checked as one (`validateWatchFlow`), counted as one against
 * `MAX_WATCH_RULES` (`watchRoomFor`), and listed with the flow each rule was
 * adopted in (`adoptedRules`). A reach is one outward act a rule asks the
 * owner to tap; its record of yeses in a row is what earns the offer to let it
 * run alone (`reachOffer`, `REACH_AUTO_AFTER`).
 */
import { REACH_AUTO_AFTER } from './gate.js';
import { MAX_FLOW_STEPS, MAX_WATCH_RULES, describeRule, ruleSlug, validateWatchRule, verdictPrecision, type WatchRule, type WatchRuntime, type WatchStats } from './watch.js';

/** Which flow a rule was adopted in: its id, its title, and the rule's step in it (1 first). */
export interface WatchFlowRef {
  id: string;
  title: string;
  step: number;
}

/** A `flow` from an adopt payload, checked and normalised. */
export function flowFrom(v: unknown): WatchFlowRef | { error: string } {
  const f = (v ?? {}) as Record<string, unknown>;
  const id = typeof f.id === 'string' ? ruleSlug(f.id) : '';
  const title = typeof f.title === 'string' ? f.title.trim().slice(0, 80) : '';
  if (!id || !title || !Number.isInteger(f.step) || (f.step as number) < 1 || (f.step as number) > MAX_FLOW_STEPS) return { error: `flow is {id, title, step: 1–${MAX_FLOW_STEPS}}` };
  return { id, title, step: f.step as number };
}

/**
 * A flow — rules adopted together, in step order — checked: each rule valid,
 * and no cycle inside it. A step may hear what an EARLIER step emits, never
 * what it or a later step emits back upstream, so one event can never run a
 * flow round in a loop. Across flows a cycle is allowed: that is the fold
 * being recurrent, and each rule's cooldown bounds it.
 */
export function validateWatchFlow(rules: unknown[]): { rules: WatchRule[] } | { error: string } {
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > MAX_FLOW_STEPS) return { error: `a flow is 1 to ${MAX_FLOW_STEPS} rules, in step order` };
  const out: WatchRule[] = [];
  for (const [i, input] of rules.entries()) {
    const checked = validateWatchRule(input);
    if ('error' in checked) return { error: `step ${i + 1}: ${checked.error}` };
    if (out.some((r) => r.id === checked.rule.id)) return { error: `step ${i + 1}: id ${checked.rule.id} is already step ${out.findIndex((r) => r.id === checked.rule.id) + 1}` };
    out.push(checked.rule);
  }
  for (const [i, rule] of out.entries()) {
    if (!rule.emit) continue;
    const back = out.slice(0, i + 1).findIndex((r) => r.when.type === rule.emit || r.then?.type === rule.emit);
    if (back >= 0) return { error: `step ${i + 1} emits ${rule.emit}, which step ${back + 1} hears: a flow may only feed later steps` };
  }
  return { rules: out };
}

export type WatchSlice = { rules: WatchRule[]; runtime: Record<string, WatchRuntime>; stats?: Record<string, WatchStats>; paused?: string[] };

/** The flow a rule counts as: its own, or a flow of one. */
const flowKey = (w: WatchSlice | undefined, id: string, flow?: WatchFlowRef) => (flow ?? w?.stats?.[id]?.flow)?.id ?? `rule:${id}`;

/**
 * Why there is no room for this rule, or null. `MAX_WATCH_RULES` counts flows
 * (a rule adopted without one is a flow of one), and a flow holds at most
 * `MAX_FLOW_STEPS`. A rule already adopted always has room: that is its next
 * version. The fold and every adopt path ask the same question.
 */
export function watchRoomFor(w: WatchSlice | undefined, id: string, flow?: WatchFlowRef): string | null {
  const rules = w?.rules ?? [];
  if (rules.some((r) => r.id === id)) return null;
  const key = flowKey(w, id, flow);
  const flows = new Set(rules.map((r) => flowKey(w, r.id)));
  if (!flows.has(key) && flows.size >= MAX_WATCH_RULES) return `${MAX_WATCH_RULES} rules and flows already: ${[...flows].map((f) => f.replace(/^rule:/, '')).join(', ')}; ask which to drop`;
  if (flow && rules.filter((r) => flowKey(w, r.id) === key).length >= MAX_FLOW_STEPS) return `flow ${flow.id} has ${MAX_FLOW_STEPS} steps already`;
  return null;
}

/** The steps adopted before this one in its flow, in step order: what a joint backtest of this step replays first. */
export function flowBefore(w: WatchSlice | undefined, id: string, flow: WatchFlowRef): WatchRule[] {
  return (w?.rules ?? []).filter((r) => r.id !== id && w?.stats?.[r.id]?.flow?.id === flow.id && w.stats[r.id]!.flow!.step < flow.step).sort((a, b) => w!.stats![a.id]!.flow!.step - w!.stats![b.id]!.flow!.step);
}

/** The ask id the review uses to offer a reach that has earned acting alone. */
export const reachAutoAskId = (id: string) => `owner-ask:reach-auto-${id}`;

/**
 * The reach a rule has earned the offer for: `REACH_AUTO_AFTER` yeses in a
 * row, not yet alone, not offered in the last fortnight. One question.
 */
export function reachOffer(rule: WatchRule, stats: WatchStats | undefined, now: string): { tool: string; question: string; choices: string[] } | null {
  for (const [tool, r] of Object.entries(stats?.reach ?? {})) {
    if (r.auto || r.approvals < REACH_AUTO_AFTER) continue;
    if (r.offeredAt && Date.parse(now) - Date.parse(r.offeredAt) < 14 * 86_400_000) continue;
    if (!(rule.do ?? []).some((a) => 'reach' in a && a.reach.tool === tool)) continue;
    return { tool, question: `You said yes to "${rule.title}" running ${tool} ${r.approvals} times in a row. Let it run that without asking?`, choices: ['Let it run', 'Keep asking'] };
  }
  return null;
}

/**
 * The adopted rules as the tools and hosts list them: each spec in words, with
 * its record — paused, version, fires, verdicts, last fire, its flow (`{id,
 * title, step}`, or null for a rule of its own), each reach's count, the
 * gate's precision for it and the verdicts on single fires behind it. One shape for
 * `gnomon_test_rule` with no rule and for `sundial://rules`.
 */
export function adoptedRules(w: WatchSlice | undefined) {
  if (!w) return [];
  const last = (id: string) => w.stats?.[id]?.recent.at(-1) ?? w.runtime[id]?.lastFiredAt ?? null;
  return w.rules.map((r) => ({ ...r, words: describeRule(r), paused: w.paused?.includes(r.id) ?? false, version: w.stats?.[r.id]?.version ?? 1, fires: w.stats?.[r.id]?.fires ?? 0, verdicts: w.stats?.[r.id]?.verdicts ?? null, lastFiredAt: last(r.id), flow: w.stats?.[r.id]?.flow ?? null, reach: reachOf(r, w.stats?.[r.id]), precision: verdictPrecision(w.stats?.[r.id]), judged: w.stats?.[r.id]?.judged ?? [] }));
}

/** Each reach of a rule with its record: how many yeses in a row, out of `REACH_AUTO_AFTER`, and whether it runs alone. */
export const reachOf = (rule: WatchRule, stats: WatchStats | undefined) =>
  (rule.do ?? []).flatMap((a) => ('reach' in a ? [{ tool: a.reach.tool, approvals: stats?.reach?.[a.reach.tool]?.approvals ?? 0, of: REACH_AUTO_AFTER, auto: stats?.reach?.[a.reach.tool]?.auto === true }] : []));

/** The reach tools the owner let this rule run without asking. */
export const autoReach = (stats: WatchStats | undefined) => new Set(Object.entries(stats?.reach ?? {}).filter(([, r]) => r.auto).map(([tool]) => tool));

/** Whether an answer to a reach question is the yes: the first choice as tapped, or a plain yes typed. */
export const reachYes = (answer: string) => /^\s*(yes|ja|ok|do it)\b/i.test(answer);

