import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { readTitles, titlesPath, writeTitles } from './session-titles.js'

/**
 * This file is a cache and nothing may depend on it. Every way it can be
 * wrong — absent, truncated, hand-edited, the wrong shape — has to read as an
 * empty cache, because the alternative is a thread list that throws on boot
 * over a file that only exists to save a second.
 */

let home
beforeEach(() => {
  home = mkdtempSync(`${tmpdir()}/gnomon-titles-`)
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const put = (text) => {
  mkdirSync(dirname(titlesPath(home)), { recursive: true })
  writeFileSync(titlesPath(home), text)
}

describe('session titles cache', () => {
  it('round-trips, and keeps the empty string as a real answer', () => {
    // '' means "this file names nothing" — the answer worth remembering, since
    // it is the fruitless reads that cost the second.
    writeTitles(home, new Map([['session-a', 'Lab tab build plan'], ['session-b', '']]))
    const back = readTitles(home)
    expect(back.get('session-a')).toBe('Lab tab build plan')
    expect(back.get('session-b')).toBe('')
    expect(back.has('session-b')).toBe(true)
  })

  it('writes the file private to the owner', () => {
    writeTitles(home, new Map([['session-a', 'x']]))
    expect(readFileSync(titlesPath(home), 'utf8')).toContain('"session-a": "x"')
  })

  it('reads a missing file as an empty cache', () => {
    expect(readTitles(home).size).toBe(0)
  })

  it.each([
    ['truncated json', '{"titles": {"a": "b"'],
    ['not an object', '[]'],
    ['titles is null', '{"titles": null}'],
    ['no titles key', '{"updatedAt": "2026-09-13T00:00:00.000Z"}'],
  ])('reads %s as an empty cache', (_name, text) => {
    put(text)
    expect(readTitles(home).size).toBe(0)
  })

  it('drops entries that are not id → string', () => {
    put(JSON.stringify({ titles: { good: 'Name', bad: 42, worse: null, '': 'no id' } }))
    expect([...readTitles(home)]).toEqual([['good', 'Name']])
  })
})
