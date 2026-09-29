// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// jsdom has no IntersectionObserver. This one says every node is on screen the
// moment it is observed, which is the case the board cares about: a card in view.
class SeenAtOnce {
  constructor(callback) {
    this.callback = callback
  }
  observe(node) {
    this.callback([{ target: node, isIntersecting: true }])
  }
}

const load = async () => {
  vi.resetModules()
  vi.stubGlobal('IntersectionObserver', SeenAtOnce)
  return await import('./read.js')
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

/** A card whose drawing is whatever `text` says when it is built. */
const card = () => {
  const said = { text: 'one', builds: 0 }
  const build = async () => {
    said.builds++
    const section = document.createElement('section')
    section.innerHTML = `<p>${said.text}</p><input>`
    return section
  }
  return { said, build }
}

describe('keepCurrent (L2)', () => {
  it('draws a card again in place when the record moves under it, at most once per window', async () => {
    const { keepCurrent, markStale } = await load()
    const { said, build } = card()
    const node = keepCurrent(await build(), build, ['/gnomon/goals', '/gnomon/habits'], { every: 30_000 })
    document.body.append(node)
    expect(said.builds).toBe(1)

    // A frame right after the build waits for the window, then draws once.
    said.text = 'two'
    markStale(['moments'])
    markStale(['state'])
    expect(said.builds).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(said.builds).toBe(2)
    expect(node.querySelector('p').textContent).toBe('two')
    // The same node: the pane still holds it.
    expect(document.body.firstChild).toBe(node)

    // A table none of its routes is made of does nothing.
    await vi.advanceTimersByTimeAsync(60_000)
    markStale(['llm_audit'])
    await vi.advanceTimersByTimeAsync(1)
    expect(said.builds).toBe(2)
  })

  it('does not swap in an identical drawing, and never redraws under the owner\'s typing', async () => {
    const { keepCurrent, markStale } = await load()
    const { said, build } = card()
    const node = keepCurrent(await build(), build, '/gnomon/habits', { every: 10 })
    document.body.append(node)
    const p = node.querySelector('p')
    await vi.advanceTimersByTimeAsync(20)
    markStale(['state'])
    await vi.advanceTimersByTimeAsync(1)
    expect(said.builds).toBe(2)
    expect(node.querySelector('p')).toBe(p)

    node.querySelector('input').focus()
    said.text = 'two'
    await vi.advanceTimersByTimeAsync(20)
    markStale(['state'])
    await vi.advanceTimersByTimeAsync(1)
    expect(node.querySelector('p').textContent).toBe('one')
  })

  it('draws at once when the question changed (a new span or a new day)', async () => {
    const { keepCurrent, rereadAll } = await load()
    const { said, build } = card()
    const node = keepCurrent(await build(), build, '/gnomon/shape', { every: 30_000 })
    document.body.append(node)
    said.text = 'two'
    rereadAll()
    await vi.advanceTimersByTimeAsync(0)
    expect(node.querySelector('p').textContent).toBe('two')
  })
})

describe('signed out (L6)', () => {
  it('says so once when a read is refused with 401, and when the live channel probe is', async () => {
    const { read, checkSignedIn } = await load()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })))
    const heard = vi.fn()
    document.addEventListener('gnomon:signed-out', heard)
    await expect(read('/gnomon/goals')).rejects.toThrow('401')
    await expect(read('/gnomon/habits')).rejects.toThrow('401')
    expect(await checkSignedIn()).toBe(false)
    expect(heard).toHaveBeenCalledTimes(1)
    document.removeEventListener('gnomon:signed-out', heard)
  })

  it('takes a network error on the probe for a restart, not a sign-out', async () => {
    const { checkSignedIn } = await load()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await checkSignedIn()).toBe(true)
  })
})

describe('a kept-current card that leaves the page and comes back', () => {
  it('redraws again once it is back on screen (Today removed and re-summoned the same day)', async () => {
    // A real observer reports a node again when it re-enters the page.
    let report = null
    class Watching {
      constructor(callback) {
        report = (node, on) => callback([{ target: node, isIntersecting: on }])
      }
      observe(node) {
        report(node, true)
      }
    }
    vi.resetModules()
    vi.stubGlobal('IntersectionObserver', Watching)
    const { keepCurrent, markStale } = await import('./read.js')
    const said = { text: 'one' }
    const build = async () => {
      const s = document.createElement('section')
      s.innerHTML = `<p>${said.text}</p>`
      return s
    }
    const node = keepCurrent(await build(), build, ['/gnomon/today'], { every: 30_000 })
    document.body.append(node)
    await vi.advanceTimersByTimeAsync(31_000)
    node.remove()
    markStale(['state']) // a fold while it is off the board prunes it
    document.body.append(node)
    report(node, true)
    said.text = 'three'
    markStale(['state'])
    await vi.advanceTimersByTimeAsync(31_000)
    expect(node.querySelector('p').textContent).toBe('three')
  })
})
