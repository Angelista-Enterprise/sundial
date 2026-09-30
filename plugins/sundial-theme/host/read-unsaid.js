// What the gate said, held and dropped on one day, and every decision it has reached about a
// notice (the Unsaid card), with the words each was about and the owner's verdict on it.
import { getGateDecisionsBetween, getSignalsInRange } from '@sundial/db/index.js'
import { localDayRange } from '@sundial/helpers/local-day.js'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'
import { GATE_DAILY_BUDGET, barsFor } from '../shell/gate.js'

/** The payloads of one signal type, parsed, with their capture time. */
async function payloads(from, to, types) {
  const out = []
  for (const signal of await getSignalsInRange(from, to, 4000, types)) {
    let data = signal.data
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data)
      } catch {
        continue
      }
    }
    if (data) out.push({ data, at: signal.capturedAt ?? signal.captured_at })
  }
  return out
}

export async function readUnsaid({ state, now, date }) {
  const timeZone = loadSundialConfig().timezone
  const { start, end } = localDayRange(date, timeZone)
  const until = new Date(now + 60_000).toISOString()
  // **Two spans, deliberately, and the card is pinned to the wider one.**
  //
  // The Today card and the mood card both ask what Gnomon said TODAY, and
  // `counts`/`said`/`held`/`dropped` are one local day. The Unsaid card is not
  // about a day. Its subject is the BAR, and a bar is a property of the record:
  // the gate reaches about nine verdicts on a working day but one or two on
  // eight of its thirty days, so a day is too thin to argue a threshold from.
  // So the card reads `decisions`, every decision the gate has ever made, and
  // says the pin on its face the way the asks card does.
  // The day is its own ranged query; the words are read only from the gate's first decision on.
  const [whole, decisions] = await Promise.all([getGateDecisionsBetween('1970-01-01T00:00:00.000Z', until), getGateDecisionsBetween(start, end)])
  const since = whole.length > 0 ? new Date(Date.parse(whole[0].decidedAt) - 60_000).toISOString() : start
  // The decision table records the VERDICT and its terms, not the words — the
  // observation lives on the `notice:candidate` signal the verdict was about.
  // Their ids differ but they share the key and land in the same instant, so
  // the nearest earlier candidate with the same key is the one that was decided.
  const candidates = new Map()
  for (const { data, at } of await payloads(since, until, ['notice:candidate'])) {
    if (typeof data.key !== 'string') continue
    const list = candidates.get(data.key) ?? []
    list.push({ at: Date.parse(at ?? ''), observation: data.observation, evidence: data.evidence })
    candidates.set(data.key, list)
  }
  const withWords = (row) => {
    const list = candidates.get(row.noticeKey) ?? []
    const decidedAt = Date.parse(row.decidedAt ?? '')
    let best = null
    for (const c of list) {
      if (Number.isFinite(decidedAt) && c.at > decidedAt + 5_000) continue
      if (best === null || c.at > best.at) best = c
    }
    return best === null ? row : { ...row, observation: best.observation ?? null, evidence: best.evidence ?? [] }
  }
  const rows = decisions.map(withWords)
  const everything = whole.map(withWords)

  // The verdict the owner already gave a notice, carried on the row: a rating
  // is part of the reading, not a state of the widget (a re-read used to put
  // the buttons back). From the LOG, not `state.feedback.recent` (a fifty-entry
  // ring of every kind, which would forget most notice verdicts on a card
  // pinned to the whole record).
  const ratedNotices = new Map()
  for (const { data, at } of await payloads(since, until, ['feedback'])) {
    if (data.artifactKind !== 'notice' || typeof data.artifactId !== 'string') continue
    ratedNotices.set(data.artifactId, { verdict: data.verdict, at })
  }
  const withVerdict = (row) => {
    const rated = row.noticeKey ? ratedNotices.get(row.noticeKey) : undefined
    return rated === undefined ? row : { ...row, verdict: rated.verdict, verdictAt: rated.at }
  }

  // Grouped by what the owner would ask: what did you say, what are you sitting
  // on, what did you throw away — `reason` kept so "dropped" can tell "said too
  // often" from "not interesting enough".
  const said = rows.filter((row) => row.channel === 'phasic' || row.channel === 'tonic').map(withVerdict)
  const held = rows.filter((row) => row.channel === 'deferred').map(withVerdict)
  const dropped = rows.filter((row) => row.channel === 'suppressed')

  // The question Gnomon set itself, if it holds one: what it chose to look into, beside what it chose to say.
  const open = (state?.mind?.goals ?? []).find((entry) => entry.closedAt === null) ?? null

  // The asks come off the card: every `owner-question` decision has weight 2.0
  // and habituation 1.0 (the gate only prices the interruption), and they have their own card.
  const noticing = everything.filter((row) => row.kind !== 'owner-question').map(withVerdict)

  // Today's ambient budget from the gate's OWN counter (`spentToday`), never recounted off the rows.
  const notices = state?.notices ?? {}
  const budget = { spent: notices.day === date ? (notices.spentToday ?? 0) : 0, of: GATE_DAILY_BUDGET, refused: rows.filter((row) => row.reason === 'budget-spent').length }

  return {
    date,
    // Where the two bars stand RIGHT NOW: the owner's dial scales both.
    bars: barsFor(state?.settings?.noticeBias ?? 0),
    // Every decision the gate has reached about a NOTICE, newest last, with its words and verdict.
    decisions: noticing,
    budget,
    goal:
      open === null
        ? null
        : {
            label: open.label,
            question: open.question,
            openedAt: open.openedAt,
            expectedLoss: open.openedWith.expectedLoss,
            n: open.openedWith.n,
            // The hypothesis under test, when the model has proposed one.
            hypothesis: open.hypothesis ?? null,
            tried: open.tried ?? [],
          },
    counts: { said: said.length, held: held.length, dropped: dropped.length },
    said,
    held,
    // Heaviest first: the heaviest dropped row is the likeliest mistake.
    dropped: [...dropped].sort((a, b) => b.weight - a.weight).slice(0, 20),
  }
}
