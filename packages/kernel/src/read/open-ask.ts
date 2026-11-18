import { openAsk } from '@sundial/helpers/loops.js';
import type { KernelState } from '../types.js';

/** The question Gnomon is waiting on the owner for, as the seat above the composer and the MCP `gnomon_open_ask` show it. */
export interface OpenAskRead {
  open: { askId: string; question: string; reason: string | null; choices: string[]; waiting: boolean; ts: string } | null;
}

export function readOpenAsk(state: KernelState | null | undefined): OpenAskRead {
  const open = openAsk(state);
  return {
    open:
      open === null
        ? null
        : { askId: open.askId, question: open.question, reason: open.reason === '' ? null : open.reason, choices: Array.isArray(open.choices) ? open.choices : [], waiting: open.waiting === true, ts: open.ts },
  };
}
