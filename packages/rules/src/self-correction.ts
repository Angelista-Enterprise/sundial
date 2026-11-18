// Plan 15 4.5: Gnomon corrects its own words. A fact it cited to the owner in the last 14 days is retracted
// (the owner's "wrong") or replaced (the owner's assertion of the same predicate): one notice says so.
import { deriveId } from '@sundial/helpers/derive-id.js';
import type { CitedFact, KernelState, Rule } from '@sundial/kernel/types.js';

export const CORRECT_WITHIN_MS = 14 * 86_400_000;
/** Predicates that hold one value at a time; a second value for "likes" is more, not a correction. */
const ONE_VALUE = /(At|By|Is|In|Of)$|^(occupation|role|title|worksAt|timezone|dayBeginsAt|workSchedule|age|name)$/;

const recent = (state: KernelState, ts: string, match: (c: CitedFact) => boolean) =>
  [...(state.conversation.cited ?? [])].reverse().find((c) => match(c) && Date.parse(ts) - Date.parse(c.at) <= CORRECT_WITHIN_MS);

const dayOf = (at: string, timeZone: string) => {
  try {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone }).format(new Date(at));
  } catch {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(new Date(at));
  }
};

/** A pure producer: reads `conversation.cited`, writes no state. */
export const selfCorrection: Rule = (state, event) => {
  const p = event.payload as Record<string, unknown>;
  let cited: CitedFact | undefined;
  let now: string | null = null;
  if (event.type === 'feedback:verdict' && p.artifactKind === 'entity_fact' && p.verdict === 'wrong' && typeof p.artifactId === 'string') {
    cited = recent(state, event.ts, (c) => c.id === p.artifactId);
  } else if (event.type === 'entity:fact-candidate' && p.provenance === 'assertion' && typeof p.predicate === 'string' && typeof p.object === 'string') {
    const owner = new Set((state.config.ownerAliases ?? []).map((a) => a.trim().toLowerCase()));
    if (!owner.has(String(p.canonicalName ?? '').trim().toLowerCase())) return { state, effects: [] };
    if (!ONE_VALUE.test(p.predicate)) return { state, effects: [] };
    cited = recent(state, event.ts, (c) => c.predicate === p.predicate && c.object.trim().toLowerCase() !== String(p.object).trim().toLowerCase());
    now = String(p.object).trim().slice(0, 120);
  }
  if (!cited) return { state, effects: [] };
  const day = dayOf(cited.at, state.config.timezone ?? 'UTC');
  const observation = `On ${day} I said ${cited.predicate.replace(/_/g, ' ')}: ${cited.object}. That was wrong.${now ? ` It is ${now}.` : ''}`;
  return {
    state,
    effects: [
      {
        type: 'EmitEvent',
        event: {
          id: deriveId(event.ts, event.id, 'self-correction', cited.id),
          type: 'notice:candidate',
          ts: event.ts,
          payload: { timestamp: event.ts, shape: 'transition', kind: 'self-correction', key: `self-correction:${cited.id}`, surprise: 1.7, precision: 0.9, valueHalfLifeMs: 24 * 3_600_000, observation, evidence: [`cited ${cited.at.slice(0, 10)}`, now ? 'you set it right' : 'you marked it wrong'], concerns: [] },
        },
      },
    ],
  };
};
