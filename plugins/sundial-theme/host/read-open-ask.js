// The question Gnomon is waiting on the owner for, as the seat above the composer shows it.
import { readOpenAsk as read } from '@sundial/kernel/read/open-ask.js'

export async function readOpenAsk({ state }) {
  return read(state)
}
