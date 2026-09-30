// The People card: who the owner meets, how often and with whom, and naming someone.
import { el } from './surfaces.js'
import { read } from './read.js'
import { icon } from './icons.js'
import { goalTrail, trailScale } from './goal-trail.js'
import { when } from './view-kit.js'
import { span } from './view-day.js'

/**
 * Who Gnomon has met, and what it calls them.
 *
 * The surface that makes automatic naming safe to run. `identity-resolve` names
 * a hashed attendee from addresses already on the machine, and a derivation can
 * be imperfect — `alexm@example.com` yields "Alexm", which is a real improvement on
 * `person-c205ca11f2` and still not what anyone calls him. Before this page the
 * only way to correct that was to answer a question Gnomon chose to ask, at a
 * time Gnomon chose; now it is two seconds whenever the owner looks.
 *
 * A rename writes the same `knownAs` fact `gnomon_assert` writes, with the same
 * `assertion` provenance — the owner's word, superseding a derived name on one
 * observation rather than three.
 */
export function peopleSection(data) {
  const people = Array.isArray(data?.people) ? data.people : []
  const unnamed = Array.isArray(data?.unnamed) ? data.unnamed : []
  const notPeople = Array.isArray(data?.notPeople) ? data.notPeople : []
  const section = el('section', { class: 'panel' })

  // ONE scale for the whole list, exactly as the goals card does it. The column
  // of trails is the point: thirty rows each fitted to their own extent would be
  // thirty pictures and no comparison.
  const scale = trailScale([...people, ...unnamed])
  const names = people.map((p) => p.name)
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null)

  /**
   * The ONE write on this card, and it is the door that already existed.
   *
   * A rename and a merge are the same act — saying what this entity should
   * answer to — so they are the same `knownAs` assertion through
   * `/gnomon/people/name`. The merge is only a rename whose text the owner did
   * not have to type: naming `Alex` "Alex Morgan" makes both rows resolve
   * to one name, and the fold on the next read does the rest. Nothing is
   * rewritten, nothing is deleted, and no `entity:merge` signal exists — an
   * alias leaves every fact where it was and only changes the answer to "who is
   * this".
   */
  const name = (alias, value) =>
    fetch('/gnomon/people/name', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alias, name: value }) }).then((r) => {
      if (!r.ok) throw new Error(String(r.status))
      return r
    })

  /**
   * Who else was in those rooms, as a sentence and then as a column.
   *
   * The sentence first, because "always with" is the whole finding and a reader
   * should not have to count marks to get it. Everyone whose count equals this
   * person's meeting count was in EVERY room — that is a team, or a standing
   * pair, and it is the difference between a colleague and an acquaintance that
   * a flat meeting count cannot express.
   *
   * Someone the owner only ever sees alone gets that said out loud rather than
   * an empty heading: Marco Kuiper has three meetings and no company, and "you
   * see them one to one" is a better fact than a blank.
   */
  const company = (person) => {
    const all = Array.isArray(person.with) ? person.with : []
    if (person.meetings === 0) return []
    if (all.length === 0) return [el('p', { class: 'person-alone', text: 'Nobody else on the record was in those rooms — you see them one to one.' })]
    const always = all.filter((w) => w.shared === person.meetings)
    const say = (names) => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)
    const label = (w) => (w.unnamed ? 'someone still unnamed' : w.name)
    return [
      el('p', {
        class: 'person-with-lead',
        text:
          always.length && person.meetings > 1
            ? `Every time, also in the room: ${say(always.map(label))}.`
            : `Also in the room: ${say(all.slice(0, 3).map(label))}${all.length > 3 ? `, and ${all.length - 3} more` : ''}.`,
      }),
      el(
        'ul',
        { class: 'person-with-list' },
        all.map((w) =>
          el('li', { 'data-unnamed': w.unnamed ? '' : null }, [
            // A hash never reaches the page as a name — the rule this whole card
            // exists to enforce — but the row stays, because they were really
            // there and the count is real.
            el('span', { class: 'person-with-name', text: w.unnamed ? 'an unnamed attendee' : w.name }),
            el('span', { class: 'person-with-count', text: `${w.shared} of ${person.meetings}` }),
            el('span', { class: 'person-trail-cell', title: `in ${w.shared} of ${person.meetings} rooms with them` }, [goalTrail({ life: w.life, width: 200 }, scale)]),
          ]),
        ),
      ),
      person.withMore ? el('p', { class: 'person-with-more', text: `and ${person.withMore} more, each in one room` }) : null,
    ].filter(Boolean)
  }

  /** What this row's marks mean, for the hand that stops on it. */
  const trailTitle = (person) => {
    if (!person.meetings) return 'never in a timed meeting with you'
    const ago = person.daysSince
    return `${person.meetings} meeting${person.meetings === 1 ? '' : 's'} with you — last ${when(person.lastSeen)}`
  }

  // ── One person ───────────────────────────────────────────────────────────
  // A foldable row, the shape the goals card landed and DESIGN.md now names.
  // Closed is a LINE: mark, name, how long ago, the trail. Everything that is a
  // list or a verb — the meetings themselves, the other ids this row folded in,
  // the rename and the merge — waits inside, because thirty rows carrying four
  // controls each is a hundred and twenty boxes drawn over a list of colleagues.
  const row = (person, index) => {
    const acts = el('div', { class: 'goal-acts' })
    const said = el('span', { class: 'goal-said', hidden: true })
    const call = async (alias, value, label) => {
      for (const control of acts.querySelectorAll('button, input, select')) control.disabled = true
      try {
        await name(alias, value)
        said.textContent = `${label} It appears on the next read.`
      } catch {
        said.textContent = 'That could not be recorded.'
      }
      said.hidden = false
    }

    // The merge, where the record can suggest one. "Alex" under "Alex
    // Morgan" is one tap; "Jordan" fits two colleagues, so it asks instead of
    // choosing — the audit's own duplicate list had those three as one human and
    // they are not.
    const hint = person.hint
    if (hint?.sure) acts.append(el('button', { type: 'button', class: 'act act-small', text: `Same as ${hint.could[0]}`, onclick: () => call(person.alias, hint.could[0], 'Merged.') }))
    else if (hint) for (const other of hint.could) acts.append(el('button', { type: 'button', class: 'act act-small', text: `Same as ${other}`, onclick: () => call(person.alias, other, 'Merged.') }))

    // Anyone else on the list, for the duplicates no prefix can see — Mateo and
    // Mark Janssen share four letters and nothing a machine may act on.
    const pick = el('select', { class: 'select person-pick', 'aria-label': `Say who ${person.name} really is` }, [el('option', { value: '', text: 'same as…' }), ...names.filter((n) => n !== person.name).map((n) => el('option', { value: n, text: n }))])
    pick.onchange = () => pick.value && call(person.alias, pick.value, 'Merged.')
    acts.append(pick)

    const field = el('input', { class: 'proposal-other', type: 'text', maxlength: '60', placeholder: 'or call them…', 'aria-label': `A name for ${person.name}` })
    field.onkeydown = (event) => {
      if (event.key !== 'Enter' || field.value.trim().length < 2) return
      event.preventDefault()
      call(person.alias, field.value.trim(), 'Saved.')
    }
    acts.append(field, said)

    const ago = person.daysSince
    const summary = el('summary', { class: 'person-line' }, [
      el('span', { class: 'goal-caret' }, [icon('more')]),
      el('span', { class: 'person-name', text: person.name }),
      // How long ago, in the words the owner used to ask the question. A date
      // is a lookup; "2 weeks ago" is the answer.
      el('span', { class: 'person-ago', 'data-cold': ago === null || ago > 14 ? '' : null, text: ago === null ? 'never met' : ago === 0 ? 'today' : ago === 1 ? 'yesterday' : ago < 14 ? `${ago} days ago` : `${Math.floor(ago / 7)} weeks ago` }),
      el('span', { class: 'person-met', text: person.meetings ? `${person.meetings}×` : '' }),
      el('span', { class: 'person-trail-cell', title: trailTitle(person) }, [goalTrail({ life: person.life, width: 200 }, scale)]),
      // The question goes in the SUMMARY, for the same reason the goals card's
      // stale nudge does: inside the fold it is invisible on every row the owner
      // has not opened, which is all of them. "Alex" sitting at the bottom of
      // the list with nothing on it is the duplicate the owner came to fix, and
      // it was the one row saying nothing. The verbs stay inside; only the
      // question comes out.
      hint ? el('p', { class: 'person-nudge', text: hint.sure ? `Probably ${hint.could[0]} — open the row to say so.` : `Could be ${hint.could.join(' or ')} — open the row to say which.` }) : null,
    ])

    return el('details', { class: 'person', style: { '--i': index } }, [
      summary,
      el('div', { class: 'goal-open' }, [
        // The rooms, and each one carrying its own tick in the trail column —
        // the same column, at the same x, as the trail on the line above. That
        // tick is what wires the list to the picture: the reader can see which
        // mark on the header is which meeting without being told.
        person.met?.length
          ? el(
              'ul',
              { class: 'person-met-list' },
              person.met.map((m) =>
                el('li', {}, [
                  el('span', { class: 'person-met-title', text: m.title }),
                  el('span', { class: 'person-met-when', text: when(m.at) ?? '' }),
                  el('span', { class: 'person-trail-cell' }, [goalTrail({ life: [{ at: m.at, kind: 'met' }], width: 200 }, scale)]),
                ]),
              ),
            )
          : el('p', { class: 'none', text: 'No timed meeting on the record — this name arrived some other way.' }),
        // ── Who else was in the room ────────────────────────────────────────
        // The one connection this record holds. A person carries two predicates
        // and neither is about another person, but an event carries an attendee
        // LIST — so "you and Isa were both in Puzzlez - Refinement" was already
        // written down twice and nothing read it.
        //
        // Drawn on the SAME axis as everything above, so the shape of a working
        // relationship is legible at a glance: three people whose marks sit
        // under every one of hers are the team she comes with, and one whose
        // mark appears once is someone who was in a room that day.
        ...company(person),
        person.aliases?.length > 1 ? el('p', { class: 'goal-derived', text: `Already folded together from: ${person.aliases.join(', ')}` }) : null,
        acts,
      ]),
    ])
  }

  // ── The unnamed ──────────────────────────────────────────────────────────
  // ONE bucket, not eight rows at the top of the list. They are the same
  // question asked eight times, and the meeting they were in is the only clue
  // the record can offer — which turns out to be a good one: "Pitch prep",
  // "Lichtinstallatie Event Space bedenken met Djuna". A hash with a meeting
  // title beside it is a question the owner can actually answer.
  const ghosts = () => {
    const list = el('div', { class: 'person-ghosts' })
    for (const ghost of unnamed) {
      const said = el('span', { class: 'goal-said', hidden: true })
      const field = el('input', { class: 'proposal-other', type: 'text', maxlength: '60', placeholder: 'who is this?', 'aria-label': `Who is ${ghost.alias}` })
      field.onkeydown = async (event) => {
        if (event.key !== 'Enter' || field.value.trim().length < 2) return
        event.preventDefault()
        field.disabled = true
        try {
          await name(ghost.alias, field.value.trim())
          said.textContent = 'Saved.'
        } catch {
          said.textContent = 'That could not be saved.'
        }
        said.hidden = false
      }
      list.append(
        el('div', { class: 'person-ghost' }, [
          // The clue, not the hash. The hash is what the machine calls them and
          // says nothing to anyone; the meeting is what the owner remembers.
          el('span', { class: 'person-ghost-clue', text: ghost.met?.length ? ghost.met.map((m) => m.title).join(' · ') : 'no meeting on the record' }),
          el('span', { class: 'person-ghost-when', text: ghost.lastSeen ? (when(ghost.lastSeen) ?? '') : '' }),
          field,
          said,
        ]),
      )
    }
    return el('details', { class: 'person person-bucket' }, [
      el('summary', { class: 'person-line' }, [
        el('span', { class: 'goal-caret' }, [icon('more')]),
        el('span', { class: 'person-name', text: `${unnamed.length} unnamed ${unnamed.length === 1 ? 'attendee' : 'attendees'}` }),
        el('span', { class: 'person-ago', text: 'an address this machine could not match' }),
        el('span'),
        el('span'),
      ]),
      el('div', { class: 'goal-open' }, [list]),
    ])
  }

  const cold = people.filter((p) => p.daysSince !== null && p.daysSince > 14).length
  const seen = people.filter((p) => p.meetings > 0).length

  // No second title — the head says People beside its mark. What belongs here is
  // the identity line, and the honest one is about the span: this card is pinned
  // to the whole record, because a colleague you have not seen for a month is
  // exactly the row you came for and a seven-day span would delete them.
  section.replaceChildren(
    ...[
    el('p', {
      class: 'panel-note',
      text: [
        `${people.length} people, most recently seen first${cold ? `, ${cold} of them not for a fortnight` : ''}.`,
        `Every meeting on the record, whatever span the board is on — ${seen} of them have been in a room with you.`,
        // Named, not silently dropped: three rows that vanish are three rows the
        // owner cannot find again and has no way to know were ever there.
        notPeople.length ? `${notPeople.map((n) => n.name).join(', ')} left out — ${[...new Set(notPeople.map((n) => n.why))].join(' and ')}, not people.` : null,
      ]
        .filter(Boolean)
        .join(' '),
    }),
    people.length
      ? el('div', { class: 'goal-legend' }, [
          el('span', { class: 'goal-legend-span', text: `${scale.days} days` }),
          el('span', { class: 'goal-legend-key' }, [el('span', { class: 'lk lk-met' }), el('span', { text: 'a meeting with you' })]),
        ])
      : null,
    el('div', { class: 'goal-list' }, [...people.map(row), unnamed.length ? ghosts() : null].filter(Boolean)),
    people.length + unnamed.length ? null : el('div', { class: 'none', text: 'Nobody on the record yet.' }),
    ].filter(Boolean),
  )
  return section
}

/**
 * The shelf: what Gnomon made while the owner was away, waiting with Keep /
 * Not now. The tab is the desk — this is where its own work is left. Nothing
 * here is asserted as fact; every card carries its sources and the owner's
 * verdict is what teaches (`useful` reinforces, `wrong` retracts).
 *
 * A card that has been answered folds to its title: the owner has read it, and
 * a shelf of open books is a shelf nobody can see the end of. The title
 * unfolds it again; the small "ask" beside it loads the question.
 */
/**
 * "Wrong" asks one question: why. Resolves with the owner's line, or undefined
 * when they send nothing — the verdict is recorded either way, so a reader in a
 * hurry is never held up by a field they did not want.
 */
export function askWhy(host) {
  return new Promise((resolve) => {
    const field = el('input', { class: 'proposal-other', type: 'text', maxlength: '300', placeholder: 'what was wrong? (optional)', 'aria-label': 'Why this was wrong' })
    const send = el('button', { type: 'button', class: 'act act-small', text: 'Send' })
    const done = () => resolve(field.value.trim() || undefined)
    send.onclick = done
    field.onkeydown = (e) => {
      if (e.key === 'Enter') done()
      else if (e.key === 'Escape') resolve(undefined)
    }
    host.replaceChildren(field, send)
    field.focus()
  })
}
