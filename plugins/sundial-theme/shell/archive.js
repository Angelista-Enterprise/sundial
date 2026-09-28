// Archived sessions — a Gnomon-owned list, because dsh has no such notion.
//
// dsh's persistence can create, append, load and list a session. It cannot
// archive one and it cannot delete one; the session log is designed to be the
// durable record, and "hide this from me" is a UI fact, not a log fact. So the
// archive is a set of ids in a small JSON file beside the other runtime state,
// read at request time and written whole. The sessions themselves are untouched:
// archiving costs nothing and restoring is exact.
//
// Deletion is the other operation, and it is NOT here — it removes the backend's
// artefact and lives in server.js beside the agent handles it has to dispose
// first. This file knows only which ids the owner does not want to see.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function archivePath(home) {
  return `${home}/.daemon/archived-sessions.json`
}

/** The archived ids. A missing or unreadable file is an empty archive, never an error. */
export function readArchive(home) {
  try {
    const raw = JSON.parse(readFileSync(archivePath(home), 'utf8'))
    return new Set(Array.isArray(raw?.sessionIds) ? raw.sessionIds.filter((id) => typeof id === 'string' && id !== '') : [])
  } catch {
    return new Set()
  }
}

function writeArchive(home, ids) {
  const path = archivePath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ sessionIds: [...ids].sort(), updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Archive or restore a set of ids. Idempotent: archiving an archived id or
 * restoring a live one is a no-op, which is what makes a stale tab's second
 * click harmless.
 *
 * @returns the archive after the change.
 */
export function setArchived(home, ids, archived) {
  const set = readArchive(home)
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') continue
    if (archived) set.add(id)
    else set.delete(id)
  }
  writeArchive(home, set)
  return set
}

/** Forget ids entirely — for sessions that no longer exist. */
export function forget(home, ids) {
  return setArchived(home, ids, false)
}
