// Rhythm: the kernel's reader, over the span the board names.
import { spanFrom } from './http.js'
import { readRhythm as read } from '@sundial/kernel/read/rhythm.js'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'

export async function readRhythm({ state, now, url }) {
  const asked = spanFrom(url, () => state, 28)
  // A floor of four weeks, because a weekday is a column here and two samples a column is not a
  // rhythm — the same argument the coverage calendar makes, and the same measurement behind it.
  const days = Math.min(90, Math.max(14, asked.pinned ? asked.days : Math.max(28, asked.days)))
  return read({ until: url.searchParams.get('until') ?? asked.to, days, now, timeZone: loadSundialConfig().timezone })
}
