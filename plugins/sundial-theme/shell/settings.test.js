// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { autonomyBlock, healthRows, nextPaper, privacyBlock, servicesBlock } from './settings.js'
import { describe as describeServices } from './services.js'

describe('the paper toggle', () => {
  it('goes Auto → Dark → Light → Auto, so dark is one press from Auto (L7)', () => {
    expect(nextPaper('system')).toBe('dark')
    expect(nextPaper('dark')).toBe('light')
    expect(nextPaper('light')).toBe('system')
    expect(nextPaper(undefined)).toBe('dark')
  })
})

// lane H
const text = (nodes) => {
  // No hole in the list: replaceChildren prints a null as "null".
  expect(nodes.every(Boolean)).toBe(true)
  return nodes.map((n) => n.textContent).join(' | ')
}

describe('healthRows', () => {
  it('says all is well, and when the last push and copy were', () => {
    const now = new Date().toISOString()
    const out = text(healthRows({ troubles: [], push: { configured: true, lastOkAt: now, lastFailedAt: null, lastError: null }, lastBackup: new Date().toLocaleDateString('en-CA'), budgetsOutToday: [] }))
    expect(out).toMatch(/All reporting/)
    expect(out).toMatch(/Reached the phone just now/)
    expect(out).toMatch(/Daily copy of the record.*Last /)
    expect(out).not.toMatch(/Model budget/)
  })

  it('names what stands broken, a failed push and a spent budget', () => {
    const now = new Date().toISOString()
    const out = text(healthRows({ troubles: [{ key: 'input-grant', since: now, observation: 'Input Monitoring is off for Sundial.', said: true }], push: { configured: true, lastOkAt: null, lastFailedAt: now, lastError: 'timeout' }, lastBackup: null, budgetsOutToday: ['companion'] }))
    expect(out).toMatch(/Input Monitoring.*Input Monitoring is off for Sundial\..*Since just now/)
    expect(out).toMatch(/did not reach the phone \(timeout\)/)
    expect(out).toMatch(/None yet/)
    expect(out).toMatch(/Out: companion/)
  })

  it('W6 D6: shows each cross-check with its state, and a blind sensor once', () => {
    const now = new Date().toISOString()
    const observation = 'You typed and clicked for 30 minutes, and the screen reader read nothing.'
    const pairs = [{ id: 'browser', state: 'ok', since: null, observation: null }, { id: 'screen', state: 'blind', since: now, observation }, { id: 'audio', state: 'off', since: null, observation: null }]
    const out = text(healthRows({ troubles: [{ key: 'blind:screen', since: now, observation, said: true }], pairs, push: { configured: false }, lastBackup: null, budgetsOutToday: [] }))
    expect(out).toMatch(/All reporting/)
    expect(out).toMatch(/Browser pages.*Seeing/)
    expect(out).toMatch(/Screen reader.*read nothing\..*Blind since just now/)
    expect(out).toMatch(/Hearing in calls.*Not checked/)
    expect(out.split(observation)).toHaveLength(2)
  })
})

describe('what Gnomon may do alone (W5 step 10)', () => {
  it('asks for verdicts on what waits, warns when a row stopped, and folds the kinds with none', async () => {
    const data = {
      toJudge: [{ key: 'resume:box-484', kind: 'return-from-break', at: new Date().toISOString(), text: 'You were on BOX-484 before the break.' }],
      capabilities: [
        { capability: 'notice:return-from-break', level: 'ask', earned: false, n: 7, rows: 'row 4: 86% worth hearing, n = 7; needs 80% at n ≥ 30', evidence: { line: 'you were at the Mac after 83 of 93', quietDays: 28 } },
        { capability: 'notice:absent:flow', level: 'ask', earned: false, n: 0, rows: 'row 4: not judged yet, n = 0', evidence: { line: 'last verdict never', quietDays: null } },
        { capability: 'notice:absent:break', level: 'ask', earned: false, n: 0, rows: 'row 4: not judged yet, n = 0', evidence: { line: 'last verdict never', quietDays: null } },
      ],
      scorecard: [],
    }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })))
    const node = autonomyBlock()
    await new Promise((r) => setTimeout(r, 0))
    expect(node.textContent).toContain('One thing Gnomon said waits for yours.')
    expect(node.textContent).toMatch(/You were on BOX-484 before the break\.return-from-break, within the hourUsefulNot nowWrong/)
    expect(node.textContent).toContain('Beside the verdicts: you were at the Mac after 83 of 93.')
    expect(node.textContent).toContain('No verdict in 28 days: this row cannot move until one comes.')
    expect(node.querySelector('details summary').textContent).toBe('2 more kinds with no verdict yet, each at Ask')
    expect(node.querySelectorAll('details .set-row')).toHaveLength(2)
  })

  it('shows each capability\'s level and numbers with n, Act pressable only once earned, and the folded rows', async () => {
    const data = {
      capabilities: [
        { capability: 'actions', level: 'ask', earned: false, granted: null, rows: 'row 11: verified 67% (n = 82), did not fail 90.8% (n = 1,085); needs 98% each at n ≥ 30' },
        { capability: 'notice:agent-waiting', level: 'ask', earned: true, granted: null, rows: 'row 4: 90% worth hearing, n = 31; needs 80% at n ≥ 30' },
      ],
      scorecard: [{ id: 4, metric: 'Notices judged worth hearing, per kind', value: '58.3% (n = 12, too small to trust)', target: '≥ 80%', meets: false }],
    }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })))
    const node = autonomyBlock()
    await new Promise((r) => setTimeout(r, 0))
    const rows = [...node.querySelectorAll('.set-row')].map((r) => r.textContent)
    expect(rows[0]).toMatch(/Commands and outward actions.*n = 82.*OffAskAct/)
    expect(rows[0]).toContain('a warning only: what you ask for runs as your Ask/Auto chip says')
    expect(rows[1]).toMatch(/Interrupt: agent-waiting.*n = 31/)
    expect(rows[1]).not.toContain('warning')
    const act = [...node.querySelectorAll('[role=radiogroup]')].map((g) => g.querySelector('button:last-child').disabled)
    expect(act).toEqual([true, false])
    expect(rows[2]).toMatch(/4\. Notices judged worth hearing.*n = 12, too small to trust.*Below target/)
    vi.unstubAllGlobals()
  })
})

describe('private apps and sites', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const view = (over = {}) => ({
    apps: { builtIn: ['whatsapp', 'mail'], yours: [], hidden: [], suggested: [{ name: 'Puzzlebox Bank', bundleId: 'com.example.bank', says: 'Looks like banking or money. You used it this month.' }] },
    hosts: { builtIn: ['outlook.office.com'], yours: [{ name: 'bank.example' }], suggested: [] },
    ...over,
  })

  it('draws the empty list, the suggestions with their bundle id, and the built-ins folded; no "null" anywhere', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => view() })))
    const node = privacyBlock()
    await tick()
    const text = node.textContent
    expect(text).toContain('No apps of your own yet.')
    expect(text).toContain('Suggested: apps that look private and are on no list yet.')
    expect(node.querySelector('.set-row[data-suggested] .set-id').textContent).toBe('com.example.bank')
    expect(node.querySelector('[aria-label="Remove bank.example"]')).not.toBe(null)
    expect([...node.querySelectorAll('details summary')].map((s) => s.textContent)).toEqual(['Built in, always private: 2 apps', 'Built in, always private: 1 site'])
    expect(text).not.toContain('null')
    vi.unstubAllGlobals()
  })

  it('adds a suggestion through the edit route, and says a refusal beside the field it is about, keeping what was typed', async () => {
    const calls = []
    const answers = [
      { ok: true, json: async () => view() },
      { ok: true, json: async () => ({ ...view({ apps: { builtIn: ['whatsapp', 'mail'], yours: [{ name: 'Puzzlebox Bank', bundleId: 'com.example.bank' }], hidden: [], suggested: [] } }), saved: 'Puzzlebox Bank' }) },
      { ok: false, status: 400, json: async () => ({ unavailable: 'Already private: the built-in “whatsapp” covers it.' }) },
    ]
    vi.stubGlobal('fetch', vi.fn(async (url, init) => (calls.push([url, init?.body ? JSON.parse(init.body) : null]), answers.shift())))
    const node = privacyBlock()
    await tick()
    node.querySelector('[aria-label="Add Puzzlebox Bank"]').click()
    await tick()
    expect(calls[1]).toEqual(['/gnomon/api/privacy/edit', { op: 'add', kind: 'app', value: 'Puzzlebox Bank' }])
    expect(node.querySelector('[role="status"]').textContent).toBe('Added Puzzlebox Bank. Live now.')
    expect(node.querySelector('[aria-label="Remove Puzzlebox Bank"]')).not.toBe(null)
    const input = node.querySelector('input[data-kind="app"]')
    input.value = 'WhatsApp'
    input.nextSibling.click()
    await tick()
    expect(node.querySelector('[role="alert"]').textContent).toBe('Already private: the built-in “whatsapp” covers it.')
    expect(node.querySelector('input[data-kind="app"]').value).toBe('WhatsApp')
    vi.unstubAllGlobals()
  })

  it('says when the lists cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    const node = privacyBlock()
    await tick()
    expect(node.querySelector('[role="alert"]').textContent).toBe('The private lists could not be read. Sundial may be restarting.')
    vi.unstubAllGlobals()
  })
})

describe('what may leave this Mac', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const open = async (config, pending = []) => {
    const services = describeServices(config, pending, [])
    const waiting = services.filter((r) => r.changed).map((r) => r.label)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ services, restartNeeded: waiting.length > 0, waiting, bootedAt: 'x' }) })))
    const node = servicesBlock()
    await tick()
    vi.unstubAllGlobals()
    const row = (label) => [...node.querySelectorAll('.set-row')].find((r) => r.querySelector('.set-label')?.textContent === label)
    return { node, row, checked: (label) => [...row(label).querySelectorAll('[aria-checked="true"]')].map((b) => b.textContent) }
  }

  it('draws the group with each switch on, and says which apply at once and which after a restart', async () => {
    const { node, row, checked } = await open({})
    expect([...node.querySelectorAll('h4.set-title')].map((h) => h.textContent).at(-1)).toBe('What may leave this Mac')
    for (const label of ['Search model download', 'GitHub pull requests', 'Atlas libraries']) expect(checked(label), label).toEqual(['On'])
    expect(row('Search model download').textContent).toContain('Applies at once.')
    expect(row('Atlas libraries').textContent).toContain('Applies at once.')
    expect(row('GitHub pull requests').textContent).toContain('Applies after a restart.')
    expect(node.textContent).not.toContain('Not answered')
  })

  it('an open question shows Not answered with neither choice picked; a PR change waits for the restart with its button', async () => {
    const { node, row, checked } = await open({ memory: { embeddings: 'ask' }, sensors: { githubPrs: false } }, ['sensors.githubPrs'])
    expect(checked('Search model download')).toEqual([])
    expect(row('Search model download').textContent).toContain('Not answered')
    expect(row('Search model download').textContent).toContain('Nothing downloads until you choose.')
    expect(checked('GitHub pull requests')).toEqual(['Off'])
    expect(row('GitHub pull requests').textContent).toContain('Waits for the restart.')
    expect(node.querySelector('.set-wait').textContent).toContain('One change waits for a restart: GitHub pull requests.')
    expect([...node.querySelectorAll('.set-wait button')].map((b) => b.textContent)).toEqual(['Restart Sundial'])
  })
})
