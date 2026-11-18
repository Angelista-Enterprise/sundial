// @vitest-environment jsdom
// The setup page's search model question: shown only while config.json says "ask", Enter is yes, and the answer is the Settings switch's write.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'setup.html'), 'utf8')
const tick = () => new Promise((r) => setTimeout(r, 0))

async function open(value, post = { ok: true }) {
  document.body.innerHTML = page.slice(page.indexOf('<body'), page.lastIndexOf('</body>')).replace(/<script[^]*?<\/script>/g, '')
  const posts = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (init?.method === 'POST') return posts.push([url, JSON.parse(init.body)]), { ...post, json: async () => ({}) }
    if (url === '/gnomon/api/services') return { ok: true, json: async () => ({ services: [{ id: 'embeddings', value }] }) }
    return { ok: false, json: async () => ({}) }
  }))
  vi.resetModules()
  await import('./setup.js')
  await tick()
  return { posts, $: (id) => document.getElementById(id) }
}

describe('the search model question on /setup', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('stays hidden once answered, either way', async () => {
    for (const value of [true, false]) expect((await open(value)).$('search-ask').hidden).toBe(true)
  })

  it('asks while the answer is open, the yes focused so Enter is yes, and saves the answer', async () => {
    const { posts, $ } = await open('ask')
    expect($('search-ask').hidden).toBe(false)
    expect(document.activeElement).toBe($('search-yes'))
    $('search-yes').click()
    await tick()
    expect(posts).toEqual([['/gnomon/api/services', { id: 'embeddings', value: true }]])
    expect($('search-acts').hidden).toBe(true)
    expect($('search-said').textContent).toMatch(/^Saved. The search model downloads/)
  })

  it('a no is words only, and a failed save keeps the buttons for another try', async () => {
    const { posts, $ } = await open('ask', { ok: false })
    $('search-no').click()
    await tick()
    expect(posts).toEqual([['/gnomon/api/services', { id: 'embeddings', value: false }]])
    expect($('search-acts').hidden).toBe(false)
    expect($('search-said').textContent).toBe('Sundial did not answer. Try again in a moment.')
  })
})
