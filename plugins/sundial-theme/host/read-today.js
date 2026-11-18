// Today's numbers: the kernel's reader, for the date the board's span names.
import { spanFrom, today } from './http.js'
import { readToday as read } from '@sundial/kernel/read/today.js'
import { readDayDoing } from '@sundial/kernel/read/doing.js'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'
import { getAllSignalsInRange } from '@sundial/db/index.js'

export async function readToday({ state, url }) {
  const date = spanFrom(url, () => state).date
  const [timeZone, isToday] = [loadSundialConfig().timezone, date === today(state?.config?.timezone)]
  // Round 5: what Gnomon did on screen today, one line; only today, the line says "today".
  const [numbers, didToday] = await Promise.all([read({ state, date, timeZone, isToday }), isToday ? readDayDoing({ state, now: Date.now(), timeZone, rows: getAllSignalsInRange }) : null])
  return { ...numbers, didToday }
}
