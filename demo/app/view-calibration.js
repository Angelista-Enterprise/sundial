// Calibration: how good the forecasts are, per forecaster, with n.
import { el, svg } from './surfaces.js'
import { statusWord } from './status.js'
import { calibrationLine, coverage, lean, MIN_SCORED, reliability } from './calibration.js'
import { reliabilityPlot } from './reliability.js'
import { pct, table } from './view-kit.js'

/**
 * Is it right?
 *
 * The bins are the point, and the honest reading is usually uncomfortable: a
 * forecaster can be perfectly calibrated and carry almost no information, if
 * nearly every prediction sits in the lowest bin.
 */
/**
 * Whether Gnomon's confidence is worth anything.
 *
 * **Three questions, in order: does it mean what it says, is it better than
 * guessing, and is it still learning.** The card answered none of the three
 * honestly, and two of the faults were arithmetic rather than layout.
 *
 * **The reliability chart pooled three forecasters into one curve.**
 * `day-ending` bets 910 times at a 4.7% base rate, `hour-fragmented` 568 at
 * 20.8%, `project-touched` 165 at 37%. Averaged, the shape belongs to
 * whichever bets most and describes none of them — and the thing worth seeing,
 * that `day-ending` sits hard above the diagonal and was right on all 37 of
 * the bets where it committed, vanished. Calibration is a property OF a
 * forecaster; there is no calibration of a card. Three plots now, one scale.
 *
 * **And it binned the newest 500 of 1,649 resolved rows** while the tally
 * beside it counted all of them. Aggregated in SQL now — see
 * `getCalibrationBins`.
 *
 * **The skill figure had a three-sample denominator and hid the two best
 * forecasters.** See `skillVsConstant` in `calibration.js`.
 *
 * The third question answers itself and the answer is no: every cell on the
 * uncertainty map is ineligible, four of five because there is nothing
 * correctable left in them, and no goal has opened since 11 September. That is
 * the card's own finding and it is stated rather than left as an empty table.
 */
export function calibrationPanel(d) {
  const tally = (d.tally ?? []).filter((row) => row.n > 0)
  const bins = d.bins ?? []
  const retired = d.retired ?? {}
  const goals = d.goals ?? []
  const gaps = d.gaps ?? []
  const openGoals = goals.filter((goal) => goal.closedAt === null)

  const pctOf = (x) => `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`
  const count = (n, one, many) => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`
  // A target's name as the owner would say it, not as the enum spells it.
  const TARGET = {
    'day-ending': 'whether you are done for the day',
    'hour-fragmented': 'whether the next hour will be scattered',
    'project-touched': 'whether you will touch a project today',
  }

  // Every forecaster with enough bets to be worth a picture, best first. One
  // scale across all of them, so a mark of the same size means the same number
  // of bets on every plot — computed per plot, a 45-bet decile would be drawn
  // as big as an 873-bet one and the row would claim they were comparable.
  const withRows = tally
    .map((row) => ({ ...row, rows: reliability(bins.filter((bin) => bin.kind === row.kind && bin.forecaster === row.forecaster)) }))
    .sort((a, b) => b.n - a.n)
  // A forecaster with three bets gets a sentence, not a plot. Drawn, its two
  // marks sat on a full-size pair of axes beside a 910-bet one and claimed the
  // same standing — which is the pooling fault again, one level up.
  const scored = withRows.filter((row) => row.n >= MIN_SCORED)
  const tooNew = withRows.filter((row) => row.n < MIN_SCORED)
  const note = el('p', { class: 'rel-picked' })

  const plot = (row) => {
    const node = svg('svg', { class: 'rel', preserveAspectRatio: 'none', role: 'img', 'aria-label': `${row.forecaster}: what it said against what happened` })
    const holder = el('div', { class: 'rel-slab' }, [node])
    // This plot's own heaviest decile. Shared across the three the range is
    // 873 to 1 and every mark clamps to the same minimum — see the note on
    // `reliabilityPlot`.
    const busiest = Math.max(1, ...row.rows.map((bin) => bin.n))
    const paint = () => reliabilityPlot(node, { rows: row.rows, width: Math.round(holder.clientWidth), height: Math.round(holder.clientHeight), busiest, label: 'it said, %', onPick: (bin) => {
      note.textContent = `${row.forecaster}: on ${count(bin.n, 'bet')} it said ${Math.round(bin.from * 100)}–${Math.round(bin.to * 100)}%, and it happened ${Math.round(bin.observed * 100)}% of the time.`
    } })
    let queued = 0
    new ResizeObserver(() => {
      cancelAnimationFrame(queued)
      queued = requestAnimationFrame(paint)
    }).observe(holder)
    paint()

    const bias = lean(row.rows)
    const band = coverage(row.rows)
    const isRetired = (retired[row.kind] ?? []).includes(row.forecaster)
    return el('figure', { class: 'rel-figure' }, [
      el('figcaption', { class: 'rel-head' }, [
        el('span', { class: 'rel-target', text: TARGET[row.kind] ?? row.kind }),
        el('span', { class: 'rel-who', text: isRetired ? `${row.forecaster} · retired` : row.forecaster }),
      ]),
      holder,
      // What calibration MEANS here, built from the claim this forecaster
      // actually makes most often rather than from a hypothetical 3%.
      el('p', { class: 'rel-says', text: calibrationLine(row.rows) ?? 'It has not said anything yet.' }),
      el('div', { class: 'rel-facts' }, [
        // Skill first: it is the only number that answers "is this worth
        // having". Refused under thirty bets rather than printed small.
        el('span', { class: 'rel-fact' }, [
          el('span', { class: 'rel-fact-label', text: 'better than guessing by' }),
          el('span', { class: 'rel-fact-value', 'data-tone': row.skill === null || row.n < MIN_SCORED ? 'quiet' : null, text: row.n < MIN_SCORED ? `only ${row.n} bets` : row.skill === null ? 'not measurable' : pctOf(row.skill) }),
        ]),
        el('span', { class: 'rel-fact' }, [el('span', { class: 'rel-fact-label', text: 'bets' }), el('span', { class: 'rel-fact-value', text: `${row.n} · ${row.hits} came true` })]),
        // K0.3 — the same question against the opponent it could actually have
        // bet. Drawn only where rows carry one, and always with its own n:
        // the figure above is over every bet and this one is over the bets
        // written since the baseline was recorded, and two populations sharing
        // a label is the fault this card was rebuilt out of.
        row.fairN > 0
          ? el('span', { class: 'rel-fact' }, [
              el('span', { class: 'rel-fact-label', text: 'and against a fair opponent' }),
              el('span', {
                class: 'rel-fact-value',
                'data-tone': row.fairSkill === null || row.fairN < MIN_SCORED ? 'quiet' : null,
                title: 'Scored against the base rate as it stood before each bet, rather than against one fitted with hindsight to the same bets.',
                text: row.fairN < MIN_SCORED ? `only ${row.fairN} so far` : row.fairSkill === null ? 'not measurable' : `${pctOf(row.fairSkill)} on ${row.fairN}`,
              }),
            ])
          : null,
        bias
          ? el('span', { class: 'rel-fact' }, [
              el('span', { class: 'rel-fact-label', text: 'and it leans' }),
              el('span', {
                class: 'rel-fact-value',
                // The BAND, not just the word. "Under-confident" on its own is
                // a property of a forecaster; "under-confident above 80%" is
                // something the owner can go and look at.
                title: bias.word === 'honest' ? null : `on ${bias.n} bets in that band it was ${Math.round(Math.abs(bias.gap) * 100)} points out`,
                text: bias.word === 'honest' ? 'honest' : `${bias.word} at ${Math.round(bias.from * 100)}–${Math.round(bias.to * 100)}%`,
              }),
            ])
          : null,
      ]),
      // The band it never enters — the audit's "confidence coverage", and it
      // only means anything per forecaster. `hour-fragmented` has never once
      // said more than 57% on 568 bets, which is a real limit on what it can
      // ever be useful for and was invisible pooled.
      // Only where the ceiling is genuinely low. `day-ending` tops out at 87%,
      // which IS close to certain, and a line saying it never gets there would
      // be a finding invented out of a decile boundary.
      band && band.hi <= 0.7
        ? el('p', { class: 'rel-coverage', text: `It has never once said more than ${Math.round(band.hi * 100)}%, so it can tell you something is unlikely but never that it is close to certain.` })
        : null,
    ])
  }

  return [
    el('section', { class: 'panel' }, [
      el('p', {
        class: 'panel-lead',
        text: scored.length
          ? `Gnomon makes three kinds of guess about you, and puts a number on each. This is whether those numbers mean anything. The diagonal is a guess that means exactly what it says: a mark above it hedged — the thing happened more often than promised — and a mark below it overclaimed. The big mark on each is where nearly all of that forecaster's bets are; sizes compare within a plot, not between them.`
          : 'Nothing has been forecast yet.',
      }),
      scored.length ? el('div', { class: 'rel-grid' }, scored.map(plot)) : null,
      note,
      // The ones with too few bets to draw, named rather than dropped: a
      // forecaster the tournament is still trying out is a fact about the
      // system, and an empty plot is not.
      tooNew.length
        ? el('p', {
            class: 'panel-note',
            text: `${tooNew.map((row) => `${row.forecaster} has bet ${count(row.n, 'time')} on ${TARGET[row.kind] ?? row.kind}`).join('; ')} — too few to score, so there is no picture. A forecaster needs ${MIN_SCORED} before anything here means anything.`,
          })
        : null,
      el('p', {
        class: 'panel-note',
        text: '“Better than guessing” is against always saying that target’s own base rate — its Brier score divided by the best a constant could have done. That base rate is worked out with hindsight over the same bets, so it is a slightly generous opponent; on the target it can be checked against, it agrees with the offline measurement to within a point. Since 23 September every bet also records the base rate as it stood BEFORE it, which is the opponent a forecaster could actually have bet against — that is the “fair opponent” figure, and it carries its own count because it covers only the bets made since.',
      }),
    ]),

    // ── What it is claiming right now ────────────────────────────────────
    // A forecaster with no visible open position is one whose resolution
    // nobody can check against what it actually said.
    d.open?.length
      ? el('section', { class: 'panel' }, [
          el('h2', { class: 'panel-title', text: `In flight · ${count(d.open.length, 'open bet')}` }),
          table(
            [
              { label: 'Target', cell: (r) => TARGET[r.kind] ?? r.kind },
              { label: 'About', cell: (r) => r.about },
              { label: 'Says', num: true, cell: (r) => pct(r.priorProb) },
              { label: 'Since', cell: (r) => new Date(r.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) },
            ],
            d.open,
          ),
        ])
      : null,

    // ── Is it still learning? ────────────────────────────────────────────
    // The answer on this record is no, and the card says it in a sentence
    // rather than showing an empty table of open goals and letting the owner
    // work out why. The gaps list is filtered to the eligible, per the audit —
    // which on this record leaves nothing, and that IS the finding.
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: 'What it is trying to learn' }),
      el('p', {
        class: 'panel-note',
        text: openGoals.length
          ? `It is working on ${count(openGoals.length, 'question')} right now.`
          : gaps.length
            ? `Nothing, for now. It studies one cell at a time and only opens a question where there is something correctable left — and ${gaps.filter((gap) => !gap.eligible).length} of ${count(gaps.length, 'cell')} on the map say there is not: the error that remains is the day's own randomness, which no amount of watching removes. The last question closed on ${goals.length ? (goals.map((goal) => goal.closedAt).filter(Boolean).sort().at(-1) ?? '').slice(0, 10) : '—'}.`
            : 'It has no map of its own ignorance yet.',
      }),
      // Eligible cells only, per the audit. An ineligible one is not a thing
      // the owner can act on, and the reason it is ineligible is a sentence
      // rather than a row.
      gaps.filter((gap) => gap.eligible).length
        ? table(
            [
              { label: 'Cell', cell: (r) => r.label },
              { label: 'Forecaster', cell: (r) => r.forecaster },
              { label: 'n', num: true, cell: (r) => String(r.n) },
              { label: 'Correctable', num: true, cell: (r) => `${(r.excessLoss ?? 0).toFixed(3)} / ${(r.expectedLoss ?? 0).toFixed(2)}` },
            ],
            gaps.filter((gap) => gap.eligible),
          )
        : null,
      goals.length
        ? el('details', { class: 'rel-history' }, [
            el('summary', { text: `every question it has set itself · ${goals.length}` }),
            table(
              [
                { label: 'Question', cell: (r) => r.question ?? r.label },
                { label: 'Opened', cell: (r) => (r.openedAt ?? '').slice(0, 10) },
                {
                  label: 'Outcome',
                  cell: (r) =>
                    r.closedAt !== null
                      ? el('span', { class: r.outcome === 'learned' ? 'gap-ready' : 'gap-waiting', text: statusWord(r.outcome ?? 'closed') })
                      : r.progress === null
                        ? el('span', { class: 'gap-waiting', text: 'cell left the map — not measurable' })
                        : el('span', { class: 'goal-bar', title: `${(r.nowExcess ?? 0).toFixed(3)} nats correctable now, from ${(r.openedWith?.excessLoss ?? 0).toFixed(3)} at open. Closes as learned at ${(r.targetExcess ?? 0).toFixed(3)}.` }, [
                            el('span', { class: 'goal-fill', style: { width: `${Math.round(r.progress * 100)}%` } }),
                          ]),
                },
                { label: 'Hypothesis', cell: (r) => r.hypothesis?.variable ?? (r.tried?.length ? `tried ${r.tried.join(', ')}` : '\u2014') },
              ],
              goals,
            ),
          ])
        : null,
    ]),

    // The cells are the model. Small enough to print, so print them — folded,
    // because raw stats are the thing the audit asked to demote.
    d.cells?.length
      ? el('section', { class: 'panel' }, [
          el('details', { class: 'rel-history' }, [
            el('summary', { text: `the model itself · ${count(d.cells.length, 'cell')}` }),
            table(
              [
                { label: 'Target', cell: (r) => TARGET[r.kind] ?? r.kind },
                { label: 'Cell', cell: (r) => r.cell },
                { label: 'n', num: true, cell: (r) => String(r.n) },
                { label: 'Hits', num: true, cell: (r) => String(r.hits) },
                { label: 'Rate', num: true, cell: (r) => (r.rate === null || r.rate === undefined ? '—' : pct(r.rate)) },
              ],
              d.cells,
            ),
          ]),
        ])
      : null,
  ]
}
