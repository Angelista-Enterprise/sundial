import { describe as group, expect, it } from 'vitest'
import { SERVICES, allowed, describe, setPath, textValue, valueOf } from './services.js'

const svc = (id) => SERVICES.find((s) => s.id === id)

group('services', () => {
  it('reads code defaults for unset keys, and a text key as set or unset', () => {
    expect(valueOf(svc('ocr'), {})).toBe(false)
    expect(valueOf(svc('refutation'), {})).toBe(true)
    expect(valueOf(svc('outward'), {})).toBe('off')
    expect(valueOf(svc('push'), { notifications: { ntfy: 'https://ntfy.sh/x' } })).toBe('set')
    expect(valueOf(svc('push'), { notifications: { ntfy: '' } })).toBe('unset')
  })

  it('writes one nested key and keeps everything else', () => {
    const before = { ocr: { retentionDays: 14 }, other: 1 }
    const after = setPath(before, 'ocr.vision.enabled', true)
    expect(after).toEqual({ ocr: { retentionDays: 14, vision: { enabled: true } }, other: 1 })
    expect(before).toEqual({ ocr: { retentionDays: 14 }, other: 1 })
  })

  it('allows only the switch values a service declares; never a text key or a service without one', () => {
    expect(allowed(svc('outward'), 'auto')).toBe(true)
    expect(allowed(svc('outward'), 'yes')).toBe(false)
    expect(allowed(svc('ocr'), 'true')).toBe(false)
    expect(allowed(svc('push'), 'https://evil')).toBe(false)
    expect(allowed(svc('phone'), true)).toBe(false)
    expect(allowed(undefined, true)).toBe(false)
  })

  it('describes each row: value, changed since boot, and the newest of its signals', () => {
    const rows = describe({ ocr: { enabled: true }, privacy: { mail: true } }, { ocr: { enabled: false }, privacy: { mail: true } }, [
      { signalType: 'mail', eventType: 'received', lastCapturedAt: '2026-09-20T10:00:00Z' },
      { signalType: 'message', eventType: 'received', lastCapturedAt: '2026-09-26T10:00:00Z' },
    ])
    const by = Object.fromEntries(rows.filter((r) => !r.sep).map((r) => [r.id, r]))
    expect(by.ocr).toMatchObject({ value: true, changed: true })
    expect(by.mail).toMatchObject({ value: true, changed: false, lastSignal: '2026-09-20T10:00:00Z' })
    // Messages is its own switch, off unless asked for, whatever Mail says.
    expect(by.messages).toMatchObject({ value: false, lastSignal: '2026-09-26T10:00:00Z' })
    expect(by.phone.choices).toBeNull()
  })

  it('draws a refinement only while the service it refines is on', () => {
    const ids = (config) => describe(config, config, []).filter((r) => !r.sep).map((r) => r.id)
    expect(ids({})).not.toContain('jobsPerNight')
    expect(ids({ jobs: { enabled: true } })).toEqual(expect.arrayContaining(['jobsPerNight', 'usdPerNight']))
    expect(ids({})).not.toContain('pushAtMac')
    expect(ids({ notifications: { ntfy: 'https://ntfy.sh/x' } })).toContain('pushAtMac')
  })

  it('reads a Claude hook from what is installed, applies it live, and gives the night-shift caps their code defaults', () => {
    const rows = describe({ jobs: { enabled: true } }, {}, [], { hooks: true, context: false })
    const by = Object.fromEntries(rows.filter((r) => !r.sep).map((r) => [r.id, r]))
    expect(by.claudeHooks).toMatchObject({ value: true, live: true, changed: false })
    expect(by.claudeContext).toMatchObject({ value: false, live: true })
    expect(allowed(svc('claudeContext'), true)).toBe(true)
    expect(by.jobsPerNight.value).toBe(2)
    expect(by.usdPerNight.value).toBe(5)
    expect(by.nightShift.changed).toBe(true)
    expect(valueOf(svc('pushAtMac'), {})).toBe(true)
  })
})

group('typed values', () => {
  it('takes an http(s) push address and a full folder path, clears on empty, refuses the rest', () => {
    expect(textValue(svc('push'), ' https://ntfy.sh/long-topic ')).toBe('https://ntfy.sh/long-topic')
    expect(textValue(svc('push'), 'ntfy.sh/x')).toBeNull()
    expect(textValue(svc('vault'), '~/Documents/Notes/')).toBe('~/Documents/Notes')
    expect(textValue(svc('vault'), 'Notes')).toBeNull()
    expect(textValue(svc('vault'), '')).toBe('')
    expect(textValue(svc('ocr'), 'x')).toBeNull()
  })
})
