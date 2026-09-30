import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { blankSignInLinks, ownToken } from './signin-log.js'

const LINK = (t) => `dsh web: http://127.0.0.1:3080/?token=${t}\n`
const logWith = (text) => {
  const file = join(mkdtempSync(join(tmpdir(), 'signin-log-')), 'sundial.log')
  writeFileSync(file, text)
  return file
}

describe('blankSignInLinks', () => {
  it('blanks the old runs\' links, keeps this run\'s, and keeps the file the same length', () => {
    const before = `boot\n${LINK('old1')}stop\n${LINK('old-2_x')}boot\n${LINK('now9')}`
    const file = logWith(before)
    expect(blankSignInLinks(file, 'now9')).toBe(2)
    const after = readFileSync(file, 'utf8')
    expect(after.length).toBe(before.length)
    expect(after.match(/\?token=[A-Za-z0-9_-]+/g)).toEqual(['?token=now9'])
  })

  it('at shutdown blanks every link, its own too', () => {
    const file = logWith(LINK('a') + LINK('b'))
    expect(blankSignInLinks(file)).toBe(2)
    expect(readFileSync(file, 'utf8')).not.toContain('?token=')
  })

  it('does nothing without a log', () => {
    expect(blankSignInLinks(join(tmpdir(), 'no-such-dir-signin', 'sundial.log'))).toBe(0)
  })
})

describe('ownToken', () => {
  it('reads the token from dsh\'s own link, and is null when dsh cannot say', () => {
    expect(ownToken({ authenticatedUrl: () => 'http://127.0.0.1:3080/?token=abc_1' })).toBe('abc_1')
    expect(ownToken({})).toBeNull()
  })
})
