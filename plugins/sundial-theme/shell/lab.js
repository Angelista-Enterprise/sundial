// What Gnomon has tried to learn about itself, and what came of it.
//
// **The finding this card exists to state: the lab has never completed a
// study.** Five questions have been opened since 3 August. Three were closed
// `superseded` within a day — not because they were answered but because the
// cell fell out of `mind.gaps`, a top-five list, which says nothing whatever
// about the question. The other two closed `learned`, and that word is doing
// far more work than it has earned:
//
//   * `the project sundial` opened with 0.057 nats of correctable error and
//     closed two days later on **three** new observations (n 5 → 8).
//   * `the project doe` opened with 0.041 and closed the next day on
//     **two** (n 5 → 7).
//
// `MIN_EXCESS_TO_OPEN` is 0.02 and `LEARNED_LOSS_DROP` is 0.3, so a goal may
// open on two hundredths of a nat and declare victory on six thousandths of
// one. Two coin flips produce that. Neither number is wrong in itself — they
// are the thresholds of a mechanism nobody had watched run — but a card that
// prints "learned" beside them without the sample size is repeating a claim
// the record does not support. So the count travels with the word, always.
//
// **And every one of the five has `finding: null`.** The field exists on
// `ResearchGoal` and nothing writes it. "Every closed question owes one
// conclusion line" is the audit's ask and the honest answer is that not one of
// them has one — which the card says per row rather than rendering a blank.

/** How long a study was allowed to run before `researchGoals` retires it. */
export const STALE_AFTER_DAYS = 21

/**
 * What each ending MEANS, in the owner's words rather than the enum's.
 *
 * Three outcomes that must not look alike. `superseded` is the one that reads
 * like a result and is not: the question was never answered, it was displaced
 * by four other cells scoring worse. `stale` is a real finding about the
 * question. `learned` is the only claim of success, and it is the one that
 * needs its evidence beside it.
 */
export const OUTCOME = {
  learned: { word: 'answered', tone: 'good', means: 'a hypothesis was proposed, tested against the record, and accepted — the only ending that claims anything was understood' },
  // K0.4. This WAS `learned`, and calling it that was the card's own
  // complaint: nothing is tested on this path, the cell's correctable error
  // simply falls past a bar that two coin flips can clear. Reporting it is
  // right; calling it understanding is not, and one word cannot mean both.
  faded: { word: 'sorted itself out', tone: 'good', means: 'the correctable error fell by the third it had to, without anything being tested — Gnomon predicts this better now and does not know why' },
  superseded: { word: 'dropped', tone: 'quiet', means: 'four other cells started scoring worse, so this one fell off the map — it was never answered' },
  stale: { word: 'gave up', tone: 'quiet', means: 'nothing left to test, or three weeks went by' },
  closed: { word: 'closed', tone: 'quiet', means: 'ended without a recorded reason' },
  open: { word: 'running', tone: 'live', means: 'still being studied' },
}

/**
 * A closed goal's conclusion, in one sentence — K0.4.
 *
 * `finding` was a field nothing but the never-fired trial path ever wrote, so
 * all five closed goals carried `null` and the card printed "no conclusion was
 * written" on every row. Both endings write it now, and they carry different
 * things, so this says which: a tested split names its variable and gain; a
 * gap that closed on its own names what came down and over how much new
 * evidence — which is the number that decides whether to believe the row at
 * all (DESIGN.md: a verdict word travels with the evidence it rests on).
 *
 * Still null for the goals closed before K0.4, and the card must say that in
 * words rather than rendering an empty cell — a blank reads as a layout fault.
 */
export function conclusion(finding) {
  if (finding === null || finding === undefined || typeof finding !== 'object') return null
  const over = typeof finding.newObservations === 'number' ? ` on ${finding.newObservations} more observation${finding.newObservations === 1 ? '' : 's'}` : ''
  if (typeof finding.variable === 'string' && finding.variable !== '') {
    return `It depends on ${finding.variable} — worth ${finding.gain.toFixed(2)} nats a sample${over}.`
  }
  if (finding.stalled === true) {
    return `Nothing was tested and the error did not come down${typeof finding.excessTo === 'number' ? `; it stood at ${finding.excessTo.toFixed(2)} nats at the end` : ''}${over}.`
  }
  if (typeof finding.excessFrom === 'number' && typeof finding.excessTo === 'number') {
    return `The correctable error fell from ${finding.excessFrom.toFixed(2)} to ${finding.excessTo.toFixed(2)} nats${over}, with nothing tested — so what changed is not recorded.`
  }
  return null
}

/** Whole days between two instants, floor 0 — a study closed the same day lived zero days. */
export function lifeDays(from, to) {
  const a = Date.parse(from ?? '')
  const b = Date.parse(to ?? '')
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.max(0, Math.round((b - a) / 86_400_000))
}

/**
 * One study, with the things that decide whether to believe it.
 *
 * `grew` is the number of NEW observations between opening and closing, and it
 * is the whole reason this function exists: on the two studies that closed
 * `learned` it is three and two.
 */
export function study(goal) {
  const openedN = goal?.openedWith?.n ?? null
  const closedN = goal?.closedWith?.n ?? null
  // The route names this field `status`; `mind.goals` names it `outcome`.
  // Reading only one of them printed "closed" on all five rows and zeroed the
  // whole census — including the two the record calls answered.
  const stored = goal?.closedAt ? (goal.outcome ?? goal.status ?? 'closed') : 'open'
  // K0.4 — a `learned` row with nothing tested behind it is read as what it
  // was, not as what it was labelled.
  //
  // The two goals the record calls `learned` were both closed by the threshold
  // path, before the two endings had different words. Leaving them alone would
  // keep the card saying "answered — a hypothesis proposed, tested and
  // accepted" about questions that never formed one, which is the exact claim
  // this item exists to delete. The evidence is on the row and needs no
  // backfill: an answered goal has a tested variable, either in `finding` or
  // in `hypothesis`, and these have neither.
  const tested = typeof goal?.finding?.variable === 'string' || typeof goal?.hypothesis?.variable === 'string'
  const legacy = stored === 'learned' && !tested
  const outcome = legacy ? 'faded' : stored
  return {
    ...goal,
    outcome,
    /** True where the word above was re-read rather than stored — the card says so. */
    legacy,
    ...(OUTCOME[outcome] ?? OUTCOME.closed),
    openedN,
    closedN,
    grew: openedN !== null && closedN !== null ? closedN - openedN : null,
    days: lifeDays(goal?.openedAt, goal?.closedAt ?? new Date().toISOString()),
    excessAtOpen: goal?.openedWith?.excessLoss ?? null,
    finding: goal?.finding ?? null,
    conclusion: conclusion(goal?.finding),
  }
}

/** What the whole bench adds up to — the header story, as counts rather than a claim. */
export function labCensus(goals) {
  const studies = (goals ?? []).map(study)
  const closed = studies.filter((s) => s.outcome !== 'open')
  // K0.4 — `answered` is now the trial path alone, which has never fired.
  // `faded` is the ending the two old `learned` rows would get today, and it
  // is counted separately because the two claim different things.
  const answered = closed.filter((s) => s.outcome === 'learned')
  const sortedOut = closed.filter((s) => s.outcome === 'faded' || s.outcome === 'learned')
  return {
    total: studies.length,
    open: studies.length - closed.length,
    answered: answered.length,
    faded: closed.filter((s) => s.outcome === 'faded').length,
    dropped: closed.filter((s) => s.outcome === 'superseded').length,
    gaveUp: closed.filter((s) => s.outcome === 'stale').length,
    /**
     * Studies with a conclusion written.
     *
     * This read `typeof s.finding === 'string'`, and `finding` has always been
     * an OBJECT — so the count was structurally zero and would have stayed
     * zero the day the first conclusion landed. It was right about the live
     * record by accident, which is the worst way for a figure to be right.
     */
    concluded: closed.filter((s) => conclusion(s.finding) !== null).length,
    /** The most evidence any study that reported progress gathered. Three, on this record. */
    bestGrowth: sortedOut.length ? Math.max(...sortedOut.map((s) => s.grew ?? 0)) : null,
    longestDays: studies.length ? Math.max(...studies.map((s) => s.days ?? 0)) : null,
    lastClosedAt: closed.map((s) => s.closedAt).filter(Boolean).sort().at(-1) ?? null,
  }
}
