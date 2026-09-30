// The lab: what Gnomon is testing about itself.
import { el } from './surfaces.js'
import { icon } from './icons.js'
import { statusWord } from './status.js'
import { labCensus, STALE_AFTER_DAYS, study } from './lab.js'
import { table } from './view-kit.js'

/**
 * The lab: what Gnomon is doing to itself. Three read-only sections over one
 * joined reading (`LabReading`) — nothing here takes a verdict; the verdicts
 * are elsewhere, this is the ledger of them.
 */
/**
 * What Gnomon has tried to learn about itself, and what came of it.
 *
 * **The card's one finding: the lab has never completed a study.** Five
 * questions opened since 3 August. Three closed `superseded` within a day —
 * displaced off a top-five list, which is not an answer — and two closed
 * `learned` on three and two new observations respectively. Every one of the
 * five has `finding: null`. The audit asked that "every closed question owes
 * one conclusion line"; the honest answer is that none of them has one, and
 * the card says so per row rather than rendering a blank.
 *
 * So the outcome word never travels alone. "Answered" beside n 5 → 8 is a
 * reader's own judgement to make; "answered" on its own is the card repeating
 * a claim the record does not support. See `lab.js` for the thresholds that
 * make that possible — a goal may open on 0.02 nats of correctable error and
 * declare victory on 0.006 of one.
 *
 * **Two things it also stopped mis-stating.** `assistant.acceptedCount` is a
 * lifetime counter and was printed under a heading saying "this week", beside
 * notice counts that really were week-scoped — one heading over two spans.
 * And the bench read empty because it matched keys beginning `experiment-`,
 * while `weekly-self-audit`, the most lab-like thing Gnomon does, sat
 * scheduled on it.
 */
export function labPanel(data) {
  const d = data?.lab ?? {}
  const studies = (Array.isArray(d.questions) ? d.questions : []).map(study).sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)))
  const c = labCensus(d.questions)
  const bench = Array.isArray(d.experiments) ? d.experiments : []
  const ever = d.proposalsEver ?? {}
  const week = d.thisWeek ?? {}
  const n = week.notices ?? {}
  const judged = (n.useful ?? 0) + (n.wrong ?? 0) + (n.notNow ?? 0)
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—')
  const count = (x, one, many) => `${x} ${x === 1 ? one : (many ?? `${one}s`)}`

  // ── One study ────────────────────────────────────────────────────────────
  // Closed is a line; the question, the arithmetic it opened on and what it
  // concluded wait inside. The outcome word carries its evidence in the same
  // cell, because they are one claim.
  const row = (s, index) =>
    el('details', { class: 'study', 'data-tone': s.tone, style: { '--i': index } }, [
      el('summary', { class: 'study-line' }, [
        el('span', { class: 'goal-caret' }, [icon('more')]),
        el('span', { class: 'study-label', text: s.label ?? s.id }),
        el('span', { class: 'study-outcome', 'data-tone': s.tone, text: s.word }),
        // The sample the outcome rests on, beside the outcome. On the two that
        // say "answered" this reads "on 3 more" and "on 2 more", which is the
        // whole reason it is here.
        el('span', { class: 'study-evidence', text: s.grew === null ? '' : s.grew === 0 ? 'on nothing new' : `on ${count(s.grew, 'more observation')}` }),
        el('span', { class: 'study-life', text: s.days === null ? '' : `${count(s.days, 'day')} of ${STALE_AFTER_DAYS}` }),
        el('span', { class: 'study-when', text: when(s.openedAt) }),
      ]),
      el('div', { class: 'study-open' }, [
        el('p', { class: 'study-question', text: s.question ?? '' }),
        el('p', {
          class: 'study-why',
          // K0.4 — where the word was re-read rather than stored, say so. The
          // record's own label is `learned`, and a reader comparing this card
          // to the raw goal would otherwise find a disagreement with no
          // explanation.
          text: `It ended because ${s.means}.${s.legacy ? ' The record calls this one “learned”; it was closed before the two endings were told apart, and nothing was ever tested on it.' : ''}`,
        }),
        // The conclusion, or the fact that there is not one — K0.4.
        //
        // `finding` is a field on every goal, and until K0.4 only the trial
        // path wrote it and that path has never fired: all five of the
        // record's closed goals carry null. Both endings write it now, so a
        // goal closed from here on has a line, and an older one says in words
        // why it has not. A blank would read as a layout fault.
        el('p', {
          class: 'study-finding',
          'data-tone': s.conclusion ? null : 'quiet',
          text:
            s.conclusion ??
            'No conclusion was written. Until 23 September only a tested hypothesis could record one, and no question here ever formed one — so what these studies found is not recorded anywhere, and cannot be recovered.',
        }),
        el('div', { class: 'study-meta' }, [
          el('span', { text: `${(s.excessAtOpen ?? 0).toFixed(3)} nats correctable at open` }),
          el('span', { text: s.openedN === null ? '' : `n ${s.openedN} → ${s.closedN ?? '?'}` }),
          el('span', { text: `opened ${when(s.openedAt)}${s.closedAt ? `, closed ${when(s.closedAt)}` : ''}` }),
          s.hypothesis?.variable ? el('span', { text: `tested ${s.hypothesis.variable}` }) : null,
          s.tried?.length ? el('span', { text: `tried ${s.tried.join(', ')}` }) : null,
        ]),
      ]),
    ])

  return [
    el('section', { class: 'panel' }, [
      // The header story the audit asked for — worst prediction, study opened,
      // what was found — told as counts, because told as a narrative on this
      // record it would have to invent the third part.
      el('p', {
        class: 'panel-lead',
        text: c.total
          ? `When Gnomon predicts one part of your life worse than the rest, it opens a question about it and watches. ${count(c.total, 'question has', 'questions have')} been opened. ${c.answered ? `${c.answered} closed as answered` : 'None closed as answered'}, ${c.dropped} fell off the list before ${c.dropped === 1 ? 'it' : 'they'} could be, and ${c.concluded === 0 ? 'not one of them has a written conclusion' : `${c.concluded} carry a conclusion`}.`
          : 'Gnomon has never set itself a question.',
      }),
      c.total
        ? el('p', {
            class: 'panel-note',
            // The number that decides how much to believe the word "answered",
            // stated once at the top rather than left for the reader to add up.
            // K0.4 — "answered" now means a hypothesis was tested, and the
            // threshold close has its own word, so this sentence says which
            // ending the record actually contains rather than warning the
            // reader off a word the card is still using.
            text: `The longest any of them ran was ${count(c.longestDays ?? 0, 'day')} of the ${STALE_AFTER_DAYS} allowed, and the best-evidenced ending rests on ${c.bestGrowth === null ? 'no' : count(c.bestGrowth, 'new observation')}. ${
              c.answered === 0
                ? 'Not one has been answered: answering means proposing a hypothesis, testing it against the record and having it accepted, and no question here has ever formed one.'
                : `${count(c.answered, 'was', 'were')} answered — a hypothesis proposed, tested and accepted.`
            } A question may open on two hundredths of a nat of correctable error and close on six thousandths of one, which is why a gap that closes untested is reported as exactly that.`,
          })
        : null,
      studies.length ? el('div', { class: 'study-list' }, studies.map(row)) : null,
    ]),

    // ── The bench ────────────────────────────────────────────────────────
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: 'On the bench' }),
      bench.length
        ? table(
            [
              { label: 'What', cell: (r) => r.name ?? r.key },
              { label: 'Due', cell: (r) => new Date(r.at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) },
              { label: 'Why', cell: (r) => r.reason ?? '' },
              { label: 'State', cell: (r) => el('span', { class: r.status === 'due' ? 'gap-ready' : 'gap-waiting', text: r.status }) },
            ],
            bench,
          )
        : // The audit asked that an empty bench say WHY. On this record the
          // reason is not "all cells understood" — it is that every cell is
          // now under the bar a question has to clear to be worth opening.
          el('p', {
            class: 'panel-note',
            text: `Nothing scheduled. Gnomon opens a new question only where there is correctable error left to remove, and every cell on its map is now under that bar — which is why nothing has opened since ${when(c.lastClosedAt)}. The next question waits on a part of your life it starts predicting badly.`,
          }),
    ]),

    // ── The self-audit ───────────────────────────────────────────────────
    // Two spans, named. They were one heading over a lifetime counter and a
    // week-scoped one, which is the kind of thing a Lab card least deserves.
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: 'What you have told it' }),
      el('p', {
        class: 'panel-note',
        text: ever.resolved
          ? `Since the beginning you have decided ${count(ever.resolved, 'proposal')} — ${ever.accepted} accepted, ${ever.rejected} turned down. That is every one, not this week's.`
          : 'You have not decided a proposal yet.',
      }),
      el('p', {
        class: 'panel-note',
        text: judged
          ? `This week you have judged ${count(judged, 'thing')} Gnomon said: ${n.useful ?? 0} useful, ${n.wrong ?? 0} wrong, ${n.notNow ?? 0} not now. That count is read from a fifty-entry ring, so it is a floor rather than a total.`
          : 'You have not judged anything Gnomon said this week.',
      }),
      (week.proposals ?? []).length
        ? table(
            [
              { label: 'Proposal', cell: (r) => r.summary },
              { label: 'Kind', cell: (r) => r.kind },
              { label: 'Verdict', cell: (r) => statusWord(r.outcome) },
              { label: 'When', cell: (r) => when(r.at) },
            ],
            week.proposals,
          )
        : null,
    ]),
  ]
}
