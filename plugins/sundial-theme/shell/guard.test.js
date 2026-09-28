// Release audit S1/S2: every route Sundial serves sits behind dsh's fence.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { guard, guardPage, internalHeaders, rejection } from './guard.js'

const HERE = dirname(fileURLToPath(import.meta.url))

function res() {
  const r = { status: null, body: '', headersSent: false }
  r.writeHead = (s) => {
    r.status = s
    r.headersSent = true
    return r
  }
  r.end = (b = '') => {
    r.body += b
    return r
  }
  return r
}

// A stand-in for dsh's connection: authenticated only with the right cookie,
// fenced to a loopback Host, no cross-site fetches.
const connection = {
  requestRejection(req) {
    const host = req.headers.host ?? ''
    if (!/^127\.0\.0\.1(:\d+)?$/.test(host)) return 403
    if (req.headers['sec-fetch-site'] === 'cross-site') return 403
    if (req.headers.origin && new URL(req.headers.origin).host !== host) return 403
    return req.headers.cookie === 'ok' ? undefined : 401
  },
  authorizeIndex(req, r) {
    if (req.headers.cookie === 'ok') return true
    r.writeHead(401).end()
    return false
  },
}

const route = guard(connection, { kind: 'exact', path: '/gnomon/today', handler: async (_q, r) => r.writeHead(200).end('record') })
const call = async (headers, g = route) => {
  const r = res()
  await g.handler({ url: '/gnomon/today', headers }, r)
  return r
}

describe('guard', () => {
  it('refuses a request without the session cookie', async () => {
    expect((await call({ host: '127.0.0.1:3080' })).status).toBe(401)
  })
  it('refuses a rebinding Host and a cross-site page even with the cookie', async () => {
    expect((await call({ host: 'evil.example:3080', cookie: 'ok' })).status).toBe(403)
    expect((await call({ host: '127.0.0.1:3080', cookie: 'ok', origin: 'https://evil.example' })).status).toBe(403)
    expect((await call({ host: '127.0.0.1:3080', cookie: 'ok', 'sec-fetch-site': 'cross-site' })).status).toBe(403)
  })
  it('lets a signed-in same-origin browser through', async () => {
    const r = await call({ host: '127.0.0.1:3080', cookie: 'ok' })
    expect([r.status, r.body]).toEqual([200, 'record'])
  })
  it('lets this process in with its secret, over loopback only', async () => {
    expect((await call({ host: '127.0.0.1:3080', ...internalHeaders() })).status).toBe(200)
    expect((await call({ host: 'evil.example', ...internalHeaders() })).status).toBe(403)
    expect((await call({ host: '127.0.0.1:3080', 'x-sundial-internal': 'guess' })).status).toBe(401)
  })
  it('fails closed without a connection service', async () => {
    expect(rejection(undefined, { headers: { host: '127.0.0.1' } })).toBe(403)
  })
  it('a page answers 401 without a cookie and serves with one', async () => {
    const page = guardPage(connection, { kind: 'exact', path: '/', handler: async (_q, r) => r.writeHead(200).end('page') })
    expect((await call({ host: '127.0.0.1:3080' }, page)).status).toBe(401)
    expect((await call({ host: '127.0.0.1:3080', cookie: 'ok' }, page)).status).toBe(200)
  })
})

describe('no route skips the guard', () => {
  it('every webServer.register in the theme goes through guard()', () => {
    for (const file of ['../index.js', 'server.js']) {
      const src = readFileSync(join(HERE, file), 'utf8')
      const direct = src.match(/ctx\.webServer\.register\(/g) ?? []
      const guarded = src.match(/ctx\.webServer\.register\(\s*(guard|guardPage)\(ctx\.connection/g) ?? []
      expect(direct.length, `${file}: every register call wraps guard`).toBe(guarded.length)
    }
  })
  it('no other plugin registers web routes', () => {
    for (const plugin of ['sundial-actions', 'sundial-db', 'sundial-kernel', 'sundial-memory', 'sundial-proactive', 'sundial-sensors', 'sundial-tools', 'sundial-web-browser', 'sundial-llm-openai']) {
      const src = readFileSync(join(HERE, '..', '..', plugin, 'index.js'), 'utf8')
      expect(src, plugin).not.toMatch(/webServer\.register/)
    }
  })
})
