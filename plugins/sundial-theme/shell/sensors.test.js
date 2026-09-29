import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SENSORS, SPEECH, sensorRoster, switchedOn } from './sensors.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SENSOR_SRC = join(HERE, '../../../packages/sensors/src')
const STATE_SIGNATURE = readFileSync(join(HERE, '../../../packages/kernel/src/state-signature.ts'), 'utf8')

describe('the sensor manifest', () => {
  it('covers every sensor package in the codebase', () => {
    // The whole point of a hand-written manifest: a sensor added to
    // `packages/sensors/src` and not to this file would vanish from the card
    // silently, which is the failure a TRUST surface can least afford. It
    // earned its keep on the first run — `browser`, which reads the host and
    // path of the tab in front, had no row, because the almanac page the table
    // was transcribed from says twenty sensors and the codebase has
    // twenty-two.
    const folders = readdirSync(SENSOR_SRC, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    // One package may hold two rows: `mail` reads Mail and Messages behind two switches.
    const claimed = [...new Set(SENSORS.map((sensor) => sensor.package).filter(Boolean))].sort()
    expect(claimed, 'every sensor package owes the Trust card a row').toEqual(folders)
  })

  it('marks as a state sensor everything the kernel deduplicates', () => {
    // The distinction the whole card rests on. A sensor on `STATE_SCOPES`
    // polls but emits only when its value changes, with the dedupe held in
    // durable state so it survives a restart — so its silence looks exactly
    // like a dead poller and is not one. Calling one of these an occurrence
    // sensor would put "quiet for 23 hours" under a heading that says nothing
    // happened, when what happened is that nothing CHANGED.
    const deduped = [...STATE_SIGNATURE.matchAll(/^\s*'([a-z-]+:[a-z-]+)':/gm)].map(([, event]) => event)
    expect(deduped.length, 'the allow-list must still be readable from the kernel').toBeGreaterThan(4)
    for (const event of deduped) {
      const owner = SENSORS.find((sensor) => sensor.events.includes(event))
      if (!owner) continue // `git:status` rides with git's occurrence events; see below.
      if (owner.events.length > 1) continue
      expect(owner.speech, `${event} is deduplicated by the kernel, so it speaks when it changes`).toBe('state')
    }
  })

  it('has exactly one heartbeat, and it is the one coverage is measured from', () => {
    // Not a style point. Every coverage figure in Gnomon divides by
    // `input:activity`'s emit rate, and it can only do that because that
    // sensor fires on a fixed window whether or not the owner touched
    // anything. A second heartbeat would mean two different answers to "how
    // long was Gnomon watching"; none would mean there is no answer at all.
    const beats = SENSORS.filter((sensor) => sensor.speech === 'heartbeat')
    expect(beats.map((sensor) => sensor.events)).toEqual([['input:activity']])
  })

  it('gives every sensor a speech kind the card can explain', () => {
    for (const sensor of SENSORS) {
      expect(SPEECH[sensor.speech], `${sensor.name} has no speech kind`).toBeDefined()
      expect(sensor.does.length, `${sensor.name} must say what it captures, in the owner's words`).toBeGreaterThan(10)
      expect(/[A-Z]/.test(sensor.does[0]), `${sensor.name}'s description is a clause, not a sentence`).toBe(false)
    }
  })
})

describe('the roster, joined to the log', () => {
  it('takes a sensor\'s FRESHEST stream, not its quietest', () => {
    // `git` has three event types and a push eight days ago says nothing about
    // `git:status` polling a minute ago. Reading the quietest would have
    // reported the whole sensor as eight days dead.
    const [git] = sensorRoster([
      { stream: 'git:status', quietMin: 4 },
      { stream: 'git:push', quietMin: 11952 },
    ]).filter((sensor) => sensor.name === 'git')
    expect(git.quietMin).toBe(4)
  })

  it('tells a stream never heard from a stream gone quiet', () => {
    // Four of the phone's five streams have never carried anything on the live
    // record, which is the card's own finding about that path — and a
    // different fact from a sensor that stopped.
    const [phone] = sensorRoster([{ stream: 'phone:place', quietMin: 1224 }]).filter((sensor) => sensor.name === 'phone')
    expect(phone.silentEvents).toEqual(['phone:sleep', 'phone:workout', 'phone:motion', 'phone:steps'])
    expect(phone.quietMin).toBe(1224)
    const [presence] = sensorRoster([]).filter((sensor) => sensor.name === 'presence')
    expect(presence.quietMin, 'never heard at all is null, not a big number').toBe(null)
  })

  it('reports an opt-in sensor against the owner\'s own config', () => {
    // A clipboard poller and a screen reader running are exactly the facts a
    // trust surface owes the owner, and nothing on this board said either.
    const on = switchedOn(sensorRoster([], { clipboardEnabled: true, ocr: true }))
    expect(on.map((sensor) => sensor.name).sort()).toEqual(['clipboard', 'screen text'])
    expect(switchedOn(sensorRoster([], {})), 'off by default stays off').toEqual([])
    const [clip] = sensorRoster([{ stream: 'clipboard:activity', quietMin: 5 }], {}).filter((sensor) => sensor.name === 'clipboard')
    expect(clip.on, 'heard from but not configured on is still reported off').toBe(false)
  })
})
