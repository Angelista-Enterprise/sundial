// The Ledger: every model call's rollup from `llm_audit` over the card's window — by purpose, by day and by model, today's spend against its caps, the latest calls, and what failures cost.
import { shiftDate, spanFrom } from './http.js'
import { resolveDailyCaps } from '@sundial/kernel/budgets.js'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'
import { localDate, localDayRange } from '@sundial/helpers/local-day.js'
import { getLlmAuditByModel, getLlmAuditDaily, getLlmAuditOverview, getLostAnswers, getRecentLlmAudit } from '@sundial/db/index.js'

/** Named windows → span in days; anything else means the whole ledger. */
const LEDGER_WINDOWS = { today: 1, '7d': 7, '30d': 30 }

export async function readLedger({ state, now, url }) {
  // No exception for money. The ledger used to own a private `7d`/`30d`
  // strip that nothing else could read, so the board could show a
  // fortnight of activity beside a week of spend and say neither.
  // `window=` still wins when a caller names one, which is how a pinned
  // card and `gnomon_look` keep working.
  const windowParam = url.searchParams.get('window')
  const asked = spanFrom(url, () => state, 7)
  const windowDays = windowParam ? LEDGER_WINDOWS[windowParam] : asked.days
  const config = loadSundialConfig()
  const timeZone = config.timezone
  const todayStr = localDate(new Date(now).toISOString(), timeZone)
  const since = windowDays ? localDayRange(shiftDate(windowParam ? todayStr : asked.to, -(windowDays - 1)), timeZone).start : null

  const [overview, models, recent, lostAnswers] = await Promise.all([
    getLlmAuditOverview(since ?? undefined),
    getLlmAuditByModel(since ?? undefined),
    getRecentLlmAudit(30),
    getLostAnswers(since ?? undefined),
  ])

  // The day breakdown belongs to the window the card claims.
  //
  // It used to be the last thirty days whatever the window, on the
  // argument that today's number alone cannot say whether today is
  // normal. That argument lost: a reader of the `ledger` card saw
  // `window: 7d` above a list running Aug 19 → Sep 3 — the eight OLDEST
  // of twenty-two days, because the card's own result trimmer cuts an
  // array from the end and the days arrived oldest-first. Days outside
  // the stated window and the newest days missing, in the one block
  // whose whole job is "what has it been doing lately".
  //
  // So: the window's own days, newest first, and a trim now takes the
  // most recent ones. An unwindowed read still gets the whole ledger.
  const daily = (await getLlmAuditDaily(timeZone, since ?? undefined)).reverse()

  // Today's budget: the caps from config against the ledger's own
  // count of today's calls per purpose. `state.budgets` is the
  // enforcing counter's live twin; the audit table is its persistent
  // record, and this route already trusts it for everything else.
  const caps = resolveDailyCaps(state?.config?.budgets ?? config.budgets)
  const todayOverview = windowDays === 1 ? overview : await getLlmAuditOverview(localDayRange(todayStr, timeZone).start)
  const usedToday = new Map(todayOverview.byPurpose.map((p) => [p.purpose, p.calls]))
  const budgets = {
    day: todayStr,
    // What today has cost so far, beside the caps that stop it. The
    // window's total answers "is this expensive"; only today's answers
    // "is it expensive RIGHT NOW".
    spentUsd: todayOverview.summary.estimatedCostUsd,
    calls: todayOverview.summary.calls,
    // Closest to its cap first: the only ordering in which the block
    // answers "is anything about to stop?" at a glance.
    purposes: Object.entries(caps)
      .map(([purpose, cap]) => ({ purpose, cap, used: usedToday.get(purpose) ?? 0 }))
      .sort((a, b) => b.used / b.cap - a.used / a.cap),
  }

  return {
    generatedAt: new Date(now).toISOString(),
    // What the card says it is showing, whoever chose it: the caller's
    // own `window`, else the board's span by its own name.
    window: windowDays ? (windowParam ?? asked.label ?? `${asked.days}d`) : 'all',
    since,
    timeZone,
    summary: overview.summary,
    byPurpose: overview.byPurpose,
    latencyHistogram: overview.latencyHistogram,
    failureReasons: overview.failureReasons,
    unpricedRemoteModels: overview.unpricedRemoteModels,
    daily,
    models,
    budgets,
    recent,
    // The two questions the card could not answer: which of these
    // failures cost an ANSWER, and what the failing cost in money.
    lostAnswers,
    wasted: {
      billedOnFailureTokens: overview.summary.billedOnFailureTokens,
      billedOnFailureUsd: overview.summary.billedOnFailureUsd,
      retrySpendUsd: overview.summary.retrySpendUsd,
      failedMs: overview.summary.failedMs,
      lastFailureAt: overview.summary.lastFailureAt,
    },
  }
}
