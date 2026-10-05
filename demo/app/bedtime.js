// When the owner stops, week by week — the band the audit asked for twice.
//
// **It was refused twice on a premise that was false, and the refusal is worth
// keeping in front of the next reader.** The measure was called impossible
// because a moment belongs to the local day it STARTS in, so a night past
// midnight supposedly ended one day at 23:59: nine nights in the same place,
// which is the "every case lands in the same place" tell. Measured (K0.6), not
// one moment in the record ends at 23:59 — nothing was ever clipped, and the
// nine days were a heuristic finding a person working late. On the waking day
// the same record holds ten nights past midnight spread from 00:04 to 03:08,
// and the band draws.
//
// **There is no intent line, and the record is what refuses it.** The audit
// asked for the band "vs the 23:00 intent line". The owner's own standing
// assertion, 12 September, says: *no fixed bedtime — the hour is decided by
// momentum, "it varies a lot"* — superseding an earlier ~22:00, with 23:00
// named only as that one night's plan. A target line drawn from a single
// evening's remark, across a belief that explicitly disclaims having a target,
// is the same fault as drawing a gate's bar from a constant the dial has moved.
// So the card asks the record (`getProfileFact('asleepBy')`), quotes it, and
// draws no line.
//
// **Which makes the SPREAD the subject rather than the distance from a
// target.** The owner says it varies a lot; the band is the record answering
// whether that is true and by how much. It is — the middle half of nights spans
// three to six and a half hours in every week of the record.

/** Quartiles rather than min-to-max, and the record decided it.
 *
 * Drawn min-to-max the bands ran six to thirteen hours, because the low end is
 * not a bedtime at all — it is a day the owner barely opened the machine
 * (2026-09-20 stops at 19:15 after three minutes of activity). A band whose
 * bottom edge is "the day I did almost nothing" measures attendance, not
 * bedtime. The middle half is the same answer the coverage calendar and the
 * typical day already give, for the same reason.
 */
function quartile(sorted, p) {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0]
  const at = (sorted.length - 1) * p
  const lo = Math.floor(at)
  const hi = Math.min(lo + 1, sorted.length - 1)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)
}

/** ISO week key for a `YYYY-MM-DD`, so weeks sort and label consistently. */
export function isoWeek(date) {
  const [y, m, d] = String(date ?? '').split('-').map(Number)
  if (!y || !m || !d) return null
  const at = new Date(Date.UTC(y, m - 1, d))
  // Thursday of this week decides the year, which is what makes week 1 stable.
  at.setUTCDate(at.getUTCDate() + 4 - (at.getUTCDay() || 7))
  const jan1 = new Date(Date.UTC(at.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((at - jan1) / 86400000 + 1) / 7)
  return { year: at.getUTCFullYear(), week, key: `${at.getUTCFullYear()}-W${String(week).padStart(2, '0')}` }
}

/**
 * One band per week: the middle half of stop times, the median, and the n.
 *
 * `days` are the Rhythm card's own rows, so the minutes are already on the
 * waking axis — 04:00 is 0, midnight is 1200, 02:00 is 1320 — and a late night
 * needs no wrap, no clamp and no special case. That is the whole reason this is
 * buildable at all.
 *
 * A week with fewer than `MIN_NIGHTS` stop times gets a row with `thin: true`
 * rather than being dropped: a quiet week is a fact about the week, and a
 * silently missing row reads as a gap in the record. The card draws it quietly
 * and says the count.
 */
export const MIN_NIGHTS = 4

export function bedtimeWeeks(days) {
  const byWeek = new Map()
  for (const day of days ?? []) {
    if (!day || !Number.isFinite(day.lastMin)) continue
    const iso = isoWeek(day.date)
    if (iso === null) continue
    const seat = byWeek.get(iso.key) ?? { key: iso.key, week: iso.week, from: day.date, to: day.date, stops: [] }
    seat.stops.push(day.lastMin)
    if (day.date < seat.from) seat.from = day.date
    if (day.date > seat.to) seat.to = day.date
    byWeek.set(iso.key, seat)
  }
  return [...byWeek.values()]
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((seat) => {
      const sorted = [...seat.stops].sort((a, b) => a - b)
      const lo = quartile(sorted, 0.25)
      const hi = quartile(sorted, 0.75)
      return {
        key: seat.key,
        week: seat.week,
        from: seat.from,
        to: seat.to,
        n: sorted.length,
        lo,
        mid: quartile(sorted, 0.5),
        hi,
        /** The middle half's width, in minutes — the number the owner's "it varies a lot" is about. */
        spread: lo === null || hi === null ? null : Math.round(hi - lo),
        thin: sorted.length < MIN_NIGHTS,
      }
    })
}

/**
 * What the whole series says, as counts rather than a claim.
 *
 * `typicalSpread` is the median of the weekly middle-half widths — a median of
 * medians, because one thin week should not decide how variable a habit is.
 */
export function bedtimeCensus(weeks) {
  const solid = (weeks ?? []).filter((w) => !w.thin && w.spread !== null)
  if (solid.length === 0) return null
  const spreads = solid.map((w) => w.spread).sort((a, b) => a - b)
  const mids = solid.map((w) => w.mid).sort((a, b) => a - b)
  const mid = (list) => (list.length % 2 === 0 ? (list[list.length / 2 - 1] + list[list.length / 2]) / 2 : list[(list.length - 1) / 2])
  return {
    weeks: solid.length,
    thin: (weeks ?? []).length - solid.length,
    typicalSpread: Math.round(mid(spreads)),
    earliestMid: mids[0],
    latestMid: mids[mids.length - 1],
    /** Nights that ran past midnight — 1200 is midnight on this axis. */
    pastMidnight: (weeks ?? []).reduce((n, w) => n + (w.hi !== null && w.hi >= 1200 ? 1 : 0), 0),
  }
}
