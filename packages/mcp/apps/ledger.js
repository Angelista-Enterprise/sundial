// The ledger app: Gnomon's own model spend as a sortable table, the web client's grid renderer.
//
// Draws `gnomon_llm_ledger`'s structuredContent: `{ groupBy, days, from, to, rows }`. A host that
// offers it gets a Full screen act: a table is the one drawing that wants the room.
import { el, grid } from '../../../plugins/sundial-theme/shell/surfaces.js'
import { act, frame } from './lib.js'

const AXIS = { day: 'Day', purpose: 'Purpose', model: 'Model', errorClass: 'Error' }
const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`
const secs = (ms) => (ms ? `${(ms / 1000).toFixed(1)}s` : '—')

export function columns(groupBy) {
  return [
    { key: 'key', label: AXIS[groupBy] ?? groupBy },
    { key: 'calls', label: 'Calls', type: 'number' },
    { key: 'failed', label: 'Failed', type: 'number' },
    { key: 'tokens', label: 'Tokens', align: 'right' },
    { key: 'cacheReadTokens', label: 'From cache', align: 'right' },
    { key: 'billedOnFailureTokens', label: 'Lost to failures', align: 'right' },
    { key: 'cost', label: 'Cost', align: 'right' },
    { key: 'failedTime', label: 'Time in failures', align: 'right' },
  ]
}

export function draw(data, app) {
  const n = (v) => (Number(v) || 0).toLocaleString('en-US')
  const rows = (Array.isArray(data?.rows) ? data.rows : []).map((r) => ({ ...r, tokens: n(r.tokens), cacheReadTokens: n(r.cacheReadTokens), billedOnFailureTokens: n(r.billedOnFailureTokens), cost: usd(r.costUsd), failedTime: secs(r.failedMs) }))
  const total = rows.reduce((s, r) => s + (Number(r.costUsd) || 0), 0)
  const because = rows.length ? `${data.from} → ${data.to} · ${usd(total)} at list price` : ''
  const body = rows.length
    ? grid({ columns: columns(data.groupBy), rows, note: 'Cost is an estimate at list price, never a bill. Rows before 2026-09-18 carry no cache reads and read high.' })
    : el('div', { class: 'surface-fail', text: 'No model calls in this window.' })
  const node = frame('Ledger', because, body)
  if (app?.getHostContext?.()?.availableDisplayModes?.includes('fullscreen')) {
    node.querySelector('.surface-head').append(act('Full screen', () => app.requestDisplayMode({ mode: 'fullscreen' }).catch(() => null)))
  }
  return node
}
