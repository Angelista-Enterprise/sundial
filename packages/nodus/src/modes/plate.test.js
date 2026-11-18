import { describe, expect, it } from 'vitest'
import { build, checkPlan, cleanSvg, parsePlan, parseSvg, platesProblems } from './plate.js'

const PLAN = `Here it is.
{"title": "Two coils share one ring", "manner": "isometric", "parts": [{"id": "Core", "label": "Iron core", "note": "closed ring", "layer": 0}, {"id": "in", "label": "Primary coil", "note": "1000 turns", "layer": 2}, {"id": "out", "label": "Secondary coil", "note": "50 turns", "layer": 7}], "links": [{"from": "in", "to": "core", "label": "field flips"}, {"from": "core", "to": "nowhere", "label": "x"}], "steps": [{"focus": ["in"], "say": "Current enters the primary."}, {"focus": ["out", "ghost"], "say": "Fewer turns, lower voltage."}]}`
const SVG = `Sure: <svg viewBox="0 0 1200 720"><g id="core"><rect x="300" y="200" width="600" height="320"/></g><g id="in"><path d="M300 250 L300 470"/></g></svg>`

describe('plate', () => {
  it('reads the plan and the drawing out of their replies, and nothing when either is missing', () => {
    expect(parsePlan(PLAN).title).toBe('Two coils share one ring')
    expect(parsePlan('no json here')).toBeNull()
    expect(parseSvg(SVG).startsWith('<svg') && parseSvg(SVG).endsWith('</svg>')).toBe(true)
    expect(parseSvg('{"title": "no drawing"}')).toBeNull()
  })

  it('keeps only plain shapes: no script, handler, style, text, image, link or embedded page survives', () => {
    const s = cleanSvg('<svg><defs><marker><path d="M0 0"/></marker></defs><script>alert(1)</script><style>*{}</style><g id="a" onclick="x()" style="fill:red"><rect x="1" y="2" width="3" height="4" fill="red"/><text>hi</text><image href="http://x"/><a href="javascript:x"><circle cx="1" cy="1" r="1"/></a></g><foreignObject><div onload="x()">x</div></foreignObject></svg>')
    expect(s).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 720"><g id="a"><rect x="1" y="2" width="3" height="4" /><circle cx="1" cy="1" r="1" /></g></svg>')
    // A value that tries to close its tag only breaks itself: what is left is an empty shape, still well formed.
    expect(cleanSvg(`<line x1="1" y1='2' x2="3" y2='4'/>`)).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 720"><line x1="1" y1="2" x2="3" y2="4" /></svg>')
    expect(cleanSvg('<rect x="1&quot;><script>" data-value="3" data-unit="h"/>')).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 720"><rect /></svg>')
    // The two accents ride on a shape or a group; any other tone word is kept as written (the renderer reads only warm and cool).
    expect(cleanSvg('<g id="a" data-tone="warm"><rect x="1" y="1" width="2" height="2" data-tone="cool"/></g>')).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 720"><g id="a" data-tone="warm"><rect x="1" y="1" width="2" height="2" data-tone="cool" /></g></svg>')
    // Groups are balanced whatever the model wrote; shapes always close.
    expect(cleanSvg('</g><g id="a"><path d="M0 0"></path><g><circle r="1">')).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 720"><g id="a"><path d="M0 0" /><g><circle r="1" /></g></g></svg>')
  })

  it('holds the plan to its shape: ids made safe, layers 0 to 3, a manner, links and steps only to real parts', () => {
    const plan = checkPlan(parsePlan(PLAN))
    expect(plan.manner).toBe('isometric')
    expect(plan.parts.map((p) => [p.id, p.layer])).toEqual([['core', 0], ['in', 2], ['out', 3]])
    expect(plan.links).toEqual([{ from: 'in', to: 'core', label: 'field flips' }])
    expect(plan.steps.map((s) => s.focus)).toEqual([['in'], ['out']])
  })

  it('names every planned part the drawing left out, in words the model can act on', () => {
    const problems = platesProblems(checkPlan(parsePlan(PLAN)), cleanSvg(parseSvg(SVG)))
    expect(problems).toEqual(['these parts are in the plan but have no <g id> in the drawing: out'])
  })

  it('plans first, then draws; asks once more with the faults and keeps the better drawing', async () => {
    const fixed = SVG.replace('</svg>', '<g id="out"><path d="M900 250 L900 470"/></g></svg>')
    const asked = []
    const replies = [PLAN, SVG, fixed]
    const product = await build('How does a transformer step voltage down?', { complete: async (messages) => (asked.push(messages), replies.shift()), route: { view: 'free' } })
    expect(asked).toHaveLength(3)
    expect(asked[1].at(-1).content).toMatch(/The plan:/)
    expect(asked[2].at(-1).content).toMatch(/no <g id> in the drawing: out/)
    expect(product).toMatchObject({ kind: 'plate', manner: 'isometric', mannerBy: 'model', facts: false, problems: [] })
    expect(product.parts).toHaveLength(3)
  })

  it('takes the manner from Jev when Jev can say, and tells the plan to keep it', async () => {
    const asked = []
    const replies = [PLAN, SVG.replace('</svg>', '<g id="out"><path d="M900 250 L900 470"/></g></svg>')]
    const judge = async ({ questions }) => ({ manner: { choice: Object.keys(questions.manner.criteria)[0] } })
    const product = await build('What is Plato\'s allegory of the cave?', { complete: async (messages) => (asked.push(messages), replies.shift()), judge, route: { view: 'free' } })
    expect(asked[0].at(-1).content).toMatch(/Draw it in the "scene" manner/)
    expect(product).toMatchObject({ manner: 'scene', mannerBy: 'jev' })
  })
  it('asks for looks when told, keeps them, and draws by them', async () => {
    const { planMessages, drawMessages } = await import('./plate.js')
    expect(planMessages('q', null, null, true)[1].content).toContain('"looks"')
    expect(planMessages('q')[1].content).not.toContain('"looks"')
    const plan = checkPlan({ title: 't', parts: [{ id: 'k', label: 'Key', looks: 'bow, blade, teeth' }, { id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })
    expect(plan.parts[0].looks).toBe('bow, blade, teeth')
    expect(plan.parts[1].looks).toBeUndefined()
    expect(drawMessages('q', plan)[1].content).toContain('exactly its "looks"')
  })
})
