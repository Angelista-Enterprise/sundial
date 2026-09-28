import type { Rule } from '@sundial/kernel/types.js';

/**
 * The nightly pass over the owner's chat — sibling of `nightlyFactExtract`,
 * on the same `day:boundary`, with its own cursor
 * (`state.memory.lastConversationExtractAt`): the two passes read different
 * sources and may legitimately drift if one is skipped.
 *
 * No novelty gate. `assessNovelty` asks how many hours the daemon OBSERVED,
 * which says nothing about whether the owner typed anything; the executor
 * returns before spending a call when there are no owner turns in the window.
 *
 * Only says "the window from `since` is due". Reading the dsh session store,
 * redacting, the `extract` call and the candidate emission all happen in the
 * executor, which is the only place that can reach a session store — a pure
 * rule reads state and an event and nothing else.
 */
export const conversationFactExtract: Rule = (state, event) => {
  if (event.type !== 'day:boundary') return { state, effects: [] };

  const since = state.memory.lastConversationExtractAt ?? new Date(Date.parse(event.ts) - 24 * 60 * 60 * 1000).toISOString();

  return {
    state: { ...state, memory: { ...state.memory, lastConversationExtractAt: event.ts } },
    effects: [{ type: 'RunConversationExtraction', since, ts: event.ts }],
  };
};
