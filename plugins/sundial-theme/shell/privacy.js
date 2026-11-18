// Private apps and private web hosts: what the Settings card shows, what it
// suggests, and what a save may write. Gnomon never looks at or acts in a
// private app, and never keeps a private host's page text.
//
// The owner's own entries live in config.json, `privacy.sensitiveApps` and
// `privacy.privateHosts`, added to the built-in lists (which can never be
// removed). An app is private when its name or bundle id holds an entry; a
// host when it is the entry or one of its subdomains: the same matching the
// redaction policy does. Names only, never anything from inside an app.
//
// Pure: no I/O, so the route and the test read the same thing.
import { getPath, setPath } from './services.js'

export const APP_PATH = 'privacy.sensitiveApps'
export const HOST_PATH = 'privacy.privateHosts'
const MAX_ENTRIES = 200
const MAX_SUGGESTED = 8

/** Words that make an app or a host look private, by what it would hold. */
const KINDS = [
  ['mail', ['mail', 'outlook', 'spark', 'airmail', 'mimestream', 'thunderbird', 'superhuman']],
  ['chat', ['messages', 'messenger', 'whatsapp', 'telegram', 'signal', 'wechat', 'viber', 'threema']],
  ['money', ['bank', 'wallet', 'paypal', 'revolut', 'bunq', 'finance', 'moneymoney', 'ynab', 'coinbase', 'crypto', 'insur', 'verzeker', 'belasting']],
  ['health', ['health', 'medic', 'doctor', 'clinic', 'therap', 'mychart', 'patient', 'zorg', 'huisarts', 'apotheek', 'pharmac']],
  ['passwords', ['password', 'keychain', 'authenticator', 'authy', '1password', 'bitwarden', 'lastpass', 'dashlane', 'keepass']],
  ['notes', ['notes', 'journal', 'diary', 'day one', 'bear']],
]
const SAYS = { mail: 'Looks like mail.', chat: 'Looks like a chat.', money: 'Looks like banking or money.', health: 'Looks like health.', passwords: 'Looks like passwords.', notes: 'Looks like private notes.' }

/**
 * Web mail and chat most people use, offered until they are on a list. A host the owner's own record holds stays
 * out of this list (the pre-commit PII gate refuses it); it is offered as a host they opened instead.
 */
const COMMON_HOSTS = [
  ['outlook.office.com', 'mail'],
  ['mail.yahoo.com', 'mail'],
  ['app.fastmail.com', 'mail'],
  ['mail.proton.me', 'mail'],
  ['web.whatsapp.com', 'chat'],
  ['messenger.com', 'chat'],
  ['web.telegram.org', 'chat'],
]

const kindOf = (...texts) => KINDS.find(([, words]) => texts.some((t) => t && words.some((w) => t.toLowerCase().includes(w))))?.[0] ?? null
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [])

/** The bundle id in a window id (`com.example.App:12`), or null when the sidecar gave only the name. */
export function bundleOf(app) {
  const id = typeof app?.windowId === 'string' ? app.windowId.slice(0, app.windowId.lastIndexOf(':')) : ''
  const fallback = String(app?.name ?? '').toLowerCase().replace(/\s+/g, '.')
  return id !== fallback && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(id) ? id : null
}

/** A typed app name, cleaned, or null: two to 80 characters, one line. */
export function cleanApp(value) {
  if (typeof value !== 'string') return null
  const v = value.trim().replace(/\s+/g, ' ')
  return v.length >= 2 && v.length <= 80 && !/[\u0000-\u001f[\]<>]/.test(v) ? v : null
}

/** A typed web address as its host (`https://www.bank.example/login` → `bank.example`), or null. */
export function cleanHost(value) {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '')
  return v.length <= 253 && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : null
}

const lists = (config, builtIn) => ({
  app: { builtIn: builtIn.apps, yours: strings(getPath(config, APP_PATH)), hidden: strings(getPath(config, 'privacy.hiddenApps')) },
  host: { builtIn: builtIn.hosts, yours: strings(getPath(config, HOST_PATH)), hidden: [] },
})

/** The entry that already makes it private, and whose it is, or null. */
function coverOf(kind, l, ...names) {
  const hit = (k) => (kind === 'host' ? names.some((h) => h === k || h.endsWith(`.${k}`)) : names.some((n) => n && n.toLowerCase().includes(k)))
  for (const whose of ['builtIn', 'yours', 'hidden']) {
    const entry = l[whose].find((k) => hit(k.toLowerCase()))
    if (entry) return { entry, whose }
  }
  return null
}

/**
 * What the card draws. `builtIn`: `{apps, hosts}`, the lists in code.
 * `seen`: `{apps: [{name, windowId}], hosts: [string]}`, newest first.
 */
export function privacyView(config, builtIn, seen = { apps: [], hosts: [] }) {
  const l = lists(config, builtIn)
  const seenApps = (seen.apps ?? []).map((a) => ({ name: a.name, bundleId: bundleOf(a) }))
  const idOf = new Map(seenApps.map((a) => [a.name.toLowerCase(), a.bundleId]))
  const apps = seenApps
    .map((a) => ({ ...a, kind: kindOf(a.name, a.bundleId) }))
    .filter((a) => a.kind && !coverOf('app', l.app, a.name, a.bundleId))
    .slice(0, MAX_SUGGESTED)
    .map(({ name, bundleId, kind }) => ({ name, bundleId, says: `${SAYS[kind]} You used it this month.` }))
  const opened = (seen.hosts ?? []).map((h) => cleanHost(h)).filter(Boolean)
  const hosts = [...new Set(opened)]
    .map((name) => ({ name, kind: kindOf(name), seen: true }))
    .concat(COMMON_HOSTS.map(([name, kind]) => ({ name, kind, seen: opened.includes(name) })))
    .filter((h, i, all) => h.kind && all.findIndex((x) => x.name === h.name) === i && !coverOf('host', l.host, h.name))
    .slice(0, MAX_SUGGESTED)
    .map(({ name, kind, seen }) => ({ name, says: `${SAYS[kind]} ${seen ? 'You opened it this month.' : 'Common.'}` }))
  return {
    apps: { builtIn: l.app.builtIn, yours: l.app.yours.map((name) => ({ name, bundleId: idOf.get(name.toLowerCase()) ?? null })), hidden: l.app.hidden, suggested: apps },
    hosts: { builtIn: l.host.builtIn, yours: l.host.yours.map((name) => ({ name })), suggested: hosts },
  }
}

/**
 * One owner edit, `{op: 'add' | 'remove', kind: 'app' | 'host', value}`, as the
 * config to write (`{next, path}`), or `{error}` saying what is wrong.
 */
export function editPrivacy(config, builtIn, body) {
  const kind = body?.kind
  if (kind !== 'app' && kind !== 'host') return { error: 'Say app or host.' }
  if (body.op !== 'add' && body.op !== 'remove') return { error: 'Say add or remove.' }
  const value = kind === 'app' ? cleanApp(body.value) : cleanHost(body.value)
  if (value === null) return { error: kind === 'app' ? 'Give the app’s name as the menu bar shows it, 2 to 80 characters.' : 'Give a web address, like mail.example.com.' }
  const l = lists(config, builtIn)[kind]
  const path = kind === 'app' ? APP_PATH : HOST_PATH
  if (body.op === 'remove') {
    const at = l.yours.findIndex((k) => k.toLowerCase() === value.toLowerCase())
    if (at === -1) return { error: l.builtIn.some((k) => k.toLowerCase() === value.toLowerCase()) ? 'Built in: it always stays private.' : 'That is not on your list.' }
    return { next: setPath(config, path, l.yours.filter((_, i) => i !== at)), path, value }
  }
  const cover = coverOf(kind, l, value)
  if (cover) return { error: `Already private: ${cover.whose === 'builtIn' ? 'the built-in' : 'your'} “${cover.entry}” covers it.` }
  if (l.yours.length >= MAX_ENTRIES) return { error: `Your list is full at ${MAX_ENTRIES}. Remove one first.` }
  return { next: setPath(config, path, [...l.yours, value]), path, value }
}
