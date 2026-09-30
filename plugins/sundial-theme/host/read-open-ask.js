// The question Gnomon is waiting on the owner for, as the seat above the composer shows it.
import { openAsk } from '@sundial/helpers/loops.js'

export async function readOpenAsk({ state }) {
  const open = openAsk(state)
  return {
    open:
      open === null
        ? null
        : {
            askId: open.askId,
            question: open.question,
            reason: open.reason === '' ? null : open.reason,
            choices: Array.isArray(open.choices) ? open.choices : [],
            waiting: open.waiting === true,
            ts: open.ts,
          },
  }
}
