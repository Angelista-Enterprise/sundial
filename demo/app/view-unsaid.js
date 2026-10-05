// The Unsaid: what Gnomon noticed and did not say, against the bars the dial sets.
import { el, svg } from './surfaces.js'
import { verdictActs } from './verdicts.js'
import { icon } from './icons.js'
import { statusWord } from './status.js'
import { barsFor, biasSentence, GATE_DAILY_BUDGET, GATE_PHASIC_CAP, gateCensus, outcomeOf, placedWeight, weightAt, weightScale, whySentence } from './gate.js'
import { gateLadder } from './gate-ladder.js'
import { num, panel } from './view-kit.js'

/**
 * The noticing gate, and the one number the owner can move.
 *
 * **The subject of this card is the BAR, not the rows.** "Things Gnomon did
 * not say" is a log, and the counting says why a log would teach nothing here:
 * 94 of the 104 keys the gate has ever weighed appear on exactly one day,
 * because the key names one event — `return-from-break:2026-09-11`,
 * `work-shelved:01M2Q1G9M…`, `day-end-drift:w2957`. Nothing recurs, so nothing
 * on a row is a trend. What recurs is the threshold every one of them was
 * measured against, and the audit's own example is a statement about it: "a
 * dropped row with weight 0.52 against a bar of 0.55 is a different fact from
 * one at 0.05."
 *
 * So there is one picture, and it is the weight axis. Every row draws its own
 * decision on it, the whole list is SORTED by it, and the two bars are ruled
 * across the column where they fall. Reading the column top to bottom is the
 * distribution: the marks descend, and every place a colour breaks the run is
 * a decision the bar did not settle on weight alone — a budget that was gone,
 * a moment that cost too much, a key already worn down. Those breaks are the
 * card, and they needed no second hero picture to find.
 *
 * Three things the counting settled, each written where it applies:
 * `gate.js` for the asks coming off and the budget arithmetic; the census
 * below for what half the drops were worth; and `recurring` for habituation.
 */
export function unsaidPanel(d) {
  const all = Array.isArray(d?.decisions) ? d.decisions : []
  // The axis IS the order. Everywhere else on this client a list is live-first
  // then newest, and that rule is for a feed: it says which row the owner can
  // act on. Here every row is finished and the question is where it sat against
  // the bar, so sorting by anything but weight would put the picture and the
  // list into two different readings of the same numbers.
  // Stamped once, here, so the picture and the list agree about which column a
  // decision belongs in — the two used to derive it separately.
  // Where the bars stand TODAY, served by the route off the owner's own dial.
  // Never the policy's shipped constants: see `barsFor`, and the five rows
  // that were drawn on the wrong side of a line before this was wired through.
  const bars = d?.bars ?? barsFor(0)
  // K0.2 — `placedAt` is the weight expressed against the bar this row
  // actually met, which is what the axis measures. Sorting by it rather than
  // by the raw weight keeps the list in the picture's order once rows from two
  // different dial settings sit on one card.
  const rows = all
    .map((r) => ({ ...r, outcome: outcomeOf(r), placedAt: placedWeight(r, bars.tonic) }))
    .sort((a, b) => (b.placedAt ?? 0) - (a.placedAt ?? 0))
  const c = gateCensus(all, bars)
  const scale = weightScale(bars)
  const budget = d?.budget ?? {}
  const bar = (n) => n.toFixed(2)

  const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '')
  const at = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')
  const count = (n, one, many) => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`

  // ── One row ──────────────────────────────────────────────────────────────
  // Closed is a line: what Gnomon noticed, what it did, when, and where that
  // landed on the axis. The arithmetic, the evidence and the verdict wait
  // inside — I3's rule on its sixth surface.
  const row = (r, index) => {
    const outcome = r.outcome
    const summary = el('summary', { class: 'gate-line' }, [
      el('span', { class: 'goal-caret' }, [icon('more')]),
      // The title carries the WHOLE observation, because the track clips it at
      // 506px and the fold deliberately does not repeat it. "A fold adds" does
      // not license losing half a sentence.
      el('span', { class: 'gate-what', text: r.observation ?? r.noticeKey ?? 'Something', title: r.observation ?? null }),
      el('span', { class: 'gate-outcome', 'data-outcome': outcome, text: outcome }),
      // The weight as a NUMBER, in its own track. The picture above carries
      // the comparison, so a second copy of it on every row would be the same
      // reading twice — and a band per row is the shape every other card on
      // this board already uses, which is what the owner objected to.
      el('span', { class: 'gate-weight-value', 'data-side': r.weight >= bars.tonic ? 'over' : 'under', text: num(r.weight, 2) }),
      el('span', { class: 'gate-when', text: day(r.decidedAt) }),
    ])

    // The arithmetic, as the strip of terms it is. Not a sentence: five
    // numbers multiplied together read as five numbers, and this is the one
    // place on the client where the owner is meant to see the machine.
    const terms = [
      ['surprise', r.surprise],
      ['precision', r.precision],
      ['habituation', r.habituation],
      ['concern', r.concern],
    ]
      .filter(([, v]) => Number.isFinite(v))
      .map(([label, v]) => el('span', { class: 'gate-term' }, [el('span', { class: 'gate-term-label', text: label }), el('span', { class: 'gate-term-value', text: num(v, 2) })]))

    return el('details', { class: 'gate-row', 'data-outcome': outcome, 'data-id': r.id, style: { '--i': index } }, [
      summary,
      el('div', { class: 'gate-open' }, [
        el('p', { class: 'gate-why', text: `Gnomon ${outcome === 'said' ? 'said it because' : outcome === 'held' ? 'held it because' : 'dropped it because'} ${whySentence(r)}.` }),
        el('div', { class: 'gate-terms' }, [
          ...terms,
          el('span', { class: 'gate-term gate-term-sum' }, [el('span', { class: 'gate-term-label', text: 'weight' }), el('span', { class: 'gate-term-value', text: num(r.weight, 2) })]),
          r.channel === 'phasic' || r.reason === 'too-costly-now'
            ? el('span', { class: 'gate-term' }, [el('span', { class: 'gate-term-label', text: 'less the cost of breaking in' }), el('span', { class: 'gate-term-value', text: num(r.utility, 2) })])
            : null,
        ]),
        // The evidence the producer offered, which is what a weight was
        // computed from — absent, not empty, where a producer gave none.
        Array.isArray(r.evidence) && r.evidence.length ? el('ul', { class: 'gate-evidence' }, r.evidence.map((e) => el('li', { text: String(e) }))) : null,
        el('div', { class: 'gate-meta' }, [el('span', { text: at(r.decidedAt) }), el('span', { text: r.kind }), el('span', { class: 'gate-key', text: r.noticeKey })]),
        // Only what was SAID can be judged: a dropped notice never reached the
        // owner, so there is nothing for them to have an opinion about. The
        // one write door on this card, and it is the one that already existed
        // — `feedback:verdict` with `notice` as its kind and the GATE KEY as
        // its artifact id, which is what lets a `not-now` quiet that key.
        outcome === 'said' && r.noticeKey
          ? el('div', { class: 'gate-acts' }, [
              r.verdict ? el('span', { class: 'verdict-done', text: statusWord(r.verdict) }) : verdictActs('notice', r.noticeKey, { words: { useful: statusWord('useful'), wrong: statusWord('wrong'), 'not-now': statusWord('not-now') } }),
            ])
          : null,
      ]),
    ])
  }

  // ── The list, cut where the bar falls ────────────────────────────────────
  // ONE rule, and it is the ambient bar. That is the only reason to sort by
  // weight: the threshold stops being a number in a sentence and becomes a
  // place in the list.
  //
  // **Cut at the interrupt bar too and the card states a falsehood 46 times.**
  // `decide` settles the channel BEFORE any threshold, from the candidate's
  // own `valueHalfLifeMs`: something with a long shelf life is measured
  // against the ambient bar however heavy it is and never reaches the
  // interrupting path at all. 46 rows on this card sit above 0.80 and went out
  // as ambient, so a band labelled "heavy enough to interrupt you" would be
  // wrong about most of the rows under it. The interrupt bar is still ON the
  // axis, where a mark is a reference rather than a claim about the row.
  const list = el('div', { class: 'gate-list' })
  let band = null
  rows.forEach((r, index) => {
    const here = r.weight >= bars.tonic ? 'over' : 'under'
    if (here !== band) {
      band = here
      list.append(
        el('div', { class: 'gate-rule', 'data-band': here }, [
          el('span', {
            class: 'gate-rule-label',
            text: here === 'over' ? `worth more than ${bar(bars.tonic)} — the bar to say anything at all` : `${bar(bars.tonic)} · below this Gnomon stays quiet`,
          }),
        ]),
      )
    }
    list.append(row(r, index))
  })

  // ── The ladder ───────────────────────────────────────────────────────────
  // Drawn at the size the card actually is, and redrawn when the owner drags
  // it — one user unit per pixel, the strata's own idiom. A fixed viewBox
  // scaled to fit is the trap this client has already paid for once.
  const slab = el('div', { class: 'ladder-slab' })
  const picture = svg('svg', { class: 'ladder', preserveAspectRatio: 'none', role: 'img', 'aria-label': `${c.total} gate decisions by weight, against a bar of ${bar(bars.tonic)}` })
  slab.append(picture)
  const ladder = el('figure', { class: 'ladder-figure' }, [
    slab,
    el('figcaption', { class: 'ladder-caption', text: `Every decision by what it was worth. The rule at ${bar(bars.tonic)} is the bar to say anything; ${bar(bars.phasic)} is the bar to break in, and only the ${c.urgent} short-lived ones ever met it. Press a mark to open its row.` }),
  ])

  // Pressing a mark opens the row it stands for. Without this the picture is
  // something to look at rather than a way into the list — and the list is 171
  // rows long, so "which one was that" has no other answer.
  const pick = (r) => {
    const found = [...list.querySelectorAll('.gate-row')].find((node) => node.dataset.id === r.id)
    if (!found) return
    for (const open of list.querySelectorAll('.gate-row[open]')) if (open !== found) open.open = false
    found.open = true
    found.scrollIntoView({ block: 'center', behavior: 'smooth' })
    found.classList.add('gate-row-lit')
    setTimeout(() => found.classList.remove('gate-row-lit'), 1400)
  }

  const paint = () => gateLadder(picture, { rows, width: Math.round(slab.clientWidth), height: Math.round(slab.clientHeight), scale, bars, overlap: c.overlap, weightAt, onPick: pick })
  // One frame's worth of coalescing: a drag fires this continuously.
  let queued = 0
  new ResizeObserver(() => {
    cancelAnimationFrame(queued)
    queued = requestAnimationFrame(paint)
  }).observe(slab)

  const section = el('section', { class: 'panel' })
  section.replaceChildren(
    el('p', {
      class: 'panel-lead',
      text: rows.length
        ? `Everything Gnomon has ever noticed and what it decided to do about it — ${count(c.total, 'decision')} over ${count(c.days, 'day')}, whatever span the board is on. One number decides all of them — ${bar(bars.tonic)}, the weight a thing has to reach before Gnomon says it at all. A second, ${bar(bars.phasic)}, decides whether it may break into what you are doing, and only ${c.urgent} of these were ever eligible for that: the rest keep long enough to wait. This card is those two numbers, and every row is an argument about where they should sit.`
        : 'The gate has never weighed anything.',
    }),
    // ── The picture, and it comes FIRST ────────────────────────────────────
    // The axis turned ninety degrees, with the whole card's argument on it.
    // Above the census rather than below it, because the census is four
    // paragraphs explaining a shape — read before the shape they are four
    // paragraphs of assertion, and the owner scrolls past them. See
    // `gate-ladder.js` for why this is not a band per row.
    rows.length ? ladder : null,
    rows.length
      ? el('div', { class: 'gate-census' }, [
          // The headline, and it is the number the bar would be moved on.
          // Not a percentage: "50% of drops were near misses" is a ratio of a
          // subset of a subset, and the two counts say the same thing without
          // inviting the reader to work out what the denominator was.
          el('p', { class: 'gate-ratio' }, [
            el('strong', { text: count(c.said, 'said', 'said') }),
            el('span', { text: '·' }),
            el('strong', { text: `${c.dropped} dropped` }),
            c.overlap ? el('span', { text: `${c.overlap.said + c.overlap.refused} of them inside one band` }) : null,
            c.held ? el('span', { text: `${c.held} still held` }) : null,
          ]),
          // **The overlap, and it is the headline because the dial cannot
          // spoil it.** The first draw of this card counted near misses
          // against the bar, and the bar moves: 25 of 50 against 0.55, 43 of
          // 50 against the live 0.28, which is a figure that says whatever the
          // dial says. The band between the lightest thing ever admitted and
          // the heaviest ever refused is a fact about the rows alone.
          c.overlap
            ? el('p', {
                text: `Gnomon has said things worth as little as ${bar(c.overlap.lo)} and refused things worth as much as ${bar(c.overlap.hi)} — ${c.overlap.said} admissions and ${c.overlap.refused} refusals inside that one band. So no single weight separates them — and ${c.refusedAboveBar} of the ${c.dropped} it dropped were ABOVE the bar when it dropped them, while nothing it said was below. Whatever is keeping Gnomon quiet, it is mostly not the bar: it is the day's budget, the cost of breaking in, a key already worn down — and a bar that used to sit higher.`,
              })
            : el('p', { text: `The bar has been clean: nothing it refused was heavier than anything it admitted. ${count(c.belowThreshold, 'thing')} fell under it.` }),
          // Habituation, said once and not drawn per row. The gate's third
          // lever, and the record says it has almost nothing to act on.
          el('p', {
            text: `The gate has a third lever — it quiets a thing it has already said — and it has ${c.habituatedKeys === 0 ? 'never used it' : `used it on ${count(c.habituatedKeys, 'key')}`}. That is not restraint: ${c.oneDayKeys} of the ${count(c.keys, 'key')} it has weighed have only ever come up on ONE day, because the key names one event — a date, a week, a single piece of work. So on the next day the gate meets a key it has never seen, at full volume, and wearing a key down only works within its own day.`,
          }),
          // The dial, and what it cost the card. Absent where the dial has not
          // moved, and where it HAS the caveat has to be beside it: the
          // decision rows store no threshold column, so a row weighed under a
          // different setting is drawn against today's bar and can sit on the
          // wrong side of it. Said out loud, because unsaid it reads as a
          // rendering fault — which is exactly how it was caught.
          biasSentence(bars)
            ? el('p', {
                text: `${biasSentence(bars)} ${
                  c.movedBar
                    ? `${count(c.movedBar, 'row')} below ${c.movedBar === 1 ? 'was' : 'were'} decided before Gnomon recorded which bar it used, so ${c.movedBar === 1 ? 'it is' : 'they are'} drawn against today's line and can sit on the wrong side of it.${c.placedRows ? ` The other ${c.placedRows} carry their own bar and are placed against that.` : ''}`
                    : c.placedRows
                      ? `Every row carries the bar it was actually weighed against, so moving the dial moves the line without moving the marks.`
                      : ''
                }`.trim(),
              })
            : null,
          el('p', {
            text:
              c.judged === 0
                ? 'You have not judged any of these yet. Open one Gnomon said and say whether it was worth hearing — a “not now” is the only thing that quiets its key.'
                : `Of the ${count(c.judged, 'thing')} you have judged, ${c.worthSaying} ${c.worthSaying === 1 ? 'was' : 'were'} worth hearing. A “not now” quiets that key; the others are recorded and change nothing, which is right — they are calibration, not a claim about the world.`,
          }),
          // Today, in one line and in the gate's own counter. The audit's brief
          // wanted this as the header; it is a day's fact on a card about the
          // record, so it sits last. See `GATE_DAILY_BUDGET` for the three
          // things the brief's own version of this sentence got wrong.
          el('p', {
            class: 'gate-today',
            text: `Today: ${budget.spent ?? 0} of ${budget.of ?? GATE_DAILY_BUDGET} ambient notices spent${budget.refused ? `, and ${count(budget.refused, 'thing')} refused because it was gone` : ', and nothing refused for it'}. Anything heavy enough to interrupt is said whatever the budget holds, up to ${GATE_PHASIC_CAP} interruptions a day; past that it joins the list.`,
          }),
        ])
      : null,
    rows.length ? list : el('div', { class: 'none', text: 'Nothing to show.' }),
    d.goal
      ? panel(
          'Gnomon is researching',
          [
            ['Question', d.goal.question],
            ['Since', at(d.goal.openedAt)],
            ['Hypothesis', d.goal.hypothesis ?? '—'],
          ],
          'A goal Gnomon set itself when its own forecast kept being wrong. It closes when it learns something, and says so.',
        )
      : null,
  )
  return [section]
}
