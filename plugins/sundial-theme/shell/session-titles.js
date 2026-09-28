// What each closed session is called, remembered across restarts.
//
// Naming the thread list costs one read of every session whose title dsh's own
// projection cache cannot answer — ~190 files here, ~1.5 seconds, and the
// comment in server.js explains the sting: almost none of those files yields a
// name, so it is the FRUITLESS reads that cost the second. An in-process memory
// took that to nothing after the first call, but the first call is the one the
// owner sees, once per login, on the surface that opens at login.
//
// So the answers live in a small JSON file beside the archive, in the same
// shape and for the same reason: a UI fact about sessions, not a fact in any
// log. It is a cache and nothing depends on it — a missing, unreadable or
// stale-looking file is an empty cache, never an error.
//
// SAFETY. A cached name is only ever used for a session that is NOT live in the
// listing that asks. A live session is still being written, so its log can gain
// the words that would name it; `forgetTitles` drops an id the moment this
// server takes a turn on it, and the listing drops every live id it sees. dsh's
// own hint, when it has one, still wins over anything here.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function titlesPath(home) {
  return `${home}/.daemon/session-titles.json`
}

/** id → title (the empty string is a real answer: "this file names nothing"). */
export function readTitles(home) {
  try {
    const raw = JSON.parse(readFileSync(titlesPath(home), 'utf8'))
    const titles = raw?.titles
    if (titles === null || typeof titles !== 'object') return new Map()
    return new Map(Object.entries(titles).filter(([id, title]) => typeof id === 'string' && id !== '' && typeof title === 'string'))
  } catch {
    return new Map()
  }
}

/**
 * Write the whole map.
 *
 * Whole-file, like the archive: a few hundred short strings is smaller than any
 * scheme for appending to it would be, and a half-written cache that has to be
 * repaired is worse than one that is simply rewritten.
 */
export function writeTitles(home, titles) {
  const path = titlesPath(home)
  mkdirSync(dirname(path), { recursive: true })
  const sorted = Object.fromEntries([...titles].sort(([a], [b]) => (a < b ? -1 : 1)))
  writeFileSync(path, `${JSON.stringify({ titles: sorted, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
}
