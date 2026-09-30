// The asks: what Gnomon asked the owner, how it was answered, and what the answers became.
import { ASSERTABLE_ENTITY_KINDS } from '@sundial/helpers/vocab.js'
import { el, newestFirst } from './surfaces.js'
import { postVerdict } from './verdicts.js'
import { factSentence, stackedBlock } from './blocks.js'
import { icon } from './icons.js'
import { status, statusWord } from './status.js'
import { dayClock, dayScale, scaleHours } from './day-clock.js'
import { askCensus, askGist, askQuieting, askSubject, KIND_WORDS, minuteOfDay, routePrefill, waitMinutes } from './asks.js'
import { hm } from './view-kit.js'

/**
 * What Gnomon said today, what it is holding for a better moment, and what it
 * decided not to say — with the numbers behind each decision.
 *
 * This is how the owner tunes the gate: not by editing thresholds but by seeing
 * what almost cleared them. A dropped row with weight 0.52 against a bar of
 * 0.55 is a different fact from one at 0.05, and the page shows both.
 */
/**
 * Every question Gnomon has put to the owner, and whether asking was worth it.
 *
 * **One object now, not two.** The card carried `owner_asks` and `ask_threads`
 * side by side and the audit read them as two things sharing a surface. The
 * split turned out to be a deletion rather than a move: `ask_threads` is not
 * the chat feed — the chat feed is the dsh sessions the threads card reads —
 * it is the retired macOS Ask surface's Q&A log, whose event last fired on
 * 2026-08-15. What is left is one subject with one question hanging over it,
 * which is what a card is: *asking costs the owner's attention before Gnomon
 * has said anything useful, so was it worth it?*
 *
 * **The precision figure the audit asked for is refused, and the refusal is on
 * the card.** `outcome` holds `answered` and `expired` and nothing else — 47
 * and 1 — and drawn as a percentage that is 98%, which flatters the asker.
 * Nothing in the record knows that two of those meetings were ones the owner
 * did not attend: a calendar carries an attendee list, which is an invitation.
 * So the verdict is theirs to give, through the door that already existed —
 * `feedback:verdict` gained `owner_ask` as an artifact kind, and its three
 * words land exactly on the three things that can be wrong with a question.
 * Until they press one the card says the number is not measured yet, rather
 * than printing a zero.
 *
 * **What the record can answer exactly is the SHAPE of the asking**, and
 * `askCensus` computes it with no model in the path: four templates, one of
 * them put fourteen times, and fifteen questions landing within an hour of
 * another of the same kind. A repeat count is a fact; a precision percentage
 * would have been a judgement wearing one.
 *
 * **The picture is the clock, because the audit's own example was a clock.**
 * "asked 07:32, answered 11:13 = a bad-moment ping" is two readings — where in
 * the day Gnomon interrupts, and how long the owner was left holding it — and
 * `dayClock` already draws both on one scale shared down a column. A date axis
 * was the other candidate and it was refused: the goals trail says WHEN in the
 * calendar, which the row's own date already says.
 *
 * **No `now` tick, unlike the habits card.** A ritual recurs, so "am I on my
 * usual path right now" is a question about today; an ask happened once, on a
 * day that is over, and an ochre line down every row would say that every
 * question is live.
 */
export function asksPanel(d) {
  const asks = newestFirst(Array.isArray(d?.asks) ? d.asks : [], (a) => a.askedAt)
  const c = askCensus(asks)
  const quieting = askQuieting(d?.quieted)
  const section = el('section', { class: 'panel' })

  const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null)
  const held = (m) => (m === null ? null : m < 60 ? `${m} min` : hm(m))

  // One clock for the whole list, so a tick on row forty means the same hour as
  // a tick on row one — which is the only reason to draw it on a row at all.
  const scale = dayScale(asks.map((a) => ({ startMin: minuteOfDay(a.askedAt), endMin: minuteOfDay(a.askedAt) + (waitMinutes(a) ?? 0) })))

  /**
   * One door for a fact drawn out of an answer.
   *
   * `/gnomon/api/assert` is the door the goals and people cards use and the one
   * `gnomon assert` uses, so a fact typed here and a fact said out loud land on
   * the same entity — the split that cost four goals two ids each. It carries
   * the answer's own event id, which is what lets the next read say which
   * answers became something instead of the button looking like it did nothing.
   */
  const assert = (body) =>
    fetch('/gnomon/api/assert', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => {
      if (!r.ok) throw new Error(String(r.status))
      return r
    })

  // ── One question ─────────────────────────────────────────────────────────
  // Closed is a LINE — mark, question, state, when and how long, clock — and
  // the answer, the reason, the verdict and the routing door wait inside. I3's
  // rule on its fifth surface: a stacked block is what a row looks like OPEN,
  // and forty-eight of them standing open is the page of paragraphs the owner
  // has already rejected once.
  const row = (ask, index) => {
    const state = status(ask.verdict ?? ask.outcome)
    const wait = waitMinutes(ask)
    const gist = askGist(ask, factSentence)
    const summary = el('summary', { class: 'question-line' }, [
      el('span', { class: 'goal-caret' }, [icon('more')]),
      // Verbatim, hash and all. `Who is person-4b3c2d1e0f?` breaks the rule
      // that no hash is shown to the owner, and it stays: this is not Gnomon
      // describing someone, it is the question it actually asked, and the
      // unreadability IS the finding the census counts fourteen times.
      // H5: the SUBJECT of the question, then what its answer holds. The card's
      // own review said the row repeated one template twenty-five times, so the
      // eleven boilerplate words come off (`askSubject`) and the space they
      // freed carries the finding instead. The hash stays verbatim where the
      // question had one — that unreadability is what the census counts
      // fourteen times, and it is not Gnomon describing someone, it is the
      // question it actually asked.
      el('span', { class: 'question-question', text: askSubject(ask.question) }),
      // Ochre, because a proposal is a model's reading and that is what ochre
      // means everywhere on this client. Rendered on every row so the track
      // holds its width down the column; empty where no model has looked yet,
      // which is a different row from one that read nothing.
      el('span', { class: 'question-gist', 'data-tone': gist?.empty ? 'quiet' : null, title: gist && !gist.empty ? gist.text : null }, [
        gist ? el('span', { text: gist.text }) : null,
        gist?.more ? el('span', { class: 'question-gist-more', text: `+${gist.more}` }) : null,
      ]),
      el('span', { class: 'question-state', 'data-tone': state.tone, text: state.word }),
      // The date and the wait, which the picture cannot say: its axis is a
      // time of DAY, so it carries neither which day nor how many minutes a
      // six-pixel band is. Different readings, not a repeat.
      el('span', { class: 'question-facts' }, [when(ask.askedAt) ?? '', wait === null ? '' : ` · held ${held(wait)}`].map((t) => el('span', { text: t }))),
      el('span', { class: 'question-clock-cell', title: wait === null ? 'asked, never answered' : `asked at this hour, answered ${held(wait)} later` }, [
        dayClock({ startMin: minuteOfDay(ask.askedAt), endMin: wait === null ? null : minuteOfDay(ask.askedAt) + wait, width: 380, now: null }, scale),
      ]),
    ])

    // The three things that can be wrong with a question, in the one display
    // vocabulary. The words are `status.js`'s and are not reworded here — what
    // changes with the subject is the `title`, not the vocabulary.
    const verdicts = el('div', { class: 'verdicts' })
    const settle = (text) => verdicts.replaceChildren(el('span', { class: 'verdict-done', text }))
    if (ask.verdict) settle(statusWord(ask.verdict))
    else
      for (const [verdict, title] of [
        ['useful', 'worth asking'],
        ['wrong', 'the wrong question — you were not in that meeting, or it could not be answered'],
        ['not-now', 'a fair question at a bad moment'],
      ])
        verdicts.append(
          el('button', {
            type: 'button',
            class: 'act act-small',
            text: statusWord(verdict),
            title,
            onclick: async () => {
              for (const b of verdicts.querySelectorAll('button')) b.disabled = true
              settle((await postVerdict('owner_ask', ask.id, verdict)) ? statusWord(verdict) : 'not recorded')
            },
          }),
        )

    // ── What the answer became ───────────────────────────────────────────
    // Read back from the record, never from the DOM. A retracted row is kept
    // and marked: the one auto-routed answer in the whole record stored a
    // counter-question as a person's name, and hiding it the moment the owner
    // corrected it would hide the evidence that auto-routing was the mistake.
    const became = (ask.routed ?? []).map((f) =>
      el('li', { class: 'question-became', 'data-tone': f.retracted ? 'quiet' : null }, [
        el('span', { text: factSentence(f, f.subject) }),
        f.retracted ? el('span', { class: 'question-became-gone', text: 'since corrected' }) : null,
      ]),
    )

    // ── The routing door ──────────────────────────────────────────────────
    // Measured before it was promised: about a dozen of the forty-seven
    // answers carry a decision, a name or a correction; the rest are "Fine,
    // nothing to keep". So this is a door on the rows that have one, not a
    // chip strip on all of them — and which rows those are is the owner's
    // judgement, not a keyword match.
    //
    // **The form is now filled in, and the form itself did not change.** H2's
    // `askHarvest` reads the answer and files its proposals BESIDE the ask;
    // this is the only thing that reads them. Still no extraction happening
    // here, and still no auto-route: the model fills the fields, the owner
    // reads the sentence and presses, and that press is the only thing that
    // writes. The id's own guarantee is the fallback — a who-is question is
    // about that alias and can only be `knownAs` — for every answer no model
    // has looked at yet.
    const proposals = Array.isArray(ask.proposals) ? ask.proposals : []
    const prefill = proposals[0] ?? routePrefill(ask)
    const form = el('form', { class: 'question-form', hidden: true })
    const opener = el('button', { type: 'button', class: 'act act-small', text: 'Route it →', title: 'Keep something from this answer as a fact' })
    const said = el('p', { class: 'panel-note' })
    const kind = el('select', { class: 'select', name: 'entityKind' }, ASSERTABLE_ENTITY_KINDS.map((k) => el('option', { value: k, text: k, selected: k === prefill.entityKind })))
    const field = (name, label, value, attrs = {}) => el('label', { class: 'goal-field' }, [el('span', { text: label }), el('input', { class: 'proposal-other', name, value, ...attrs })])
    form.replaceChildren(
      el('div', { class: 'question-form-row' }, [el('label', { class: 'goal-field' }, [el('span', { text: 'About' }), kind]), field('canonicalName', 'Which one?', prefill.canonicalName, { type: 'text', maxlength: '160', required: true, placeholder: 'the name you would say' })]),
      field('predicate', 'Says what?', prefill.predicate, { type: 'text', maxlength: '60', required: true, placeholder: 'knownAs, decided, prefers…' }),
      // The model's object when it read one; otherwise the answer verbatim, as
      // it has always been — the field the owner edits, never the claim.
      field('object', 'Which is?', String(prefill.object ?? ask.answer ?? '').slice(0, 1000), { type: 'text', maxlength: '1000', required: true }),
      el('div', { class: 'question-form-row' }, [el('button', { type: 'submit', class: 'act act-small act-on', text: 'Keep it' }), said]),
    )
    opener.onclick = () => {
      form.hidden = !form.hidden
      opener.textContent = form.hidden ? 'Route it →' : 'Never mind'
      if (!form.hidden) form.querySelector('input')?.focus()
    }
    form.onsubmit = async (event) => {
      event.preventDefault()
      const values = Object.fromEntries(new FormData(form).entries())
      const submit = form.querySelector('button[type=submit]')
      submit.disabled = true
      try {
        await assert({ ...values, sourceEventId: ask.answerEventId })
        said.textContent = 'Kept. It appears under this question on the next read.'
        form.hidden = true
        opener.textContent = 'Route it →'
      } catch {
        said.textContent = 'That could not be kept.'
      }
      submit.disabled = false
    }

    // ── The model's other two readings ────────────────────────────────────
    // The first proposal is in the form above, where it can be edited. A
    // second and a third are extra lines with their own Keep, because an
    // answer that named three people should not cost three passes through one
    // form — and because a row the owner does not press is a row that never
    // becomes anything, which is the whole ratio this item exists to move.
    // Each is drawn as a SENTENCE and not as `predicate → object`: a row the
    // owner cannot say out loud has not been designed yet.
    const extras = proposals.slice(1).map((proposal) => {
      const note = el('span', { class: 'question-extra-said' })
      const keep = el('button', {
        type: 'button',
        class: 'act act-small',
        text: 'Keep it',
        onclick: async () => {
          keep.disabled = true
          try {
            await assert({ ...proposal, sourceEventId: ask.answerEventId })
            note.textContent = 'Kept. It appears under this question on the next read.'
          } catch {
            note.textContent = 'That could not be kept.'
            keep.disabled = false
          }
        },
      })
      return el('li', { class: 'question-extra' }, [el('span', { text: factSentence(proposal, proposal.canonicalName) }), keep, note])
    })

    return el('details', { class: 'question', 'data-tone': ask.answer ? null : 'quiet', style: { '--i': index } }, [
      summary,
      el('div', { class: 'question-open' }, [
        // A fold adds. The question, the state and the timing are all on the
        // line above, so what goes in here is the answer — the valuable part,
        // and therefore the one thing with the rule — the reason Gnomon gave
        // for asking, and the exact clock times the picture rounds off.
        stackedBlock({
          body: ask.answer ?? null,
          subline: ask.reason ? `Gnomon asked because: ${ask.reason}` : null,
          meta: [`asked ${when(ask.askedAt)}`, ask.answeredAt ? `answered ${when(ask.answeredAt)}` : 'never answered'],
        }),
        became.length ? el('ul', { class: 'question-becames' }, became) : null,
        el('div', { class: 'question-acts' }, [verdicts, ask.answer ? opener : null]),
        form,
        extras.length ? el('ul', { class: 'question-extras' }, extras) : null,
      ]),
    ])
  }

  const list = el('div', { class: 'question-list' }, asks.map(row))
  const count = (n, one, many) => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`

  section.replaceChildren(
    // No second title: the head already says Asks beside its mark. What belongs
    // here is what the head cannot say — which question this card answers, and
    // the pin, since asking is a habit measured over weeks and a span of Today
    // would empty the card most mornings.
    el('p', {
      class: 'panel-lead',
      text: asks.length
        ? `Every question Gnomon has put to you — ${count(c.total, 'question')}, whatever span the board is on. Asking spends your attention before it has said anything useful, so the only thing worth measuring here is whether it was worth it.`
        : 'Gnomon has never asked you anything.',
    }),
    asks.length
      ? el('div', { class: 'question-census' }, [
          // **The ratio, as the headline.** The card's own review settled what
          // it is for: an inbox for the owner's own words, whose one measure is
          // how many answers became beliefs. That number was the last clause of
          // the third sentence, where nobody read it. It is two counts and a
          // dot, and it is not a percentage — 1 of 49 as "2%" is a figure that
          // says the asking failed, when what it says is that routing by hand
          // cost thirty seconds an answer.
          el('p', { class: 'question-ratio' }, [
            el('strong', { text: count(c.total, 'asked', 'asked') }),
            el('span', { text: '·' }),
            el('strong', { 'data-tone': c.routed === 0 ? 'quiet' : null, text: `${c.routed} kept` }),
            // Absent, not zero, on both: a row with a proposal nobody has
            // pressed is work waiting, and an answer nobody has read yet is
            // not an answer that held nothing.
            c.waiting ? el('span', { text: `${c.waiting} waiting for a press` }) : null,
            c.unread ? el('span', { text: `${c.unread} not read yet` }) : null,
          ]),
          // Three sentences, and each one is a count rather than a judgement.
          el('p', {
            text:
              c.judged === 0
                ? `${c.answered} answered, ${c.expired} expired — which is everything the record stores, and it is not how good the questions were. Say so on a row and this line starts meaning something.`
                : `${c.answered} answered, ${c.expired} expired. Of the ${count(c.judged, 'question')} you have judged, ${c.worthAsking} ${c.worthAsking === 1 ? 'was' : 'were'} worth asking.`,
          }),
          el('p', {
            text: `${count(c.byKind.length, 'kind')} of question — ${c.byKind.map(([kind, n]) => `${n} ${KIND_WORDS[kind]}`).join('; ')}. ${c.repeated} of them came within an hour of another of the same kind.`,
          }),
          // What pressing a word has DONE, which until now was nothing: a
          // verdict on an ask lowers its whole CLASS, and B1 says the card has
          // to be able to read that back. Absent when nothing is quieted —
          // "you have quieted 0 kinds" would train the eye to skip the line.
          quieting.length
            ? el('p', {
                text: `You have called ${quieting.map((q) => `${q.words} the wrong question${q.fires > 1 ? ` ${q.fires} times` : ''}, so ${q.effect}`).join('; and ')}. ${quieting.length === 1 ? 'It comes' : 'Each comes'} back on its own over the following weeks.`,
              })
            : null,
          el('p', {
            text:
              c.medianWait === null
                ? 'Nothing has been answered yet.'
                // The kept count came OFF this sentence when it became the
                // headline: it was the last clause of the third line, and a
                // number said twice is a number read once.
                : `You usually answer within ${held(c.medianWait)}; the longest wait was ${held(c.longestWait)}, and ${count(c.slow, 'question')} sat over an hour.`,
          }),
        ])
      : null,
    // The axis, named once. The clock is a time of DAY: reading the column top
    // to bottom says when Gnomon interrupts, and the band says how long it left
    // the owner holding the question.
    asks.length
      ? el('div', { class: 'question-head' }, [
          // An empty leading cell: the head's first track stands in for the
          // caret, the question and the state, so the label lands over the
          // column it actually names.
          el('span'),
          el('span', { class: 'question-head-label', text: 'asked · held' }),
          el('span', { class: 'question-clock-cell question-hours-row' }, scaleHours(scale).map((hour) => el('span', { class: 'ritual-hour', style: { '--at': `${((hour * 60 - scale.from) / (scale.to - scale.from)) * 100}%` }, text: String(hour).padStart(2, '0') }))),
        ])
      : null,
    asks.length ? list : el('div', { class: 'none', text: 'Nothing to show.' }),
  )
  return section
}
