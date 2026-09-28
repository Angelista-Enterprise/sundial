// The banner seam: what node writes for the launcher to post, and what it does
// with a button press coming back. Real filesystem against a tmp home — the
// whole point of this module is the file protocol, and a mocked fs would test
// the mock.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeNotifier, watchNoticeVerdicts } from './native-notify.js'

let home
let runtimeDir

const payload = (overrides = {}) => ({
  kind: 'absent',
  observation: 'No break since 13:20.',
  noticeKey: 'absent:break',
  ...overrides,
})

const drop = (name, body) => writeFileSync(join(runtimeDir, name), typeof body === 'string' ? body : JSON.stringify(body), 'utf8')

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gnomon-notify-'))
  runtimeDir = join(home, '.daemon')
  mkdirSync(runtimeDir, { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('createNativeNotifier', () => {
  it('writes the request the launcher polls for', () => {
    const notifier = createNativeNotifier({ home, enabled: true, log: () => {}, warn: () => {} })
    expect(notifier.post(payload())).toEqual({ posted: true })

    const request = JSON.parse(readFileSync(join(runtimeDir, 'notice-request.json'), 'utf8'))
    expect(request.noticeKey).toBe('absent:break')
    expect(request.observation).toBe('No break since 13:20.')
    expect(request.kind).toBe('absent')
  })

  it('writes nothing at all when the owner has not enabled banners', () => {
    const notifier = createNativeNotifier({ home, enabled: false, log: () => {}, warn: () => {} })
    expect(notifier.post(payload())).toEqual({ posted: false, reason: 'disabled' })
    expect(existsSync(join(runtimeDir, 'notice-request.json'))).toBe(false)
  })

  it('refuses a notice with no key — a banner nobody can rate trains nothing', () => {
    const notifier = createNativeNotifier({ home, enabled: true, log: () => {}, warn: () => {} })
    expect(notifier.post({ observation: 'something' })).toEqual({ posted: false, reason: 'no-notice-key' })
    expect(existsSync(join(runtimeDir, 'notice-request.json'))).toBe(false)
  })

  it('leaves no .tmp behind — a half-written request would be parsed as corrupt and lost', () => {
    const notifier = createNativeNotifier({ home, enabled: true, log: () => {}, warn: () => {} })
    notifier.post(payload())
    expect(readdirSync(runtimeDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('watchNoticeVerdicts', () => {
  it('sweeps a verdict that landed while the plugin was not watching', () => {
    drop('notice-verdict-abc.json', { noticeKey: 'absent:break', verdict: 'not-now' })
    const seen = []
    const close = watchNoticeVerdicts(home, (v) => seen.push(v), { warn: () => {} })

    expect(seen).toEqual([{ noticeKey: 'absent:break', verdict: 'not-now' }])
    close()
  })

  it('deletes the drop before folding it, so a throwing handler cannot replay it forever', () => {
    drop('notice-verdict-abc.json', { noticeKey: 'absent:break', verdict: 'useful' })
    const close = watchNoticeVerdicts(
      home,
      () => {
        throw new Error('kernel is down')
      },
      { warn: () => {} },
    )

    expect(() => close()).not.toThrow()
    expect(existsSync(join(runtimeDir, 'notice-verdict-abc.json'))).toBe(false)
  })

  it('ignores a verdict that is not one of the three the gate understands', () => {
    drop('notice-verdict-abc.json', { noticeKey: 'absent:break', verdict: 'maybe' })
    const onVerdict = vi.fn()
    const close = watchNoticeVerdicts(home, onVerdict, { warn: () => {} })

    expect(onVerdict).not.toHaveBeenCalled()
    close()
  })

  it('discards a corrupt drop instead of retrying it', () => {
    drop('notice-verdict-abc.json', 'not json at all')
    const onVerdict = vi.fn()
    const close = watchNoticeVerdicts(home, onVerdict, { warn: () => {} })

    expect(onVerdict).not.toHaveBeenCalled()
    expect(existsSync(join(runtimeDir, 'notice-verdict-abc.json'))).toBe(false)
    close()
  })

  it('leaves files that are not verdict drops alone', () => {
    drop('window-info.json', { app: 'Ghostty' })
    const onVerdict = vi.fn()
    const close = watchNoticeVerdicts(home, onVerdict, { warn: () => {} })

    expect(onVerdict).not.toHaveBeenCalled()
    expect(existsSync(join(runtimeDir, 'window-info.json'))).toBe(true)
    close()
  })
})
