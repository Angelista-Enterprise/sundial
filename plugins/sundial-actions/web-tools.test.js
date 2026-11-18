// web_page and web_act: what the model reads, what lands on the board, and the audit row of every step.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const browser = vi.hoisted(() => ({
  actOnPage: vi.fn(),
  closePage: vi.fn(),
  loginWindow: vi.fn(),
  openPage: vi.fn(),
  openPages: vi.fn(() => ['p1']),
  readPage: vi.fn(),
  scrollPage: vi.fn(),
}))
vi.mock('../sundial-web-browser/page-session.js', () => browser)

const { webElement, webTools } = await import('./web-tools.js')
/** The dash the module's own lines carry. */
const D = '\u2014'

const reading = (extra = {}) => ({
  page: 'p1',
  title: 'Puzzlebox orders',
  url: 'https://puzzlebox.example/orders',
  text: '<<page>> 3 open orders <</page>>',
  elements: [
    { ref: 1, role: 'button', name: 'Refresh' },
    { ref: 2, role: 'textbox', name: 'Search', value: 'BOX-484' },
    { ref: 3, role: 'checkbox', name: 'Gift wrap', checked: false },
    { ref: 4, role: 'combobox', name: 'Size', options: ['S', 'M'] },
    { ref: 5, role: 'textbox', name: 'Password', secret: true },
    { ref: 6, role: 'button', name: 'Pay', disabled: true },
  ],
  ...extra,
})

function build() {
  const signals = []
  const appendSignal = vi.fn(async (type, payload) => void signals.push({ type, ...payload }))
  const [page, act] = webTools(appendSignal)
  return { page, act, signals }
}

beforeEach(() => {
  for (const f of Object.values(browser)) f.mockReset()
  browser.openPages.mockReturnValue(['p1'])
})

describe('web_page', () => {
  it('opens a page, puts it on the board, audits it, and renders the text and numbered elements', async () => {
    browser.openPage.mockResolvedValue(reading())
    const { page, signals } = build()
    const value = await page.execute({ action: 'open', url: 'https://puzzlebox.example/orders' })
    expect(browser.openPage).toHaveBeenCalledWith('https://puzzlebox.example/orders')
    expect(signals).toEqual([
      { type: 'board:place', id: 'browser:p1', kind: 'browser', text: `Opened ${D} Puzzlebox orders`, by: 'gnomon' },
      { type: 'board:focus', ids: ['browser:p1'], text: 'Opened', by: 'gnomon' },
      { type: 'web:page', action: 'open', page: 'p1', url: 'https://puzzlebox.example/orders', title: 'Puzzlebox orders' },
    ])
    const [{ text }] = page.output.render({}, value)
    expect(text.split('\n')).toEqual([
      `Page p1: Puzzlebox orders ${D} https://puzzlebox.example/orders`,
      '<<page>> 3 open orders <</page>>',
      'Elements (act on one by its number with web_act):',
      '  [1] button "Refresh"',
      '  [2] textbox "Search" = "BOX-484"',
      '  [3] checkbox "Gift wrap" (unchecked)',
      '  [4] combobox "Size" options: S | M',
      `  [5] textbox "Password" (password/card ${D} the owner types this)`,
      '  [6] button "Pay" (disabled)',
    ])
    // The gate reads a ref as the model saw it.
    expect(webElement('p1', 2)).toMatchObject({ name: 'Search' })
  })

  it('shows 80 elements and says how many more a scroll reaches', async () => {
    const elements = Array.from({ length: 85 }, (_, i) => ({ ref: i + 1, role: 'link', name: `Order ${i + 1}` }))
    browser.readPage.mockResolvedValue(reading({ elements }))
    const { page } = build()
    const [{ text }] = page.output.render({}, await page.execute({ action: 'read', page: 'p1' }))
    expect(text).toContain('[80] link "Order 80"')
    expect(text).not.toContain('[81]')
    expect(text).toContain('… 5 more; scroll to reach them')
  })

  it('scrolls down unless told up, and a close takes the card off the board and forgets the reading', async () => {
    browser.openPage.mockResolvedValue(reading())
    browser.scrollPage.mockResolvedValue(reading())
    browser.closePage.mockResolvedValue({ page: 'p1', closed: true })
    const { page, signals } = build()
    await page.execute({ action: 'open', url: 'https://puzzlebox.example/orders' })
    await page.execute({ action: 'scroll', page: 'p1' })
    await page.execute({ action: 'scroll', page: 'p1', direction: 'up' })
    expect(browser.scrollPage.mock.calls).toEqual([['p1', 'down'], ['p1', 'up']])
    await page.execute({ action: 'close', page: 'p1' })
    expect(signals).toContainEqual({ type: 'board:remove', id: 'browser:p1', by: 'gnomon' })
    expect(webElement('p1', 2)).toBeNull()
  })

  it('opens a login in its live card for the owner to type in', async () => {
    browser.loginWindow.mockResolvedValue({ page: 'p2', title: 'Sign in', url: 'https://puzzlebox.example/login' })
    const { page, signals } = build()
    await page.execute({ action: 'login', url: 'https://puzzlebox.example/login' })
    expect(signals[0]).toMatchObject({ type: 'board:place', id: 'browser:p2', text: `Log in here ${D} click the page and type ${D} Sign in` })
  })

  it('refuses a missing url before touching the browser', async () => {
    const { page, signals } = build()
    expect(await page.execute({ action: 'open' })).toEqual({ error: 'open needs a url' })
    expect(await page.execute({ action: 'login' })).toEqual({ error: 'login needs the site url' })
    expect(browser.openPage).not.toHaveBeenCalled()
    expect(signals).toEqual([])
  })

  it('a browser failure comes back as an error with the open pages, and is audited', async () => {
    browser.readPage.mockRejectedValue(new Error('no page p9'))
    const { page, signals } = build()
    const value = await page.execute({ action: 'read', page: 'p9' })
    expect(value).toEqual({ error: 'no page p9', openPages: ['p1'] })
    expect(page.output.render({}, value)).toEqual([{ type: 'text', text: 'Not done: no page p9' }])
    expect(signals).toEqual([{ type: 'web:page', action: 'read', page: 'p9', url: null, error: 'no page p9' }])
  })
})

describe('web_act', () => {
  it('acts by ref, shows the owner the because line, and audits the step', async () => {
    browser.actOnPage.mockResolvedValue(reading({ title: 'Puzzlebox orders (filtered)' }))
    const { act, signals } = build()
    await act.execute({ page: 'p1', action: 'type', ref: 2, text: 'BOX-485', submit: true, because: 'Search for order BOX-485' })
    expect(browser.actOnPage).toHaveBeenCalledWith('p1', { action: 'type', ref: 2, text: 'BOX-485', submit: true, value: undefined })
    expect(signals).toEqual([
      { type: 'board:place', id: 'browser:p1', kind: 'browser', text: `Search for order BOX-485 ${D} Puzzlebox orders (filtered)`, by: 'gnomon' },
      { type: 'board:focus', ids: ['browser:p1'], text: 'Search for order BOX-485', by: 'gnomon' },
      { type: 'web:page', action: 'act:type', page: 'p1', ref: 2, because: 'Search for order BOX-485', url: 'https://puzzlebox.example/orders' },
    ])
  })

  it('a blank because falls back to the action and ref; a refusal is an error, audited', async () => {
    browser.actOnPage.mockRejectedValue(new Error('that field is a password: the owner types it'))
    const { act, signals } = build()
    expect(await act.execute({ page: 'p1', action: 'type', ref: 5, text: 'x', because: '  ' })).toEqual({ error: 'that field is a password: the owner types it', openPages: ['p1'] })
    expect(signals).toEqual([{ type: 'web:page', action: 'act:type', page: 'p1', ref: 5, because: 'type [5]', error: 'that field is a password: the owner types it' }])
  })
})
