// The ask page: the question Gnomon is waiting on, answered with one tap, or in the owner's words.
//
// Draws `gnomon_open_ask`'s structuredContent: `{ open: { askId, question, reason, choices, waiting, ts } | null }`.
// An answer calls the granted `gnomon_owner_answer` through the host (which may ask first); Sundial
// records it as the same fact a tap on its own seat records.
import { el } from '../../../plugins/sundial-theme/shell/surfaces.js'
import { act, frame } from './lib.js'

export function draw(data, app) {
  const open = data?.open ?? null
  if (open === null) return frame('Gnomon asks', '', el('div', { class: 'surface-fail', text: data?.answered ? `Answered: ${data.answered.answer}` : 'Nothing is waiting on you right now.' }))
  const body = el('div', { class: 'app-ask' })
  const question = el('p', { class: 'app-question', text: open.question })
  body.append(question)
  if (open.reason) body.append(el('p', { class: 'app-why', text: open.reason }))
  const done = (answer) => {
    body.querySelectorAll('.app-acts, .app-free').forEach((n) => n.remove())
    body.append(el('p', { class: 'app-why', text: `You said "${answer}" · Sundial records it within seconds` }))
  }
  const send = async (answer, button) => {
    if (!answer) return
    const acts = [...body.querySelectorAll('button')]
    acts.forEach((b) => (b.disabled = true))
    try {
      const result = await app.callServerTool({ name: 'gnomon_owner_answer', arguments: { askId: open.askId, answer } })
      if (result?.isError) throw new Error('refused')
      done(answer)
    } catch {
      acts.forEach((b) => (b.disabled = false))
      if (button) button.textContent = `${answer} · try again`
    }
  }
  if (Array.isArray(open.choices) && open.choices.length) {
    body.append(el('div', { class: 'app-acts' }, open.choices.map((choice) => {
      const button = act(choice, () => send(choice, button))
      return button
    })))
  }
  const input = el('input', { class: 'app-input', type: 'text', placeholder: open.choices?.length ? 'Or in your own words' : 'Your answer', maxlength: 2000, 'aria-label': 'Your answer' })
  const sendAct = act('Send', () => send(input.value.trim(), null))
  input.addEventListener('keydown', (e) => e.key === 'Enter' && send(input.value.trim(), null))
  body.append(el('div', { class: 'app-free' }, [input, sendAct]))
  if (data?.answered) done(data.answered.answer)
  return frame('Gnomon asks', open.waiting ? 'waiting' : '', body)
}
