// The dial: one day's (or the span's) `dial-slice` figures, from the same composer `gnomon_compose_figure` calls.
import { shiftDate, spanFrom } from './http.js'
import { composeFigure } from '@sundial/kernel/tools/figure-tools.js'

export async function readDial({ state, now, url }) {
  const asked = spanFrom(url, () => state)
  const date = asked.date
  // `days=N` returns the N days ENDING at `date`, newest first, as
  // `{ days: [{ date, ...figure }] }`. Strata wants a fortnight of
  // dials and used to ask fourteen times; the harness is one thread, so
  // fourteen round trips queued behind each other and behind everything
  // else the board wanted at the same moment. The work is identical —
  // this only stops paying for the queue.
  // The board's span counts as `days` here too: a dial asked for one
  // day draws one face, and a dial on a fortnight draws the fortnight.
  const days = Math.min(60, Math.max(0, asked.days > 1 ? asked.days : Number(url.searchParams.get('days')) || 0))
  if (days > 0) {
    const dates = Array.from({ length: days }, (_, i) => shiftDate(date, -i))
    const figures = await Promise.all(dates.map((on) => composeFigure({ kind: 'dial-slice', date: on }, new Date(now))))
    return { days: dates.map((on, i) => ({ date: on, ...figures[i] })) }
  }
  const figure = await composeFigure({ kind: 'dial-slice', date }, new Date(now))
  // `unavailable` is a real answer, not an error: a day with nothing
  // observed has no shape, and saying so is more honest than an empty
  // dial that looks like an idle day.
  return figure
}
