// What waits for the owner's word on Today: untracked places to name, drafts, and the assistant's proposals.
import { el } from './surfaces.js'
import { statusWord } from './status.js'
import { hm, stagger } from './view-kit.js'

/**
 * Untracked time, and what to call it.
 *
 * The kernel times every unattributed focus period by host or app
 * (`attributionPropose`); this is where the biggest become a question the owner
 * can answer in one click. A card names the place, how much time it took, what
 * it looked like, and offers the projects the owner already has — the likeliest
 * first. "Track as X" writes a rule and applies it from the next window on;
 * "Not work" and "Ignore" are decisions too, so the card does not come back.
 * Nothing here is inferred as fact: it is the residue of refusing to guess,
 * handed to the one person who knows.
 */
export function proposalsSection(data, onAsk) {
  const proposals = Array.isArray(data?.proposals) ? data.proposals : []
  if (proposals.length === 0) return null
  const projects = Array.isArray(data?.projects) ? data.projects : []

  /**
   * One card, one place, and a SCOPE — because a place is not always one
   * project. figma.com carries Northwind, Puzzles and overture; localhost:8080
   * carries a puzzles path and a hub path. The scope rows are the whole place
   * plus each part Gnomon timed separately, so the owner answers the question
   * they can actually answer: "this path is Northwind", not "figma is Northwind".
   *
   * The two other answers are first-class, not an afterthought: Slack, Meet and
   * the shared vault are WORK BUT NOT ONE PROJECT, and Spotify is not work at
   * all. Before this the only options were a wrong rule or Ignore, so a
   * hundred minutes of Obsidian sat in "untracked" for ever.
   */
  const card = (pr) => {
    const wrap = el('article', { class: 'proposal', 'data-kind': pr.kind })
    const parts = Array.isArray(pr.parts) ? pr.parts : []
    // null = the whole place; otherwise the partKey being assigned.
    let scope = null
    let chosen = pr.suggested ?? null

    const scopes = el('div', { class: 'proposal-scopes' })
    const chips = el('div', { class: 'proposal-chips' })
    const other = el('input', { class: 'proposal-other', type: 'text', placeholder: 'or a new name…', 'aria-label': 'Another project name', maxlength: '60' })
    const track = el('button', { type: 'button', class: 'act act-small proposal-track', disabled: true })

    const scopeLabel = () => (scope === null ? pr.label : (parts.find((part) => part.partKey === scope)?.label ?? pr.label))
    const refreshTrack = () => {
      track.disabled = chosen === null || chosen === ''
      track.textContent = chosen ? `Track ${scopeLabel()} as ${chosen}` : 'Track as…'
    }
    const setScope = (next) => {
      scope = next
      for (const row of scopes.querySelectorAll('.proposal-scope')) row.setAttribute('aria-pressed', String((row.dataset.part || null) === next))
      // A part carries its own guess — `/file/eteck1` suggests northwind where the
      // host suggests nothing.
      const suggested = next === null ? pr.suggested : (parts.find((part) => part.partKey === next)?.suggested ?? pr.suggested)
      if (suggested) setChosen(suggested)
      else refreshTrack()
    }
    const setChosen = (name) => {
      chosen = name
      for (const chip of chips.querySelectorAll('.chip-pick')) chip.setAttribute('aria-pressed', String(chip.dataset.name === name))
      if (name !== null && other.value !== name) other.value = ''
      refreshTrack()
    }

    if (parts.length > 1) {
      scopes.append(
        el('button', { type: 'button', class: 'proposal-scope', 'data-part': '', 'aria-pressed': 'true', title: 'The whole place, one project', onclick: () => setScope(null) }, [
          el('span', { class: 'scope-label', text: `all of ${pr.label}` }),
          el('span', { class: 'scope-time', text: hm(pr.minutes) }),
        ]),
      )
      for (const part of parts) {
        scopes.append(
          el('button', { type: 'button', class: 'proposal-scope', 'data-part': part.partKey, 'aria-pressed': 'false', title: `${part.visits} visit${part.visits === 1 ? '' : 's'} — assign just this ${part.kind}`, onclick: () => setScope(part.partKey) }, [
            el('span', { class: `scope-label scope-${part.kind}`, text: part.kind === 'meeting' ? `meeting: ${part.label}` : part.label }),
            el('span', { class: 'scope-time', text: hm(part.minutes) }),
          ]),
        )
      }
    }

    const ordered = [...(pr.suggested ? [pr.suggested] : []), ...projects.filter((n) => n !== pr.suggested)].slice(0, 7)
    for (const name of ordered) {
      chips.append(
        el('button', {
          type: 'button',
          class: `chip-pick${name === pr.suggested ? ' chip-pick-suggested' : ''}`,
          'data-name': name,
          'aria-pressed': String(name === chosen),
          title: name === pr.suggested ? "Gnomon's guess, from the titles" : `Track as ${name}`,
          text: name,
          onclick: () => setChosen(name),
        }),
      )
    }
    other.addEventListener('input', () => {
      const v = other.value.trim()
      if (v !== '') {
        chosen = v
        for (const chip of chips.querySelectorAll('.chip-pick')) chip.setAttribute('aria-pressed', 'false')
        refreshTrack()
      } else setChosen(pr.suggested ?? null)
    })
    other.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !track.disabled) {
        e.preventDefault()
        track.click()
      }
    })

    const acts = el('div', { class: 'proposal-acts' })
    const settle = (text, cls) => {
      wrap.setAttribute('data-settled', '')
      if (cls) wrap.classList.add(cls)
      acts.replaceChildren()
      wrap.querySelector('.proposal-head').append(el('span', { class: 'proposal-outcome', text }))
      setTimeout(() => wrap.setAttribute('data-folded', ''), 900)
    }
    const decide = async (decision) => {
      const scopedPart = decision === 'assign' ? scope : null
      const label = scopeLabel()
      for (const b of wrap.querySelectorAll('button, input')) b.disabled = true
      let ok = false
      try {
        const res = await fetch('/gnomon/attribution/decide', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: pr.key, decision, ...(decision === 'assign' ? { project: chosen } : {}), ...(scopedPart ? { partKey: scopedPart } : {}) }),
        })
        ok = res.ok
      } catch {
        ok = false
      }
      if (!ok) {
        for (const b of wrap.querySelectorAll('button, input')) b.disabled = false
        acts.prepend(el('span', { class: 'proposal-fail', text: 'Not recorded — try again.' }))
        return
      }
      if (decision === 'assign' && scopedPart) settle(`${label} is ${chosen} from now on. The rest of ${pr.label} is still open.`, 'proposal-kept')
      else if (decision === 'assign') settle(`Tracked as ${chosen} from now on. Past time stays as it was.`, 'proposal-kept')
      else if (decision === 'shared') settle('Shared work — counted, never asked about again.', 'proposal-kept')
      else if (decision === 'personal') settle('Your own time. It stops counting as work.', 'proposal-dim')
      else if (decision === 'ambient') settle('Background. It plays while you work and counts as neither.', 'proposal-dim')
      else settle('Ignored. It will not be proposed again.', 'proposal-dim')
    }
    track.addEventListener('click', () => decide('assign'))
    acts.append(
      track,
      el('button', { type: 'button', class: 'act act-small', text: 'Shared work', title: 'Work, but no single project — Slack, Meet, the shared vault', onclick: () => decide('shared') }),
      el('button', { type: 'button', class: 'act act-small', text: 'Personal', title: 'Not work — private browsing, errands', onclick: () => decide('personal') }),
      el('button', { type: 'button', class: 'act act-small', text: 'Background', title: 'Music or audio playing while you work — not leisure, not a project', onclick: () => decide('ambient') }),
      el('button', { type: 'button', class: 'act act-small', text: 'Ignore', title: 'Not worth tracking either way', onclick: () => decide('ignore') }),
    )

    const titles = (pr.titles ?? []).filter((t) => t && t !== pr.label && !parts.some((part) => part.label === t))
    wrap.append(
      el('div', { class: 'proposal-head' }, [
        el('span', { class: 'proposal-kind', text: pr.kind === 'host' ? 'site' : 'app' }),
        el('button', {
          type: 'button',
          class: 'proposal-label row-ask',
          title: 'Find this in the record',
          text: pr.label,
          'data-explore': `search:${pr.label}`,
        }),
        el('span', { class: 'proposal-time' }, [el('span', { class: 'proposal-min', text: hm(pr.minutes) }), el('span', { text: ` · ${pr.visits} visit${pr.visits === 1 ? '' : 's'} · ${pr.days} day${pr.days === 1 ? '' : 's'}` })]),
      ]),
      el('div', { class: 'proposal-fold' }, [
        el('div', { class: 'proposal-fold-inner' }, [
          parts.length > 1 ? el('p', { class: 'proposal-hint', text: 'Several places under one name. Pick one to answer just that, or answer the whole thing. A meeting or a page title makes a rule that survives a port change; a bare localhost cannot.' }) : null,
          parts.length > 1 ? scopes : null,
          titles.length > 0 ? el('ul', { class: 'proposal-titles' }, titles.slice(0, 3).map((t) => el('li', { text: t }))) : null,
          el('div', { class: 'proposal-pick' }, [chips, other]),
          acts,
        ]),
      ]),
    )
    setScope(null)
    return wrap
  }

  const settled = data?.settled ?? {}
  const settledParts = [
    settled.assigned ? `${settled.assigned} rule${settled.assigned === 1 ? '' : 's'} written` : null,
    settled.shared ? `${settled.shared} shared` : null,
    settled.personal ? `${settled.personal} personal` : null,
  ].filter(Boolean)

  return el('section', { class: 'proposals' }, [
    el('div', { class: 'col-head' }, [
      el('h3', { class: 'col-title', text: 'Untracked time' }),
      el('span', { class: 'col-hint', text: `${hm(data.totalUntrackedMin)} across ${data.candidates} place${data.candidates === 1 ? '' : 's'} · ${proposals.length} worth a rule${settledParts.length > 0 ? ` · ${settledParts.join(', ')}` : ''}` }),
    ]),
    el('p', { class: 'proposals-why', text: 'Time no rule could place. Name it and Gnomon writes the rule and tracks it from the next window on. A place that carries several projects can be answered one path at a time; one that is work but no single project is shared.' }),
    stagger(el('div', { class: 'proposal-cards' }, proposals.map(card))),
  ])
}

/**
 * What the assistant proposed, and the owner's yes or no.
 *
 * The missing half of `gnomon_propose`. That tool writes an `assistant:proposal`
 * signal and `assistantTrack` folds it into a `proposal` loop (was `state.assistant.recent`), which
 * before this had exactly two readers — `context.ts` and `ambient-context.ts`,
 * both prompt builders. So a proposal travelled from the model into the model's
 * own next prompt and nowhere else, while the tool result told it "the owner can
 * accept or reject it". Twenty-three went that way.
 *
 * `assistantAcceptanceRate` divides accepted by resolved and is shown to the
 * model as its own track record. With nothing able to resolve a proposal, that
 * number was measuring a loop with no human in it; these two buttons are what
 * close it.
 */
/** Today shows at most this many; the rest wait rather than pushing the page down. */
export const MAX_PROPOSALS_ON_TODAY = 3

/**
 * J4.3 — what it drafted for you to send. The draft sits beside the evidence
 * it was written from and the judge's read of it (grounded, tone). Send opens
 * YOUR mail client with the draft filled in — the tap is yours, nothing leaves
 * this machine on Gnomon's word. Dismiss puts it away.
 */
export function draftsSection(data) {
  const open = Array.isArray(data?.open) ? data.open : []
  const closed = Array.isArray(data?.closed) ? data.closed : []
  if (open.length === 0 && closed.length === 0) return null
  const TONE = ['wrong', 'off', 'fit', 'right']
  const card = (d) => {
    const wrap = el('article', { class: 'proposal draft', 'data-kind': d.kind })
    const acts = el('div', { class: 'proposal-chips' })
    const settle = async (outcome) => {
      for (const b of acts.querySelectorAll('button')) b.disabled = true
      const ok = await fetch('/gnomon/api/draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: d.id, outcome }) }).then((r) => r.ok).catch(() => false)
      acts.replaceChildren(el('span', { class: 'panel-note', text: ok ? (outcome === 'sent' ? 'Handed to your mail client.' : 'Dismissed.') : 'That could not be recorded.' }))
    }
    if (d.kind === 'email') {
      acts.append(
        el('button', {
          type: 'button',
          class: 'act act-small',
          text: 'Send…',
          title: 'Opens your mail client with this draft filled in. You press send there.',
          onclick: () => {
            window.open(`mailto:${encodeURIComponent(d.to ?? '')}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`, '_blank')
            void settle('sent')
          },
        }),
      )
    } else {
      acts.append(
        el('button', {
          type: 'button',
          class: 'act act-small',
          text: 'Copy',
          title: 'Copies the note to your clipboard.',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(`${d.subject}\n\n${d.body}`)
            } catch {
              /* the text is on screen either way */
            }
            void settle('sent')
          },
        }),
      )
    }
    acts.append(el('button', { type: 'button', class: 'act act-small', text: 'Dismiss', onclick: () => settle('dismissed') }))
    const judge = d.judged
      ? `grounded ${d.judged.grounded === null ? '—' : d.judged.grounded.toFixed(2)} · tone ${d.judged.tone === null ? '—' : TONE[d.judged.tone] ?? d.judged.tone}`
      : 'being judged…'
    wrap.append(
      el('div', { class: 'proposal-label' }, [el('b', { text: d.kind === 'email' ? `To ${d.to ?? '—'}: ` : 'Note: ' }), d.subject]),
      el('pre', { class: 'draft-body', text: d.body }),
      d.evidence.length ? el('ul', { class: 'draft-evidence' }, d.evidence.map((e) => el('li', { text: e }))) : el('p', { class: 'panel-note', text: 'No evidence was named for this draft.' }),
      el('p', { class: 'panel-note draft-judge', text: `The judge: ${judge}.` }),
      acts,
    )
    return wrap
  }
  return el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title', text: 'It drafted' }),
    el('p', { class: 'panel-note', text: 'Written from the evidence shown under each one. Send opens your own mail client; nothing is sent for you.' }),
    ...open.map(card),
    closed.length ? el('h3', { class: 'col-title', text: 'This week' }) : null,
    ...closed.map((d) => el('div', { class: 'row' }, [el('span', { class: 'row-name', text: d.subject }), el('span', { class: 'row-value', text: d.status })])),
  ])
}

export function assistantProposalsSection(data) {
  const all = Array.isArray(data?.proposals) ? data.proposals : []
  const resolved = Array.isArray(data?.resolved) ? data.resolved : []
  if (all.length === 0 && resolved.length === 0) return null
  const proposals = all.slice(0, MAX_PROPOSALS_ON_TODAY)

  const section = el('section', { class: 'panel' })
  const card = (pr) => {
    const wrap = el('article', { class: 'proposal', 'data-kind': pr.kind ?? 'proposal' })
    const acts = el('div', { class: 'proposal-chips' })
    const verdict = async (choice) => {
      for (const button of acts.querySelectorAll('button')) button.disabled = true
      try {
        await fetch('/gnomon/assistant/verdict', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ proposalId: pr.id, verdict: choice }),
        })
        acts.replaceChildren(el('span', { class: 'panel-note', text: choice === 'accepted' ? 'Accepted.' : 'Rejected.' }))
      } catch {
        acts.replaceChildren(el('span', { class: 'panel-note', text: 'That verdict could not be recorded.' }))
      }
    }

    if (pr.outcome === 'open') {
      acts.append(
        el('button', { type: 'button', class: 'act act-small', text: 'Accept', onclick: () => verdict('accepted') }),
        el('button', { type: 'button', class: 'act act-small', text: 'Reject', onclick: () => verdict('rejected') }),
      )
    } else {
      // Today's route sends open proposals only, so this branch draws a card
      // the owner just answered without a refetch.
      acts.append(el('span', { class: 'panel-note', text: pr.outcome === 'accepted' ? 'Accepted.' : 'Rejected.' }))
    }

    wrap.append(el('div', { class: 'proposal-label', text: pr.summary ?? '' }), acts)
    return wrap
  }

  // `.filter(Boolean)` because `replaceChildren` is not `el`: `el` drops a null
  // child, `replaceChildren` coerces it and appends the literal text "null",
  // which is what the remainder line below did on its first outing. The
  // instruments dispatch filters for the same reason.
  section.replaceChildren(
    ...[
      el('h2', { class: 'panel-title', text: 'It suggested' }),
      el('p', { class: 'panel-note', text: 'Your yes or no is what teaches it. A no is as useful as a yes.' }),
      ...proposals.map(card),
      all.length > proposals.length ? el('p', { class: 'panel-note', text: `${all.length - proposals.length} more waiting.` }) : null,
      // What was decided this week: without it an accepted proposal left the
      // card blank, as if nothing had ever been suggested.
      resolved.length ? el('h3', { class: 'col-title', text: 'Decided this week' }) : null,
      ...resolved.map((pr) => el('div', { class: 'row' }, [el('span', { class: 'row-name', text: pr.summary ?? '' }), el('span', { class: 'row-value', text: statusWord(pr.outcome) })])),
    ].filter(Boolean),
  )
  return section
}
