// The shelf: what Gnomon made on its own, waiting for the owner's verdict.
import { el } from './surfaces.js'
import { postVerdict } from './verdicts.js'
import { renderMarkdown } from './markdown.js'
import { stagger, when } from './view-kit.js'
import { jobWords } from './view-today.js'
import { askWhy } from './view-people.js'

export function shelfSection(shelf, onAsk) {
  const items = Array.isArray(shelf?.items) ? shelf.items : []
  const working = shelf?.working ?? null
  if (items.length === 0 && working === null) return null
  const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  const WORDS = { useful: 'kept', 'not-now': 'later', wrong: 'removed' }
  const card = (item) => {
    const answered = item.verdict !== null && item.verdict !== undefined
    const wrap = el('article', { class: `shelf-card${item.verdict === 'useful' ? ' shelf-card-kept' : ''}${answered && item.verdict !== 'useful' ? ' shelf-card-dim' : ''}` })
    const acts = el('span', { class: 'verdicts' })
    const body = el('div', { class: 'shelf-body' })
    body.append(renderMarkdown(jobWords(item.body ?? '')))
    const fold = el('div', { class: 'shelf-fold' }, [el('div', { class: 'shelf-fold-inner' }, [body, acts])])

    const setOpen = (open) => {
      wrap.setAttribute('data-open', String(open))
      title.setAttribute('aria-expanded', String(open))
    }
    const settle = (text) => {
      acts.replaceChildren(el('span', { class: 'verdict-done', text }))
      mark.textContent = text
      mark.hidden = false
    }
    const title = el('button', { type: 'button', class: 'shelf-title', title: 'Show or hide', text: item.title, onclick: () => setOpen(wrap.getAttribute('data-open') !== 'true') })
    const mark = el('span', { class: 'shelf-mark', hidden: !answered, text: answered ? WORDS[item.verdict] ?? item.verdict : '' })

    if (answered) settle(WORDS[item.verdict] ?? item.verdict)
    for (const [verdict, label] of answered ? [] : [
      ['useful', 'Keep'],
      ['not-now', 'Not now'],
      ['wrong', 'Wrong'],
    ]) {
      acts.append(
        el('button', {
          type: 'button',
          class: 'act act-small',
          text: label,
          onclick: async () => {
            for (const b of acts.querySelectorAll('button')) b.disabled = true
            // "Wrong" alone says no; the note says why, and the next job reads
            // it as a standing instruction. Asked for here, once, rather than
            // left to a place the owner would have to go and find.
            const note = verdict === 'wrong' ? await askWhy(acts) : undefined
            const ok = await postVerdict('knowledge_entry', item.id, verdict, note)
            settle(ok ? WORDS[verdict] : 'not recorded')
            if (!ok) return
            if (verdict === 'useful') wrap.classList.add('shelf-card-kept')
            else wrap.classList.add('shelf-card-dim')
            // Answered: fold to the title, a beat after the word lands so the
            // owner sees what they did before it goes.
            setTimeout(() => setOpen(false), 420)
          },
        }),
      )
    }
    wrap.append(
      el('div', { class: 'shelf-head' }, [
        el('span', { class: 'shelf-chev', 'aria-hidden': 'true' }),
        title,
        mark,
        el('span', { class: 'shelf-when', text: when(item.createdAt) }),
      ]),
      fold,
    )
    setOpen(!answered)
    return wrap
  }
  const open = items.filter((i) => i.verdict === null || i.verdict === undefined).length
  return el('section', { class: 'shelf' }, [
    el('div', { class: 'col-head' }, [
      el('h3', { class: 'col-title', text: 'Left for you' }),
      el('span', { class: 'col-hint', text: open > 0 ? `${open} waiting · ${items.length - open} answered` : `${items.length} answered` }),
    ]),
    working ? el('div', { class: 'shelf-working', text: `Working on it: ${working.subject} — ${working.reason}` }) : null,
    stagger(el('div', { class: 'shelf-cards' }, items.map(card))),
  ])
}
