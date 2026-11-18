// The privacy lists in Settings: a guarded read, and a guarded POST that validates, writes config.json and applies at once.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPrivacyConfig, privacyConfig } from '@sundial/helpers/privacy-config.js'
import { privateApps } from '@sundial/helpers/redact/redact-policy.js'
import { fakeCtx } from './mount.test.js'

vi.mock('./read-freshness.js', () => ({ readFreshness: async () => [] }))
vi.mock('./read-privacy.js', () => ({ readSeen: async () => ({ apps: [{ name: 'Puzzlebox Bank', windowId: 'com.example.bank:1' }], hosts: ['mijn.bank.example'] }) }))

async function call(routes, path, { method = 'POST', body, headers = {} } = {}) {
  const req = Object.assign((async function* () { if (body !== undefined) yield typeof body === 'string' ? body : JSON.stringify(body) })(), { method, url: path, headers })
  let status = 0
  let out = null
  await routes.get(path).handler(req, { headersSent: false, writeHead: (s) => (status = s), end: (t) => (out = /^[{[]/.test(t ?? '') ? JSON.parse(t) : t) })
  return { status, out }
}

async function mount(rejection) {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const { mountShell } = await import('./server.js')
  const home = mkdtempSync(join(tmpdir(), 'sundial-privacy-'))
  writeFileSync(join(home, 'config.json'), JSON.stringify({ ocr: { enabled: true }, privacy: { redactionTier: 2 } }))
  const { ctx, routes } = fakeCtx({ config: { ownerAliases: [] } })
  if (rejection) ctx.connection = { requestRejection: () => rejection }
  mountShell(ctx, { home })
  return { home, ctx, routes, config: () => JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) }
}

describe('/gnomon/api/privacy', () => {
  afterEach(() => applyPrivacyConfig({ redactionTier: 2, extraSensitiveApps: [], extraHiddenApps: [], extraShellRedactPatterns: [] }))

  it('reads the built-in lists, the owner’s, and suggestions from the record', async () => {
    const { routes } = await mount()
    const { status, out } = await call(routes, '/gnomon/api/privacy', { method: 'GET' })
    expect(status).toBe(200)
    expect(out.apps.builtIn).toContain('whatsapp')
    expect(out.hosts.builtIn).toContain('outlook.office.com')
    expect(out.apps.suggested).toEqual([{ name: 'Puzzlebox Bank', bundleId: 'com.example.bank', says: 'Looks like banking or money. You used it this month.' }])
    expect(out.hosts.suggested[0].name).toBe('mijn.bank.example')
  })

  it('an add writes config.json, keeps every other key, and is live without a restart', async () => {
    const { routes, config } = await mount()
    expect(privateApps()).not.toContain('puzzlebox bank')
    const { status, out } = await call(routes, '/gnomon/api/privacy/edit', { body: { op: 'add', kind: 'app', value: 'Puzzlebox Bank' } })
    expect(status).toBe(200)
    expect(out.saved).toBe('Puzzlebox Bank')
    expect(out.apps.yours).toEqual([{ name: 'Puzzlebox Bank', bundleId: 'com.example.bank' }])
    expect(out.apps.suggested).toEqual([])
    expect(config()).toEqual({ ocr: { enabled: true }, privacy: { redactionTier: 2, sensitiveApps: ['Puzzlebox Bank'] } })
    expect(privateApps()).toContain('puzzlebox bank')
    await call(routes, '/gnomon/api/privacy/edit', { body: { op: 'add', kind: 'host', value: 'https://mijn.bank.example/login' } })
    expect(privacyConfig.privateHosts).toContain('mijn.bank.example')
    await call(routes, '/gnomon/api/privacy/edit', { body: { op: 'remove', kind: 'app', value: 'puzzlebox bank' } })
    expect(config().privacy.sensitiveApps).toEqual([])
    expect(privateApps()).not.toContain('puzzlebox bank')
    // Only the two lists move: the tier this process booted with stays.
    expect(privacyConfig.redactionTier).toBe(2)
  })

  it('validates: a GET, a bad body, a covered add and a built-in remove are refused, and nothing is written', async () => {
    const { routes, config } = await mount()
    expect(await call(routes, '/gnomon/api/privacy/edit', { method: 'GET' })).toEqual({ status: 405, out: { unavailable: 'A privacy edit takes a POST.' } })
    expect((await call(routes, '/gnomon/api/privacy/edit', { body: 'not json' })).status).toBe(400)
    expect((await call(routes, '/gnomon/api/privacy/edit', { body: { op: 'add', kind: 'app', value: 'x'.repeat(2000) } })).status).toBe(413)
    expect(await call(routes, '/gnomon/api/privacy/edit', { body: { op: 'add', kind: 'app', value: 'WhatsApp' } })).toEqual({ status: 400, out: { unavailable: 'Already private: the built-in “whatsapp” covers it.' } })
    expect(await call(routes, '/gnomon/api/privacy/edit', { body: { op: 'remove', kind: 'host', value: 'outlook.office.com' } })).toEqual({ status: 400, out: { unavailable: 'Built in: it always stays private.' } })
    expect(config()).toEqual({ ocr: { enabled: true }, privacy: { redactionTier: 2 } })
  })

  it('both routes sit behind the fence', async () => {
    const { routes, config } = await mount(401)
    for (const path of ['/gnomon/api/privacy', '/gnomon/api/privacy/edit']) expect((await call(routes, path, { body: { op: 'add', kind: 'app', value: 'Puzzlebox' } })).status, path).toBe(401)
    expect(config().privacy.sensitiveApps).toBeUndefined()
  })
})

// What may leave this Mac: three switches in the Services catalog, saved through its guarded route under the config lock.
describe('/gnomon/api/services, what may leave this Mac', () => {
  const row = (out, id) => out.services.find((s) => s.id === id)

  it('reads the three switches, on by default, with when each applies', async () => {
    const { routes } = await mount()
    const { status, out } = await call(routes, '/gnomon/api/services', { method: 'GET' })
    expect(status).toBe(200)
    expect(out.services.filter((s) => s.sep).map((s) => s.title)).toContain('What may leave this Mac')
    expect(row(out, 'embeddings')).toMatchObject({ value: true, now: true, ask: null })
    expect(row(out, 'githubPrs')).toMatchObject({ value: true, now: false })
    expect(row(out, 'atlasLibraries')).toMatchObject({ value: true, now: true })
  })

  it('a switch writes config.json, keeps every other key, and only the PR check waits for a restart', async () => {
    const { routes, ctx, config } = await mount()
    expect((await call(routes, '/gnomon/api/services', { body: { id: 'embeddings', value: false } })).status).toBe(200)
    expect((await call(routes, '/gnomon/api/services', { body: { id: 'atlasLibraries', value: false } })).status).toBe(200)
    const { out } = await call(routes, '/gnomon/api/services', { body: { id: 'githubPrs', value: false } })
    expect(row(out, 'githubPrs').value).toBe(false)
    // W3: each write is a config:changed in the log; only the PR check's names a restart.
    expect(ctx.gnomonKernel.appendSignal.mock.calls.map(([, change]) => change.restart)).toEqual([[], [], ['sensors.githubPrs']])
    expect(config()).toEqual({ ocr: { enabled: true }, privacy: { redactionTier: 2 }, memory: { embeddings: false }, atlas: { libraries: false }, sensors: { githubPrs: false } })
  })

  it('says an open search model question, and refuses anything but on or off, writing nothing', async () => {
    const { home, routes, config } = await mount()
    writeFileSync(join(home, 'config.json'), JSON.stringify({ memory: { embeddings: 'ask' } }))
    const { out } = await call(routes, '/gnomon/api/services', { method: 'GET' })
    expect(row(out, 'embeddings')).toMatchObject({ value: 'ask', ask: 'Nothing downloads until you choose.' })
    for (const value of ['ask', 'yes', 1, null]) expect((await call(routes, '/gnomon/api/services', { body: { id: 'embeddings', value } })).status, String(value)).toBe(400)
    expect(config()).toEqual({ memory: { embeddings: 'ask' } })
    await call(routes, '/gnomon/api/services', { body: { id: 'embeddings', value: true } })
    expect(config()).toEqual({ memory: { embeddings: true } })
  })

  it('sits behind the fence', async () => {
    const { routes, config } = await mount(401)
    expect((await call(routes, '/gnomon/api/services', { body: { id: 'embeddings', value: false } })).status).toBe(401)
    expect(config().memory).toBeUndefined()
  })
})
