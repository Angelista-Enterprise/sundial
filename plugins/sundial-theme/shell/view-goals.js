// The Goals card: what the owner said they want, its steps, and the work that moved it.
import { el } from './surfaces.js'
import { read } from './read.js'
import { icon, iconLabel } from './icons.js'
import { status, statusWord } from './status.js'
import { formatSteps, nextStepState } from './goals.js'
import { goalTrail, trailScale } from './goal-trail.js'
import { span } from './view-day.js'

/**
 * What the owner said they want.
 *
 * Their goals were data with no surface: `goal` entities each carrying a real
 * `status` fact, reachable by no route and no tool. Then they had a surface with
 * no door — the owner's first words on it were "how do I add a goal", and the
 * answer was that you could not, from here. Everything on this card is now
 * writable from it, and every write goes out through `/gnomon/api/assert` as an
 * assertion, because a goal is the owner's own word and nothing else.
 *
 * Distinct from the research goal in the Unsaid instrument, which is GNOMON'S
 * open question about its own forecasts. These are the owner's.
 *
 * Four rules from the audit meet here. A goal has a why, so it is a stacked
 * block and not a table row. Its state is a word from `status.js`. What moved is
 * shown from the record, never invented. And what has not moved for a fortnight
 * greys out and asks.
 */
export function goalsSection(data) {
  const goals = Array.isArray(data?.goals) ? data.goals : []
  const quietAfter = Number(data?.quietAfterDays) || 14
  // ONE scale for the list. Computed here and handed to every row, because the
  // whole point is that the column of trails is comparable — thirteen rows each
  // fitted to their own extent would be thirteen pictures, not one.
  const scale = trailScale(goals)
  const section = el('section', { class: 'panel' })
  const names = goals.map((g) => g.goal)

  /**
   * One door for every write on this card.
   *
   * `/gnomon/api/assert` is the same door `gnomon assert` and the chat use, so a
   * goal the owner types here and a goal they say out loud land on the same
   * entity. Two doors is what split four goals across two ids each.
   */
  const assert = (name, predicate, object) =>
    fetch('/gnomon/api/assert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entityKind: 'goal', canonicalName: name, predicate, object }),
    }).then((r) => {
      if (!r.ok) throw new Error(String(r.status))
      return r
    })

  const since = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null)

  // ── Adding one ───────────────────────────────────────────────────────────
  // Folded to a single line until asked for. The card is read far more often
  // than it is written to, and a permanent four-field form above nine goals
  // makes the goals the second thing on their own surface.
  const form = el('form', { class: 'goal-form', hidden: true })
  const open = el('button', { type: 'button', class: 'act act-small', text: '+ Goal' })
  const field = (name, label, attrs = {}) =>
    el('label', { class: 'goal-field' }, [el('span', { text: label }), el('input', { class: 'proposal-other', name, ...attrs })])
  const parent = el('select', { class: 'select', name: 'partOf' }, [el('option', { value: '', text: 'on its own' }), ...names.map((n) => el('option', { value: n, text: n }))])
  const said = el('p', { class: 'panel-note' })
  form.replaceChildren(
    field('name', 'What do you want?', { type: 'text', maxlength: '160', required: true, placeholder: 'in your own words…' }),
    field('why', 'Why does it matter?', { type: 'text', maxlength: '400', placeholder: 'the reason you will read back in a month' }),
    el('div', { class: 'goal-form-row' }, [
      field('targetDate', 'By when?', { type: 'date' }),
      el('label', { class: 'goal-field' }, [el('span', { text: 'Part of' }), parent]),
      // The one verb on the form, so it is the filled one. Everything else here
      // is a field; this is the thing that happens.
      el('button', { type: 'submit', class: 'act act-small act-on', text: 'Record it' }),
    ]),
    said,
  )
  open.onclick = () => {
    form.hidden = !form.hidden
    open.textContent = form.hidden ? '+ Goal' : 'Never mind'
    if (!form.hidden) form.querySelector('input')?.focus()
  }
  form.onsubmit = async (event) => {
    event.preventDefault()
    const values = Object.fromEntries(new FormData(form).entries())
    const name = String(values.name ?? '').trim()
    if (name === '') return
    const submit = form.querySelector('button[type=submit]')
    submit.disabled = true
    said.textContent = ''
    try {
      // The state first, so a goal exists even if a later field is refused by
      // the fold's own shape gate. Each predicate is its own assertion — the
      // record has no compound write and should not grow one for a form.
      await assert(name, 'status', 'open')
      for (const [predicate, value] of [
        ['why', String(values.why ?? '').trim()],
        ['targetDate', String(values.targetDate ?? '').trim()],
        ['partOf', String(values.partOf ?? '').trim()],
      ])
        if (value !== '') await assert(name, predicate, value)
      said.textContent = `Recorded. It appears here on the next read.`
      form.reset()
    } catch {
      said.textContent = 'That could not be recorded.'
    }
    submit.disabled = false
  }

  /** What this row's marks mean, for the hand that stops on it. */
  const trailTitle = (goal) => {
    const said = (goal.life ?? []).filter((e) => e.kind === 'said').length
    const did = (goal.life ?? []).filter((e) => e.kind === 'did').length
    if (said === 0 && did === 0) return 'nothing dated'
    const parts = [said ? `you said something ${said} time${said === 1 ? '' : 's'}` : null, did ? `${did} commit${did === 1 ? '' : 's'} on its branch` : null].filter(Boolean)
    return `${parts.join(', ')} — last ${goal.movedAt ? since(goal.movedAt) : 'unknown'}`
  }

  // ── One goal ─────────────────────────────────────────────────────────────
  // The whole row is the accordion, not just its tail. The first version put
  // the why, four buttons and a meta line on every one of thirteen goals at
  // rest, and the owner's word for it was "a lot of information shown at once":
  // a page of paragraphs and fifty-two controls to answer "what am I trying to
  // do". So closed is a LINE — mark, name, state, and the small facts — and
  // everything that is a paragraph, a list or a verb waits inside.
  //
  // Same shape as a moment: `momentRow` in a list, the page one click on. The
  // stale question is the one thing that stays outside, because a nudge nobody
  // opens the row to see is not a nudge.
  const block = (goal, index) => {
    const state = status(goal.state)
    const acts = el('div', { class: 'goal-acts' })
    const set = async (next, label) => {
      for (const button of acts.querySelectorAll('button')) button.disabled = true
      try {
        // The why rides along with the state, because they share one stored
        // field. Dropping it on a status change would silently delete the
        // owner's reason for the goal.
        await assert(goal.goal, 'status', goal.why ? `${next} — ${goal.why}` : next)
        acts.replaceChildren(el('span', { class: 'goal-said', text: `${label}.` }))
      } catch {
        acts.replaceChildren(el('span', { class: 'goal-said', text: 'Not recorded.' }))
      }
    }
    // Only the states it is not already in — a button that changes nothing is a
    // button the owner has to think about. `Keep` is the same state again, and
    // only appears where saying it again means something: on a goal that has
    // gone quiet, where re-asserting it is how the owner answers the question.
    if (goal.stale) acts.append(el('button', { type: 'button', class: 'act act-small', text: 'Keep', title: 'Say it still stands', onclick: () => set(goal.state, 'Kept') }))
    for (const [next, label] of [
      ['doing', 'Doing'],
      ['paused', 'Paused'],
      ['done', 'Done'],
      ['dropped', 'Drop'],
    ])
      if (next !== goal.state) acts.append(el('button', { type: 'button', class: 'act act-small', text: label, onclick: () => set(next, label === 'Drop' ? 'Dropped' : label) }))

    // What actually moved. Nothing here is computed from the goal alone: the
    // branch is one the goal NAMES, the count is its own commits, and `[6/7]`
    // is a token the owner put in those commit subjects on purpose.
    const move = goal.movement
    const at = goal.progress ?? { done: 0, total: 0 }
    // The closed line's small facts. The state is NOT among them — it is
    // already beside the name — and neither is the why, which is a paragraph.
    // The trail says WHEN, better than a date can: it shows the whole life, not
    // the last touch. So the date, the branch and the commit count all came off
    // the closed line once the trail went on it — a fold adds, it never repeats,
    // and that rule holds sideways as well as downwards. What is left is the one
    // thing the picture cannot say, which is how far through the steps it is,
    // and a deadline, which is in the future and therefore off the axis.
    const meta = [
      at.total ? iconLabel('done', `${at.done} of ${at.total}`) : null,
      goal.targetDate ? iconLabel('day', `by ${since(goal.targetDate)}`) : null,
    ].filter(Boolean)

    // ── Inside: the steps and the commits ─────────────────────────────────
    // Two lists, and they are NOT the same list even when one was derived from
    // the other. The steps are the work as the owner thinks of it; the commits
    // are the record's own evidence that it happened, with the hash and the
    // date the steps deliberately leave out. Kept apart under their own heads.
    let steps = Array.isArray(goal.steps) ? goal.steps.map((s) => ({ ...s })) : []
    const stepList = el('ol', { class: 'goal-steps' })
    const none = el('p', { class: 'none', text: 'No steps yet.' })
    const saveSteps = async (next) => {
      steps = next
      drawSteps()
      try {
        await assert(goal.goal, 'steps', formatSteps(next))
      } catch {
        none.textContent = 'That could not be saved.'
      }
    }
    function drawSteps() {
      none.hidden = steps.length > 0
      stepList.replaceChildren(
        ...steps.map((step, i) =>
          el('li', { class: 'goal-step', 'data-state': step.state }, [
            // The mark IS the control: one tap moves the step on. A separate
            // button beside a tick would be two things saying one thing.
            el('button', {
              type: 'button',
              class: 'goal-step-mark',
              title: `${statusWord(step.state === 'todo' ? 'open' : step.state === 'skip' ? 'dropped' : step.state)} — tap to move it on`,
              'aria-label': `${step.text}: ${step.state}`,
              onclick: () => saveSteps(steps.map((x, k) => (k === i ? { ...x, state: nextStepState(x.state) } : x))),
            }),
            el('span', { class: 'goal-step-text', text: step.text }),
            el('button', { type: 'button', class: 'goal-step-drop', title: 'Take this step off the list', 'aria-label': `Remove ${step.text}`, text: '×', onclick: () => saveSteps(steps.filter((_, k) => k !== i)) }),
          ]),
        ),
      )
    }
    drawSteps()
    const addStep = el('input', { class: 'goal-step-add', type: 'text', maxlength: '120', placeholder: 'add a step…', 'aria-label': `Add a step to ${goal.goal}` })
    addStep.onkeydown = (event) => {
      if (event.key !== 'Enter' || addStep.value.trim() === '') return
      event.preventDefault()
      saveSteps([...steps, { state: 'todo', text: addStep.value.trim() }])
      addStep.value = ''
    }

    const log = move?.log ?? []
    const summary = el('summary', { class: 'goal-line' }, [
      // Every row carries a mark at the same place, foldable or not — without
      // it a row steps out of the column the others line up in.
      el('span', { class: 'goal-caret' }, [icon('more')]),
      el('span', { class: 'goal-name', text: goal.goal }),
      el('span', { class: 'goal-state', 'data-tone': state.tone, text: state.word }),
      meta.length ? el('span', { class: 'goal-meta' }, meta) : el('span'),
      // The life, last, so its axis ends at the same x on every row — the whole
      // point is that the column of them is one picture. The `title` carries
      // what the marks mean for this row; the key is named once at the head,
      // which is the rule for a number in a picture.
      el('span', { class: 'goal-trail-cell', title: trailTitle(goal) }, [
        goalTrail({ life: goal.life, live: ['open', 'doing', 'waiting', 'blocked'].includes(goal.state), width: 200 }, scale),
      ]),
      // The nudge goes in the SUMMARY, not in the fold. Anything else inside
      // `<details>` is hidden while the row is closed, which is every row the
      // owner has not opened — a question nobody can see until they go looking
      // is not a question. It is the only thing allowed to make this row two
      // lines tall, and it earns that by being the one row that wants an answer.
      goal.stale ? el('p', { class: 'goal-nudge', text: `Quiet for ${goal.quietDays} days — keep it, pause it, or drop it?` }) : null,
    ])

    const node = el('details', { class: 'goal', 'data-tone': goal.stale ? 'quiet' : null, style: { '--i': index } }, [
      summary,
      el('div', { class: 'goal-open' }, [
        // The why is the valuable part, so it keeps the quote rule it had.
        goal.why ? el('div', { class: 'sb-body' }, [el('p', { class: 'sb-text', text: goal.why })]) : null,
        el('div', { class: 'goal-open-meta' }, [
          goal.saidBy === 'owner' ? 'you said so' : goal.saidBy === 'conversation' ? 'from a conversation' : null,
          goal.movedAt ? `last moved ${since(goal.movedAt)}` : null,
          goal.alsoStored?.length ? `also stored, under an older id: ${goal.alsoStored.filter(Boolean).join(', ')}` : null,
        ].filter(Boolean).map((t) => el('span', { text: t }))),
        acts,
        el('div', { class: 'goal-part' }, [
          el('h4', { class: 'goal-part-title', text: 'Steps' }),
          // Said once, at the top: these were read off the commit tokens and
          // nobody agreed to them. The first edit writes the real list.
          goal.stepsAreDerived ? el('p', { class: 'goal-derived', text: 'Read from the [n/7] tokens in the commits. Change anything and it becomes your list.' }) : null,
          stepList,
          none,
          addStep,
        ]),
        log.length
          ? el('div', { class: 'goal-part' }, [
              el('h4', { class: 'goal-part-title' }, [el('span', { text: 'Commits' }), el('span', { class: 'goal-part-note', text: move.branch })]),
              el(
                'ul',
                { class: 'goal-commits' },
                log.map((c) =>
                  el('li', { class: 'goal-commit' }, [
                    el('code', { class: 'goal-commit-hash', text: String(c.commitLine ?? '').slice(0, 7) }),
                    el('span', { class: 'goal-commit-text', text: String(c.commitLine ?? '').replace(/^[0-9a-f]{7,40}\s+/, '') }),
                    el('span', { class: 'goal-commit-when', text: since(c.timestamp) ?? '' }),
                  ]),
                ),
              ),
            ])
          : null,
      ]),
    ])
    return node
  }

  const list = el('div', { class: 'goal-list' })
  goals.forEach((goal, index) => {
    const node = block(goal, index)
    if (goal.child) node.classList.add('goal-child')
    list.append(node)
  })

  const live = goals.filter((g) => ['open', 'doing', 'waiting', 'blocked'].includes(g.state)).length
  const quiet = goals.filter((g) => g.stale).length

  // No second title. The pane's head already says Goals, beside the mark; what
  // belongs at the top of the body is the identity line, which is what the head
  // cannot say. The pin goes in it: goals do not obey the board's span on
  // purpose — one set in July is not less true in a seven-day window, and a span
  // of Today would empty the card every morning.
  section.replaceChildren(
    el('div', { class: 'goal-panel-head' }, [
      el('p', {
        class: 'panel-note',
        text: goals.length
          ? `${live} still in play of ${goals.length}${quiet ? `, ${quiet} of them quiet for over ${quietAfter} days` : ''}. Every goal, whatever span the board is on — Gnomon reads these before it offers to help.`
          : 'Gnomon reads these before it offers to help — a goal it cannot see is one it will not bring up.',
      }),
      open,
    ]),
    // The axis, named once, where a legend on every row would be thirteen
    // legends. Tall mark, short mark, and the one ochre dot — three words.
    goals.length
      ? el('div', { class: 'goal-legend' }, [
          el('span', { class: 'goal-legend-span', text: `${scale.days} days` }),
          el('span', { class: 'goal-legend-key' }, [
            el('span', { class: 'lk lk-said' }),
            el('span', { text: 'you said' }),
            el('span', { class: 'lk lk-did' }),
            el('span', { text: 'a commit' }),
            el('span', { class: 'lk lk-now' }),
            el('span', { text: 'still running' }),
          ]),
        ])
      : null,
    form,
    goals.length ? list : el('div', { class: 'none', text: 'Nothing recorded yet. Press + Goal, or just tell Gnomon what you are trying to do.' }),
  )
  return section
}
