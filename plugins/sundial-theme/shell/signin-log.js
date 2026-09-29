// The Mac app signs its window in with the LAST `?token=` link in
// logs/sundial.log (`signInURL` in apps/macos/Sundial.swift), and it appends to
// that log across restarts. So until this process prints its own link, the last
// one is the previous run's: a window opened then loads a dead link, shows a
// white page, and never tries again. Blanking the old links (`?token=` becomes
// `?token!`, one byte in place, so the app's write offset is untouched) makes
// the app find none; it says "Sundial is starting" and tries again next time.
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs'

const NEEDLE = Buffer.from('?token=')
const TOKEN_BYTE = /[A-Za-z0-9_-]/

/** Blank every sign-in link in `file` except `keep`'s. Returns how many were blanked. */
export function blankSignInLinks(file, keep = null) {
  let buf
  try {
    buf = readFileSync(file)
  } catch {
    return 0
  }
  let fd = null
  let blanked = 0
  try {
    for (let at = buf.indexOf(NEEDLE); at !== -1; at = buf.indexOf(NEEDLE, at + NEEDLE.length)) {
      const start = at + NEEDLE.length
      let end = start
      while (end < buf.length && TOKEN_BYTE.test(String.fromCharCode(buf[end]))) end++
      if (keep !== null && buf.toString('latin1', start, end) === keep) continue
      fd ??= openSync(file, 'r+')
      writeSync(fd, '!', start - 1)
      blanked++
    }
  } finally {
    if (fd !== null) closeSync(fd)
  }
  return blanked
}

/** The launch token in this process's own sign-in link, or null when dsh does not say. */
export function ownToken(connection) {
  try {
    return new URL(connection.authenticatedUrl('http://127.0.0.1/')).searchParams.get('token') || null
  } catch {
    return null
  }
}
