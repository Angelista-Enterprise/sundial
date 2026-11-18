import { describe, expect, it, vi } from 'vitest'
import { bindDay } from './bind.js'
import { checkSpec, names, specOf } from './spec.js'
import { layoutTimeline, textWidth } from './layout.js'
import { fallbackSteps, parseReply, tailor } from './storyboard.js'
import { focusOf } from './focus.js'
import { visualize } from './orchestrate.js'
import { DAY } from './fixture.test-data.js'

const skeleton = () => bindDay(DAY)
const withSteps = (steps) => ({ ...skeleton(), steps })

describe('the spec check', () => {
  it('passes a bound day with the walk from its own numbers', () => {
    const s = skeleton()
    const out = checkSpec({ ...s, steps: fallbackSteps(s) })
    expect(out.problems).toEqual([])
    expect(out.ok).toBe(true)
  })

  it('refuses a step that points at nothing, and says so in words a model can act on', () => {
    const out = checkSpec(withSteps([{ focus: ['p:nowhere'], say: 'Nowhere took the day.' }]))
    expect(out.ok).toBe(false)
    expect(out.problems).toContain('step 1 focuses no known part or lane')
  })

  it('refuses a step that does not name what it lights', () => {
    const out = checkSpec(withSteps([{ focus: ['p:tidewater'], say: 'A quieter stretch came after lunch.' }]))
    expect(out.problems[0]).toMatch(/does not name what it focuses \(say one of: tidewater\)/)
  })

  it('refuses the assistant persona and talk about the picture', () => {
    const out = checkSpec(withSteps([{ focus: ['p:tidewater'], say: 'As your assistant I note tidewater ran late.' }, { focus: ['meetings'], say: 'This chart shows the meetings.' }, { focus: ['p:tidewater'], say: 'The tidewater lane holds two parts.' }]))
    expect(out.problems[0]).toBe('step 1 speaks as an assistant')
    expect(out.problems.slice(1).every((p) => /talks about the picture instead of the day/.test(p))).toBe(true)
    expect(out.problems).toHaveLength(3)
  })

  it('turns an em dash into a comma, clips parts to the window, and drops a part with no lane', () => {
    const s = skeleton()
    s.parts.push({ id: 'x:early', role: 'session', lane: 'elsewhere', from: '2026-03-09T05:00:00.000Z', to: '2026-03-09T07:30:00.000Z', label: 'Early' })
    s.parts.push({ id: 'x:lost', role: 'session', lane: 'p:gone', from: '2026-03-09T09:00:00.000Z', to: '2026-03-09T09:30:00.000Z', label: 'Lost' })
    const { spec } = checkSpec({ ...s, steps: [{ focus: ['meetings'], say: 'Meetings \u2014 two of them.' }] })
    expect(spec.steps[0].say).toBe('Meetings, two of them.')
    expect(spec.parts.find((p) => p.id === 'x:early').from).toBe(spec.window.from)
    expect(spec.parts.some((p) => p.id === 'x:lost')).toBe(false)
  })

  it('reads a card back, and nothing from a card that is not one', () => {
    const s = skeleton()
    expect(specOf(JSON.stringify({ ...s, steps: fallbackSteps(s) })).lanes.length).toBeGreaterThan(0)
    expect(specOf('not json')).toBeNull()
    expect(specOf('{"v":1}')).toBeNull()
  })

  it('hears a part named in the plural or by one word of its label', () => {
    expect(names('Two meetings before noon', 'Meeting')).toBe(true)
    expect(names('Mira joined the planning', 'Planning with Mira Bakker')).toBe(true)
    expect(names('A long stretch', 'Code')).toBe(false)
  })

  it('does not credit a project with the day when most of it sat outside every project', () => {
    const s = bindDay({ ...DAY, noProjectMin: 400 })
    const [first] = fallbackSteps(s)
    expect(first.focus).toEqual(['elsewhere'])
    expect(first.say).toMatch(/most of it with no project behind it; puzzlebox-studio led the projects\.$/)
    expect(checkSpec({ ...s, steps: [first] }).ok).toBe(true)
  })
})

describe('the day binder', () => {
  it('lays a lane per project, busiest first, then outside work, meetings on top and time away last', () => {
    expect(skeleton().lanes.map((l) => l.id)).toEqual(['meetings', 'p:puzzlebox-studio', 'p:tidewater', 'elsewhere', 'away'])
  })

  it('makes every session a bar in its project lane that opens its moment, with the intent as a note only', () => {
    const p = skeleton().parts.find((x) => x.id === 's:01M6AAAAAAAAAAAAAAAAAAAAA1')
    expect(p).toMatchObject({ lane: 'p:puzzlebox-studio', door: 'moment:01M6AAAAAAAAAAAAAAAAAAAAA1', label: 'Code', note: 'Fix the BOX-484 layout bug', to: '2026-03-09T07:57:00.000Z' })
  })

  it('frames the day on whole hours and binds back to the tool it read', () => {
    const s = skeleton()
    expect(s.window).toEqual({ from: '2026-03-09T07:00:00.000Z', to: '2026-03-09T14:00:00.000Z' })
    expect(s.source).toEqual({ view: 'day', args: { date: '2026-03-09' } })
  })

  it('binds nothing from a day with no activity', () => {
    expect(bindDay({ date: '2026-03-10', coverage: {} })).toBeNull()
  })
})

describe('the timeline layout', () => {
  const L = layoutTimeline(checkSpec({ ...skeleton(), steps: fallbackSteps(skeleton()) }).spec)

  it('keeps every bar inside the plot and inside its lane', () => {
    for (const b of L.bars) {
      const lane = L.lanes.find((l) => l.id === b.lane)
      expect(b.x).toBeGreaterThanOrEqual(L.x0 - 0.001)
      expect(b.x + b.w).toBeLessThanOrEqual(L.x1 + 0.001)
      expect(b.y).toBeGreaterThanOrEqual(lane.y)
      expect(b.y + b.h).toBeLessThanOrEqual(lane.y + lane.h)
    }
  })

  it('puts an hour tick on every hour of the window', () => {
    expect(L.ticks.length).toBe(8)
    expect(L.ticks[0].x).toBe(L.x0)
  })

  it('never lets two labels overlap, however crowded the meetings', () => {
    const s = skeleton()
    for (let i = 0; i < 12; i++) s.parts.push({ id: `m:x${i}`, role: 'meeting', lane: 'meetings', from: `2026-03-09T09:${String(i * 4).padStart(2, '0')}:00.000Z`, to: `2026-03-09T09:${String(i * 4 + 3).padStart(2, '0')}:00.000Z`, label: `Sync ${i}` })
    const crowded = layoutTimeline(checkSpec({ ...s, steps: fallbackSteps(s) }).spec)
    const boxes = crowded.labels.map((l) => [l.x, l.x + textWidth(l.text)])
    for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) expect(a[0] < b[1] && a[1] > b[0]).toBe(false)
    expect(crowded.labels.length).toBeGreaterThan(0)
  })
})

describe('the storyboard', () => {
  it('reads the JSON out of a reply wrapped in a fence or a sentence', () => {
    expect(parseReply('Here:\n```json\n{"title":"A day","steps":[{"focus":["meetings"],"say":"Meetings."}]}\n```').steps).toHaveLength(1)
    expect(parseReply('no json here')).toBeNull()
    expect(parseReply('{"steps": "not a list"}')).toBeNull()
  })

  it('keeps the steps Jev lets through, and two at the least', () => {
    const steps = ['a', 'b', 'c', 'd'].map((say) => ({ say, focus: [] }))
    expect(tailor(steps, { s0: { noul: 0.9 }, s1: { noul: 0.1 }, s2: { noul: 0.8 }, s3: { noul: 0.2 } }).map((s) => s.say)).toEqual(['a', 'c'])
    expect(tailor(steps, { s0: { noul: 0.1 }, s1: { noul: 0.3 }, s2: { noul: 0.2 }, s3: { noul: 0.4 } }).map((s) => s.say)).toEqual(['b', 'd'])
    expect(tailor(steps, null)).toBe(steps)
  })

  it('lights a lane and its bars when a step names the lane', () => {
    const s = skeleton()
    const hot = focusOf(s, { focus: [], say: 'tidewater picked up after the break.' })
    expect([...hot].sort()).toEqual(['p:tidewater', 's:01M6AAAAAAAAAAAAAAAAAAAAA3'])
  })
})

describe('the orchestrator', () => {
  const read = vi.fn(async () => DAY)
  const goodWalk = JSON.stringify({ title: 'A builder’s Monday', steps: [{ focus: ['p:puzzlebox-studio'], say: 'puzzlebox-studio held most of your morning.' }, { focus: ['m:1'], say: 'Planning with Mira took the hour before lunch.' }, { focus: ['b:0'], say: 'You stepped away for half an hour after it.' }] })

  it('takes the model’s walk when it holds, and says who wrote it', async () => {
    const out = await visualize({ ask: 'how did my day go' }, { read, complete: async () => goodWalk })
    expect(out.ok).toBe(true)
    expect(out.spec.by.storyboard).toBe('model')
    expect(out.spec.headline).toBe('A builder’s Monday')
    expect(out.spec.steps).toHaveLength(3)
  })

  it('repairs once against the checker’s own words', async () => {
    const complete = vi.fn().mockResolvedValueOnce('{"steps":[{"focus":["nope"],"say":"Something."}]}').mockResolvedValueOnce(goodWalk)
    const out = await visualize({}, { read, complete })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls[1][0].at(-1).content).toMatch(/focuses no known part/)
    expect(out.spec.by.storyboard).toBe('model')
  })

  it('walks from the numbers with no model, a refused budget, or two bad answers', async () => {
    for (const complete of [null, async () => null, async () => 'still not json']) {
      const out = await visualize({}, { read, complete })
      expect(out.spec.by.storyboard).toBe('fallback')
      expect(checkSpec(out.spec).ok).toBe(true)
    }
  })

  it('drops the model’s walk when Jev scores it off the ask, and tailors one it passes', async () => {
    const low = await visualize({}, { read, complete: async () => goodWalk, judge: async () => ({ fits: { score: 0.4 } }) })
    expect(low.spec.by).toMatchObject({ storyboard: 'fallback', critic: { fits: 0.4 } })
    const tailored = await visualize({}, { read, complete: async () => goodWalk, judge: async () => ({ fits: { score: 2.6 }, s0: { noul: 0.9 }, s1: { noul: 0.2 }, s2: { noul: 0.8 } }) })
    expect(tailored.spec.steps.map((s) => s.focus[0])).toEqual(['p:puzzlebox-studio', 'b:0'])
  })

  it('keeps going when the judge fails', async () => {
    const out = await visualize({}, { read, complete: async () => goodWalk, judge: async () => { throw new Error('down') } })
    expect(out.spec.by).toMatchObject({ storyboard: 'model', critic: null })
    expect(Object.keys(out.spec.by.ms).sort()).toEqual(['critic', 'read', 'storyboard', 'total'])
  })

  it('reads every page of the day\'s sessions, not only the first', async () => {
    const pages = vi.fn(async (_tool, args) => (args.offset ? { ...DAY, sessions: DAY.sessions.slice(2) } : { ...DAY, sessions: DAY.sessions.slice(0, 2), nextSessionOffset: 2 }))
    const out = await visualize({}, { read: pages })
    expect(pages.mock.calls.map((c) => c[1].offset ?? 0)).toEqual([0, 2])
    expect(out.spec.parts.filter((p) => p.role === 'session')).toHaveLength(4)
  })

  it('stops paging when the next offset does not move past the last one', async () => {
    const stuck = vi.fn(async (_tool, args) => (args.offset ? { ...DAY, sessions: [], nextSessionOffset: args.offset } : { ...DAY, sessions: DAY.sessions.slice(0, 2), nextSessionOffset: 2 }))
    await visualize({}, { read: stuck })
    expect(stuck.mock.calls.map((c) => c[1].offset ?? 0)).toEqual([0, 2])
    const zero = vi.fn(async () => ({ ...DAY, nextSessionOffset: 0 }))
    await visualize({}, { read: zero })
    expect(zero).toHaveBeenCalledTimes(1)
  })

  it('says so when the day holds nothing', async () => {
    const out = await visualize({ date: '2026-03-10' }, { read: async () => ({ coverage: {} }) })
    expect(out).toEqual({ ok: false, reason: 'The record holds nothing to draw for 2026-03-10.' })
  })
})
