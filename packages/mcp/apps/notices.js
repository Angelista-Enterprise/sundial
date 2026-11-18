// The notices app: what Gnomon already decided to say, newest first, with Seen on each one not yet seen.
//
// Draws `gnomon_notices`' structuredContent: `{ since, total, notices, nextSince? }`. Seen calls the
// server's own `gnomon_notice_seen` (one of the three granted writes) through the host: the host may
// ask the owner first, as it would for any tool call from a page, and the write lands as a request
// file the running Sundial applies, the same path the web client's own Seen takes.
import { el, newestFirst } from '../../../plugins/sundial-theme/shell/surfaces.js'
import { act, frame } from './lib.js'

const CHANNEL = { claude: 'woke an agent', banner: 'banner', phone: 'phone', chat: 'context' }
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** `Mon 5 · 09:02`, in the viewer's own clock: a notice is an instant, not an owner-local day. */
const when = (iso) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${DAY_NAMES[d.getDay()]} ${d.getDate()} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function row(notice, app) {
  const node = el('div', { class: 'app-row app-notice', 'data-seen': notice.seen ? 'yes' : 'no' }, [
    el('span', { class: 'app-name', text: notice.text || '(no text kept)' }),
    el('span', { class: 'app-state', text: [when(notice.at), notice.kind, CHANNEL[notice.channel] ?? notice.channel].filter(Boolean).join(' · ') }),
  ])
  if (notice.seen) node.append(el('span', { class: 'app-why', text: 'seen' }))
  else {
    const seen = act('Seen', async () => {
      seen.disabled = true
      try {
        const result = await app.callServerTool({ name: 'gnomon_notice_seen', arguments: { id: notice.id, surface: 'mcp-app' } })
        if (result?.isError) throw new Error('refused')
        node.dataset.seen = 'yes'
        seen.replaceWith(el('span', { class: 'app-why', text: 'seen · Sundial applies it within seconds' }))
      } catch {
        seen.disabled = false
        seen.textContent = 'Seen · try again'
      }
    })
    node.append(el('span', { class: 'app-why' }, seen))
  }
  return node
}

export function draw(data, app) {
  const notices = newestFirst(Array.isArray(data?.notices) ? data.notices : [])
  const unseen = notices.filter((n) => !n.seen).length
  if (notices.length === 0) return frame('Notices', '', el('div', { class: 'surface-fail', text: 'Nothing delivered in this window.' }))
  return frame('Notices', `${notices.length} delivered · ${unseen} unseen${data.nextSince ? ' · more after these' : ''}`, el('div', { class: 'app-rows' }, notices.map((n) => row(n, app))))
}
