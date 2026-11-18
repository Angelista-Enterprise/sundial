// Plan 15 step 5: About you. What Gnomon believes about the owner, each line with its source, and two acts: Fix and Wrong.
import { el } from './surfaces.js'
import { keepCurrent } from './read.js'
import { json, stagger } from './view-kit.js'

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, via: 'belief-page' }) }).then((r) => r.ok).catch(() => false)

/** One belief: what it says, where it comes from, and the two acts. Fix turns the line into a field; Enter saves, Esc puts it back. */
export function beliefRow(b, owner) {
  const settle = (row, word) => row.replaceWith(el('div', { class: 'row belief belief-settled' }, [el('span', { class: 'row-name', text: `${b.says}: ${b.object}` }), el('span', { class: 'verdict-done', text: word })]))
  const fix = () => {
    const field = el('input', { class: 'belief-field', type: 'text', value: b.object, maxlength: '200', 'aria-label': `What is true about ${b.says}` })
    const editing = el('div', { class: 'row belief' }, [el('span', { class: 'row-sub', text: `${b.says}:` }), field])
    field.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') return editing.replaceWith(row)
      if (e.key !== 'Enter') return
      const object = field.value.trim()
      if (object === '' || object === b.object) return editing.replaceWith(row)
      field.disabled = true
      const ok = await post('/gnomon/api/assert', { entityKind: 'owner', canonicalName: owner, predicate: b.predicate, object })
      ok ? editing.replaceWith(el('div', { class: 'row belief belief-settled' }, [el('span', { class: 'row-name', text: `${b.says}: ${object}` }), el('span', { class: 'verdict-done', text: 'fixed' })])) : (field.disabled = false)
    })
    row.replaceWith(editing)
    field.focus()
    field.select()
  }
  const wrong = async (button) => {
    button.disabled = true
    if (await post('/gnomon/api/feedback', { artifactKind: 'entity_fact', artifactId: b.id, verdict: 'wrong' })) settle(row, 'marked wrong')
    else button.disabled = false
  }
  const wrongAct = el('button', { type: 'button', class: 'act act-small', text: 'Wrong', title: 'Gnomon stops believing this', onclick: (e) => wrong(e.currentTarget) })
  const row = el('div', { class: 'row belief' }, [
    el('span', { class: 'row-name belief-text' }, [el('span', { class: 'row-sub', text: `${b.says}: ` }), el('span', { text: b.object })]),
    el('span', { class: 'belief-acts' }, [
      owner ? el('button', { type: 'button', class: 'act act-small', text: 'Fix', title: 'Say what is true instead', onclick: fix }) : null,
      wrongAct,
    ]),
    el('span', { class: 'belief-source' }, [b.momentId ? el('span', { class: 'door', 'data-explore': `moment:${b.momentId}`, tabindex: '0', role: 'link', text: b.source }) : el('span', { text: b.source })]),
  ])
  return row
}

export function beliefsNode(d) {
  const count = d?.groups?.reduce((n, g) => n + g.beliefs.length, 0) ?? 0
  if (count === 0) return el('section', { class: 'view-body beliefs' }, [el('div', { class: 'none', text: 'Gnomon holds no beliefs about you yet. Tell it something in the chat, and it shows here.' })])
  const lead = `${count} ${count === 1 ? 'belief' : 'beliefs'} about you.${d.corrections > 0 ? ` You corrected ${d.corrections} this week.` : ''}`
  return el('section', { class: 'view-body beliefs' }, [
    el('p', { class: 'panel-lead', text: lead }),
    ...d.groups.map((g) =>
      el('div', { class: 'col' }, [
        el('div', { class: 'col-head' }, [el('h3', { class: 'col-title', text: g.label }), el('span', { class: 'col-hint', text: String(g.beliefs.length) })]),
        stagger(el('div', {}, g.beliefs.map((b) => beliefRow(b, d.owner)))),
      ]),
    ),
  ])
}

export async function beliefsCard() {
  const build = async () => beliefsNode(await json('/gnomon/beliefs').catch(() => null))
  return keepCurrent(await build(), build, ['/gnomon/beliefs'])
}
