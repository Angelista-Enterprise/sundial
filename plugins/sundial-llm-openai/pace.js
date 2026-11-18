// Pace-aware routing (Set 4 R1): a chat route whose recent calls run at over twice its own usual pace sends the next
// calls to its backup, and comes back once the pace has recovered. Runs 208 to 210 doubled their step on a flat prompt:
// the median call went from 34 to 69 ms per 1k tokens in on the same route and model, a slow hour at the provider.
// Pure: the verdict is read from the route's ledger rows and its newest switch row, never from a value kept here.

export const PACE = {
  /** The calls the recent pace is the median of; all of them inside `freshMs`. */
  recent: 8,
  freshMs: 15 * 60_000,
  /** The route's own usual pace: the median over its calls before those, at least this many. */
  baseMin: 20,
  baseWindowMs: 7 * 24 * 3600_000,
  /** Over this times the usual pace is slow; back at or under `recoverX` on the last `tries` calls tried since. */
  slowX: 2,
  recoverX: 1.5,
  tries: 3,
  /** Never two switches inside this: no flapping. */
  holdMs: 5 * 60_000,
  /** On the backup, one call in this long goes to the route itself, to see whether it is quick again. */
  probeMs: 2 * 60_000,
  /** On the backup this long, the route is used again however its probes measured; a fresh window of its own calls judges it. */
  backupMaxMs: 10 * 60_000,
  /** How far back a switch row is read; an older one no longer holds. */
  lookbackMs: 6 * 3600_000,
  /** The backup's newest calls its own pace is read from. */
  backupCalls: 50,
}

export const SLOW_LINE = 'The model is slow; using the backup.'

const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2 }
/**
 * A call's pace (ms per 1k tokens in) and its kind. A mostly cached prompt runs at about half the pace of a fresh
 * one (the live record: 32 against 69 ms/k in a usual hour, 74 against 153 in the slow one), and the first call of a
 * task is the fresh kind: each kind is judged against its own usual pace.
 */
const paceOf = (r) => (r.ms > 0 && r.pin > 0 ? { at: r.at, pace: r.ms / (r.pin / 1000), kind: (r.cached ?? 0) * 2 >= r.pin ? 'cached' : 'fresh' } : null)
/** The usual pace of each kind (of all calls, for a kind with fewer than five), and a call's pace against it. */
const usual = (base) => {
  const all = med(base.map((r) => r.pace))
  const of = Object.fromEntries(['cached', 'fresh'].map((k) => { const xs = base.filter((r) => r.kind === k); return [k, xs.length >= 5 ? med(xs.map((r) => r.pace)) : all] }))
  return { all, ratio: (r) => r.pace / of[r.kind] }
}

/**
 * Where the next chat call of a route goes.
 * @param rows the route's own answered chat calls, `{ at (ms), ms, pin, cached }`, oldest first
 * @param last the route's newest switch row, `{ at (ms), reason: 'slow' | 'recovered' }`, or null
 * @param backup the backup's own answered chat calls, the same shape: it is switched to only when its own pace (its
 *   newest `backupCalls`) is quicker than the slow calls. The replay of runs 199 to 210 found the configured backup
 *   slower over its week (72 ms/k cached) than the slow hour (63). A backup with too few calls of its own is tried.
 * @returns `use`: `primary`, `backup`, or `probe` (the route itself, while on the backup); `change`: `slow` or
 *   `recovered` when this call is the switch, else null (`why: 'window'` on a switch back that `backupMaxMs` made); `ratio`, the median of the judged calls' pace against their
 *   kind's usual pace, with the plain `recent` and `baseline` pace (ms per 1k in) for the record.
 */
export function paceSwitch({ rows, last, now, backup = [], p = PACE }) {
  const paced = rows.map(paceOf).filter(Boolean)
  const held = last != null && now - last.at < p.holdMs
  if (last?.reason !== 'slow') {
    const recentRows = paced.slice(-p.recent)
    const base = paced.slice(0, -p.recent).filter((r) => r.at >= now - p.baseWindowMs)
    // Since it came back, only the calls after that judge: the slow tries from before would flip it straight back.
    const since = last?.reason === 'recovered' ? last.at : -Infinity
    if (recentRows.length < p.recent || recentRows[0].at < Math.max(now - p.freshMs, since + 1) || base.length < p.baseMin) return { use: 'primary', change: null }
    const u = usual(base), ratio = med(recentRows.map(u.ratio))
    const theirs = backup.map(paceOf).filter(Boolean).slice(-p.backupCalls)
    const quicker = theirs.length < p.baseMin || med(recentRows.map(usual(theirs).ratio)) > 1
    const judged = { ratio, recent: med(recentRows.map((r) => r.pace)), baseline: u.all }
    return ratio > p.slowX && quicker && !held ? { use: 'backup', change: 'slow', ...judged } : { use: 'primary', change: null, ...judged }
  }
  // On the backup: the usual pace is the route's from before the slow calls that switched it; the tries are the probes since.
  const base = paced.filter((r) => r.at < last.at).slice(0, -p.recent)
  const tried = paced.filter((r) => r.at > last.at)
  const u = base.length ? usual(base) : null
  const lastTries = tried.slice(-p.tries)
  const ratio = u && lastTries.length ? med(lastTries.map(u.ratio)) : null
  const judged = { ratio, recent: med(lastTries.map((r) => r.pace)), baseline: u?.all ?? null }
  if (!held && lastTries.length >= 2 && ratio != null && ratio <= p.recoverX) return { use: 'primary', change: 'recovered', ...judged }
  // Doc 31: run 256's probes ran at about twice the usual pace, never under recoverX, so 93 of 107 calls stayed on the
  // backup for 15 minutes. A probe is one call, most often a turn's first and its noisiest; the window is the way back that always comes.
  if (now - last.at >= p.backupMaxMs) return { use: 'primary', change: 'recovered', why: 'window', ...judged }
  const newest = Math.max(last.at, tried.at(-1)?.at ?? 0)
  return { use: now - newest >= p.probeMs ? 'probe' : 'backup', change: null, ...judged }
}

/** What a switch row says it was judged on: the paces rounded, null (never 0) for one not judged. */
export const judgedOf = (v, primary) => ({ primary, pace: v.recent == null ? null : Math.round(v.recent), baseline: v.baseline == null ? null : Math.round(v.baseline) })
