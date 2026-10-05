// When the board is looking, as it reads NOW. Shared by the host (`spanFrom`
// in ../index.js) and the page (the span listener in app.js), so the two
// cannot disagree about what "today" means after midnight.
//
// The record stores a preset as the two dates it had when it was set, so a
// board left on "Today" last night still says yesterday this morning. A preset
// is therefore resolved again against the current day; only a single `day`
// (the ruler) and a `custom` range keep their stored dates. The table is the
// one in packages/rules/src/board-track.ts (`BOARD_SPANS`, `liveSpan`).

export const SPAN_DAYS = { today: 1, '7d': 7, '14d': 14, '30d': 30, '90d': 90 }

/** `YYYY-MM-DD` plus `n` calendar days. Dates, not clock arithmetic: no DST to get wrong. */
const shift = (date, n) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** The span as it reads on `today`, or null when the board has none. */
export function liveSpan(span, today) {
  if (!span) return null
  const days = SPAN_DAYS[span.label]
  return days === undefined ? span : { ...span, from: shift(today, -(days - 1)), to: today }
}

/** The page's own day, `YYYY-MM-DD`, in the browser's zone. */
export const localToday = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
