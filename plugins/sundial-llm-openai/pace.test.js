import { describe, it, expect } from 'vitest'
import { judgedOf, PACE, paceSwitch } from './pace.js'

const MIN = 60_000
const NOW = Date.parse('2026-11-16T06:40:00.000Z')
/** `n` calls ending at `end`, one every `gap`, each `pin` tokens in at `pace` ms per 1k. */
const calls = (n, pace, end, gap = 20_000, pin = 25_000) => Array.from({ length: n }, (_, i) => ({ at: end - (n - 1 - i) * gap, ms: (pace * pin) / 1000, pin }))
/** A usual day at 34 ms/k an hour ago, then `recent` calls at `pace` up to now. */
const day = (pace, recent = PACE.recent) => [...calls(30, 34, NOW - 60 * MIN), ...calls(recent, pace, NOW)]

describe('paceSwitch', () => {
  it('stays on the route at its usual pace, and at under twice it', () => {
    expect(paceSwitch({ rows: day(34), last: null, now: NOW })).toMatchObject({ use: 'primary', change: null, baseline: 34 })
    expect(paceSwitch({ rows: day(66), last: null, now: NOW }).use).toBe('primary')
  })

  it('switches to the backup when the last calls run at over twice the usual pace (runs 208 to 210: 34 to 69 ms/k)', () => {
    expect(paceSwitch({ rows: day(69), last: null, now: NOW })).toEqual({ use: 'backup', change: 'slow', ratio: expect.closeTo(2.03, 2), recent: 69, baseline: 34 })
  })

  it('judges a fresh prompt against fresh ones and a cached one against cached ones (the first call of a task is fresh)', () => {
    const kind = (rows, cached) => rows.map((r) => ({ ...r, cached: cached ? r.pin : 0 }))
    const base = [...kind(calls(30, 32, NOW - 70 * MIN), true), ...kind(calls(10, 69, NOW - 60 * MIN), false)]
    // Fresh calls at 100 ms/k are 1.45 times the usual fresh pace: not slow, though three times the cached one.
    expect(paceSwitch({ rows: [...base, ...kind(calls(PACE.recent, 100, NOW), false)], last: null, now: NOW })).toMatchObject({ use: 'primary', ratio: expect.closeTo(1.45, 2) })
    expect(paceSwitch({ rows: [...base, ...kind(calls(PACE.recent, 69, NOW), true)], last: null, now: NOW })).toMatchObject({ use: 'backup', change: 'slow' })
  })

  it('stays on a slow route whose backup is slower still, and goes to one that is quicker or has no record yet', () => {
    const theirs = (pace) => calls(PACE.backupCalls, pace, NOW - 24 * 60 * MIN)
    expect(paceSwitch({ rows: day(69), last: null, now: NOW, backup: theirs(72) }).use).toBe('primary')
    expect(paceSwitch({ rows: day(69), last: null, now: NOW, backup: theirs(41) }).change).toBe('slow')
    expect(paceSwitch({ rows: day(69), last: null, now: NOW, backup: theirs(72).slice(0, PACE.baseMin - 1) }).change).toBe('slow')
  })

  it('after coming back, judges only the calls since: the slow tries from before cannot switch it again', () => {
    const recovered = NOW - 6 * MIN
    const rows = [...calls(30, 34, NOW - 60 * MIN), ...calls(5, 69, recovered - MIN), ...calls(3, 34, NOW)]
    expect(paceSwitch({ rows, last: { at: recovered, reason: 'recovered' }, now: NOW })).toEqual({ use: 'primary', change: null })
    // Eight slow calls since it came back are judged as ever.
    expect(paceSwitch({ rows: [...rows, ...calls(PACE.recent, 69, NOW + MIN)], last: { at: recovered, reason: 'recovered' }, now: NOW + MIN }).change).toBe('slow')
  })

  it('the switch row carries the pace it was judged on, and null, never 0, for one it has not', () => {
    expect(judgedOf({ recent: 68.6, baseline: 33.8 }, 'main')).toEqual({ primary: 'main', pace: 69, baseline: 34 })
    expect(judgedOf({ recent: null }, 'main')).toEqual({ primary: 'main', pace: null, baseline: null })
  })

  it('judges nothing on too few calls, stale calls or no usual pace', () => {
    expect(paceSwitch({ rows: day(69, PACE.recent - 1), last: null, now: NOW }).use).toBe('primary')
    expect(paceSwitch({ rows: day(69), last: null, now: NOW + 20 * MIN }).use).toBe('primary')
    expect(paceSwitch({ rows: calls(PACE.recent + 5, 69, NOW), last: null, now: NOW }).use).toBe('primary')
  })

  it('never switches twice inside the hold, whichever way the last switch went', () => {
    expect(paceSwitch({ rows: day(69), last: { at: NOW - 2 * MIN, reason: 'recovered' }, now: NOW }).use).toBe('primary')
    expect(paceSwitch({ rows: day(69), last: { at: NOW - PACE.holdMs, reason: 'recovered' }, now: NOW }).change).toBe('slow')
  })

  it('on the backup, tries the route itself once in a while, and comes back when the tries are quick again and the hold is over', () => {
    const at = NOW - 3 * MIN
    const before = day(69).map((r) => ({ ...r, at: r.at - 3 * MIN }))
    // Just switched: the backup. Two minutes with no call on the route: one probe.
    expect(paceSwitch({ rows: before, last: { at, reason: 'slow' }, now: at + MIN }).use).toBe('backup')
    expect(paceSwitch({ rows: before, last: { at, reason: 'slow' }, now: at + PACE.probeMs }).use).toBe('probe')
    // Two quick tries, but inside the hold: still the backup. After it: back, with a recovered row.
    const tried = [...before, { at: at + 2 * MIN, ms: 900, pin: 25_000 }, { at: at + 4 * MIN, ms: 850, pin: 25_000 }]
    expect(paceSwitch({ rows: tried, last: { at, reason: 'slow' }, now: at + 4.5 * MIN }).use).toBe('backup')
    expect(paceSwitch({ rows: tried, last: { at, reason: 'slow' }, now: at + 5 * MIN })).toMatchObject({ use: 'primary', change: 'recovered', baseline: 34 })
    // Tries still slow: the backup stays, probing again two minutes after the last try.
    const slowTries = [...before, { at: at + 2 * MIN, ms: 1800, pin: 25_000 }, { at: at + 4 * MIN, ms: 1700, pin: 25_000 }]
    expect(paceSwitch({ rows: slowTries, last: { at, reason: 'slow' }, now: at + 5 * MIN }).use).toBe('backup')
    expect(paceSwitch({ rows: slowTries, last: { at, reason: 'slow' }, now: at + 6 * MIN }).use).toBe('probe')
    // Only the last tries count: two slow ones long ago do not hold it on the backup once three quick ones came.
    const later = [...slowTries, ...[6, 8, 10].map((m) => ({ at: at + m * MIN, ms: 860, pin: 25_000 }))]
    expect(paceSwitch({ rows: later, last: { at, reason: 'slow' }, now: at + 11 * MIN }).change).toBe('recovered')
  })

  it('doc 31: probes that stay at about twice the usual pace still come back after backupMaxMs, and say why', () => {
    const at = NOW - 3 * MIN
    const before = day(69).map((r) => ({ ...r, at: r.at - 3 * MIN }))
    // Run 256: probes every two to four minutes at 2.1 times the usual pace, never under recoverX.
    const probes = [...before, ...[2, 4, 6, 8].map((m) => ({ at: at + m * MIN, ms: 1800, pin: 25_000 }))]
    expect(paceSwitch({ rows: probes, last: { at, reason: 'slow' }, now: at + PACE.backupMaxMs - 1 }).use).toBe('backup')
    expect(paceSwitch({ rows: probes, last: { at, reason: 'slow' }, now: at + PACE.backupMaxMs })).toMatchObject({ use: 'primary', change: 'recovered', why: 'window', ratio: expect.closeTo(2.1, 1) })
    // Back on the route, the slow probes from before the window do not switch it again: eight new calls must.
    const back = at + PACE.backupMaxMs
    expect(paceSwitch({ rows: probes, last: { at: back, reason: 'recovered' }, now: back + 6 * MIN }).use).toBe('primary')
    expect(PACE.backupMaxMs).toBeGreaterThan(PACE.holdMs)
  })
})
