/**
 * A watch rule in the owner's words (see `watch.ts`): telling a standing ask
 * ("tell me when …") from a question about now, and a rule's shape to share
 * as a blueprint, every value lifted into a named input.
 */
import type { WatchCondition, WatchOp, WatchRule } from './watch.js';

/**
 * Whether the owner is asking to be told when something happens — a standing
 * rule, not a question about now (F29). English and Dutch. "Remind me at four"
 * is a wake-up, not a rule, and does not count.
 */
const RULE_INTENT = [
  /\b(tell|let|notify|alert|warn|ping|nudge|remind|message|text) me( know)?,? (when|whenever|if|as soon as|every time|each time|once)\b/i,
  /\b(whenever|every time|each time|as soon as)\b.+\b(tell|let|notify|alert|warn|ping|nudge|remind) me\b/i,
  /\blaat (me |mij |het me |het mij )?(even )?weten (als|wanneer|zodra)\b/i,
  /\b(waarschuw|seintje|meld)\b.*\b(als|wanneer|zodra)\b/i,
  /\bzodra\b.+\b(laat|meld|waarschuw|zeg)\b/i,
  /\b(elke|iedere) keer (als|dat|wanneer)\b/i,
];
export const isRuleIntent = (text: string) => RULE_INTENT.some((re) => re.test(text));

/**
 * A rule as a blueprint to share (F30): every condition value lifted into a
 * named input, the id dropped. What is left is the rule's shape — fields, ops,
 * trigger, hours, the sentence — and the importer fills the inputs from their
 * own life, backtests it on their own log, and adopts it. The title and the
 * sentence stay, so the export tool runs the PII scan over them before
 * anything leaves.
 */
export function toBlueprint(rule: WatchRule): { blueprint: Record<string, unknown>; inputs: { name: string; field: string; op: WatchOp; example: 'string' | 'number' | 'boolean' | 'list' }[] } {
  const inputs: { name: string; field: string; op: WatchOp; example: 'string' | 'number' | 'boolean' | 'list' }[] = [];
  const lift = (list?: WatchCondition[]) =>
    list?.map((c) => {
      const base = (c.field.split('.').pop() ?? 'value').replace('[]', '');
      let name = base;
      for (let i = 2; inputs.some((x) => x.name === name); i++) name = `${base}${i}`;
      inputs.push({ name, field: c.field, op: c.op, example: Array.isArray(c.value) ? 'list' : (typeof c.value as 'string' | 'number' | 'boolean') });
      return { ...c, value: `{input:${name}}` };
    });
  const { id: _id, ...rest } = rule;
  const blueprint: Record<string, unknown> = { ...rest, when: { ...rule.when, ...(rule.when.where ? { where: lift(rule.when.where) } : {}), ...(rule.when.anyOf ? { anyOf: rule.when.anyOf.map((g) => lift(g)) } : {}) } };
  if (rule.then) blueprint.then = { ...rule.then, ...(rule.then.where ? { where: lift(rule.then.where) } : {}) };
  return { blueprint, inputs };
}

/** A blueprint with its inputs filled: a spec to test on this owner's log. An input left unfilled stays a placeholder, which fails validation where it matters. */
export function fromBlueprint(blueprint: unknown, inputs: Record<string, string | number | boolean | (string | number)[]>): unknown {
  const fill = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const m = /^\{input:([A-Za-z0-9_]+)\}$/.exec(v);
      return m && m[1]! in inputs ? inputs[m[1]!] : v;
    }
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return fill(blueprint);
}
