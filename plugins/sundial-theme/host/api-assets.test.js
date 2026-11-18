// Atlas's asset door: names to BodyParts3D files, a zip read by ranges, the
// store (fetched once, the file cap, the oldest evicted past the store cap),
// a source that cannot be reached, and the route with a stub store.
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, utimesSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { deflateRawSync } from 'node:zlib'
import { centralDirectory, createAssetStore, filesFor, idOf, imageSize, mountAssets, plainOf, unzipEntry, zipEntries } from './api-assets.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'nodus-assets-'))

/** A zip of these entries, deflated, as an archive server would hold it. */
function zip(entries) {
  const locals = []
  const cds = []
  let off = 0
  for (const e of entries) {
    const comp = deflateRawSync(Buffer.from(e.data))
    const name = Buffer.from(e.name)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(8, 8)
    lh.writeUInt32LE(comp.length, 18)
    lh.writeUInt32LE(e.data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(8, 10)
    cd.writeUInt32LE(comp.length, 20)
    cd.writeUInt32LE(e.data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(off, 42)
    locals.push(lh, name, comp)
    cds.push(cd, name)
    off += 30 + name.length + comp.length
  }
  const dir = Buffer.concat(cds)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(off, 16)
  return Buffer.concat([...locals, dir, end])
}

/** fetch over a table of urls, honouring a byte range. */
function net(table) {
  return vi.fn(async (url, opts = {}) => {
    const body = table[url]
    if (body instanceof Error) throw body
    if (body === undefined) return { ok: false, status: 404, headers: new Map() }
    let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    const range = /bytes=(\d+)-(\d+)/.exec(opts.headers?.range ?? '')
    if (range) buf = buf.subarray(+range[1], +range[2] + 1)
    return { ok: true, status: range ? 206 : 200, headers: new Map([['content-length', String(buf.length)]]), arrayBuffer: async () => buf, text: async () => buf.toString('utf8'), json: async () => JSON.parse(buf.toString('utf8')) }
  })
}

describe('BodyParts3D names', () => {
  const idx = {
    elements: new Map([
      ['long head of right biceps brachii', ['FJ1478']],
      ['short head of right biceps brachii', ['FJ1512']],
      ['long head of left biceps brachii', ['FJ1478M']],
      ['humerus', ['FJ3368', 'FJ3262']],
      ['right humerus', ['FJ3368']],
      ['wall of right atrium', ['FJ2440']],
    ]),
    children: new Map([['right atrium', ['wall of right atrium']]]),
  }
  it('maps everyday words and FMA names to one side\'s element files', () => {
    expect(filesFor('bicep', idx)).toEqual({ name: 'biceps brachii', files: ['FJ1478', 'FJ1512'] })
    expect(filesFor('Humerus', idx)).toEqual({ name: 'humerus', files: ['FJ3368'] })
    expect(filesFor('right atrium', idx)).toEqual({ name: 'right atrium', files: ['FJ2440'] })
    expect(filesFor('spleen', idx)).toBeNull()
  })
  it('names a structure as the card says it', () => {
    expect(plainOf('biceps brachii')).toBe('Biceps brachii')
    expect(plainOf('tricep')).toBe('Triceps brachii')
    expect(plainOf('right atrium')).toBe('Right atrium')
  })
})

describe('a zip read by ranges', () => {
  it('finds an entry in the central directory and inflates it alone', () => {
    const z = zip([{ name: 'set/FJ1.obj', data: 'v 0 0 0\n' }, { name: 'set/FJ2.obj', data: 'v 1 1 1\nf 1 1 1\n' }])
    const cd = centralDirectory(z.subarray(z.length - 64))
    const entries = zipEntries(z.subarray(cd.offset, cd.offset + cd.size))
    expect([...entries.keys()]).toEqual(['FJ1', 'FJ2'])
    const e = entries.get('FJ2')
    expect(unzipEntry(z.subarray(e.offset, e.offset + e.csize + 1024), e).toString()).toBe('v 1 1 1\nf 1 1 1\n')
  })
})

describe('image sizes', () => {
  it('reads a PNG\'s and a JPEG\'s header', () => {
    const png = Buffer.alloc(32)
    png.writeUInt32BE(0x89504e47, 0)
    png.writeUInt32BE(720, 16)
    png.writeUInt32BE(480, 20)
    expect(imageSize(png)).toEqual({ w: 720, h: 480, format: 'png' })
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 8, 0x01, 0xe0, 0x02, 0xd0, 3, 0, 0, 0, 0])
    expect(imageSize(jpeg)).toEqual({ w: 720, h: 480, format: 'jpeg' })
    expect(imageSize(Buffer.from('GIF89a......'))).toBeNull()
  })
})

describe('the store', () => {
  it('fetches a file once, keeps it, and refuses one over the cap', async () => {
    const get = net({ 'https://x/a.obj': 'v 0 0 0\n', 'https://x/big.glb': Buffer.alloc(2000) })
    const store = createAssetStore({ dir: tmp(), fetch: get, limits: { file: 1000, store: 10_000 }, log: () => {} })
    const id = store.remember('https://x/a.obj', 'obj')
    expect(id).toBe(idOf('https://x/a.obj#'))
    const [one, two] = await Promise.all([store.file(id), store.file(id)])
    expect(one).toMatchObject({ size: 8, cached: false })
    expect(two).toBe(one)
    expect(await store.file(id)).toMatchObject({ cached: true })
    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0][1].headers['user-agent']).toMatch(/^Sundial-Nodus/)
    await expect(store.file(store.remember('https://x/big.glb', 'glb'))).rejects.toThrow(/over the 1000 byte cap/)
    expect(await store.file('0'.repeat(32))).toBeNull()
  })
  it('reads one zip entry by its range', async () => {
    const z = zip([{ name: 'p/FJ7.obj', data: 'v 7 7 7\n' }])
    const cd = centralDirectory(z.subarray(z.length - 64))
    const e = zipEntries(z.subarray(cd.offset, cd.offset + cd.size)).get('FJ7')
    const get = net({ 'https://x/set.zip': z })
    const store = createAssetStore({ dir: tmp(), fetch: get, log: () => {} })
    const id = store.remember('https://x/set.zip', 'obj', { entry: 'FJ7', zip: e })
    expect((await store.bytes(id)).toString()).toBe('v 7 7 7\n')
    expect(get.mock.calls[0][1].headers.range).toBe(`bytes=${e.offset}-${e.offset + e.csize + 1024}`)
  })
  it('evicts the oldest files past the store\'s cap, never the one just fetched', async () => {
    const dir = tmp()
    const old = ['a', 'b'].map((c, i) => {
      const name = `${c.repeat(32)}.obj`
      writeFileSync(join(dir, name), Buffer.alloc(400))
      utimesSync(join(dir, name), 1000 + i, 1000 + i)
      return name
    })
    const store = createAssetStore({ dir, fetch: net({ 'https://x/new.obj': Buffer.alloc(400) }), limits: { file: 1000, store: 900 }, log: () => {} })
    const id = store.remember('https://x/new.obj', 'obj')
    await store.file(id)
    const left = readdirSync(dir).filter((n) => n.endsWith('.obj'))
    expect(left.sort()).toEqual([old[1], `${id}.obj`].sort())
  })
  it('answers from the sources it reaches and says which it could not', async () => {
    const commons = { query: { pages: { 1: { index: 1, title: 'File:Gray411.png', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/g411.png', descriptionurl: 'https://commons/g411', mime: 'image/png', thumbwidth: 720, thumbheight: 700, extmetadata: { LicenseShortName: { value: 'Public domain' }, Artist: { value: '<a href="x">Henry Vandyke Carter</a>' }, ImageDescription: { value: 'The <b>biceps</b>' } } }] }, 2: { index: 2, title: 'File:Anim.gif', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/a.gif', mime: 'image/gif', thumbwidth: 720, thumbheight: 700 }] } } } }
    const get = vi.fn(async (url) => {
      if (url.startsWith('https://commons.wikimedia.org/')) return { ok: true, json: async () => commons }
      throw new Error('getaddrinfo ENOTFOUND')
    })
    const store = createAssetStore({ dir: tmp(), fetch: get, log: () => {} })
    const plates = await store.search('Gray biceps', 'plate')
    expect(plates.candidates).toEqual([expect.objectContaining({ kind: 'plate', source: 'Wikimedia Commons', license: 'Public domain', credit: 'Henry Vandyke Carter', title: 'Gray411.png', description: 'The biceps', w: 720, h: 700 })])
    expect(get.mock.calls[0][0]).toMatch(/gsrsearch=filetype%3Abitmap\+Gray\+biceps/)
    const meshes = await store.search('windmill', 'mesh')
    expect(meshes.candidates).toEqual([])
    expect(meshes.skipped.map((s) => s.source)).toEqual(['Poly Pizza', 'Smithsonian 3D'])
  })

  it('atlas.libraries off: no search reaches a library, and a remembered file is not fetched', async () => {
    const get = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    const store = createAssetStore({ dir: tmp(), fetch: get, libraries: () => false, log: () => {} })
    const found = await store.search('Gray biceps', 'mesh', { names: ['biceps'] })
    expect(found).toEqual({ candidates: [], skipped: [{ source: 'the open libraries', reason: 'atlas.libraries is false in config.json' }] })
    expect(await store.search('Gray biceps', 'plate')).toMatchObject({ candidates: [] })
    await expect(store.file(store.remember('https://static.poly.pizza/x.glb', 'glb'))).rejects.toThrow(/atlas\.libraries/)
    expect(get).not.toHaveBeenCalled()
  })
})

describe('the route', () => {
  function mounted(store) {
    const routes = new Map()
    mountAssets({ effect: (fn) => fn(), webServer: { register: (r) => routes.set(r.path, r) }, connection: { requestRejection: (req) => (req.headers.cookie === 'ok' ? undefined : 401) } }, { store })
    return async (url, cookie = 'ok') => {
      const res = Object.assign(new PassThrough(), { status: 0, head: null, headersSent: false })
      res.writeHead = (s, h) => ((res.status = s), (res.head = h), (res.headersSent = true), res)
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      const done = new Promise((ok) => res.on('end', ok))
      const end = res.end.bind(res)
      res.end = (b) => end(b)
      await routes.get('/gnomon/api/assets').handler({ url, method: 'GET', headers: { cookie } }, res)
      await done
      return { status: res.status, head: res.head, body: Buffer.concat(chunks).toString() }
    }
  }
  it('is one prefix route behind the fence: text candidates, then the file itself', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'f.obj'), 'v 0 0 0\n')
    const store = { search: vi.fn(async (q, kind, opts) => ({ candidates: [{ id: 'p', kind, title: q, names: opts.names }], skipped: [] })), file: vi.fn(async (id) => (id === 'a'.repeat(32) ? { path: join(dir, 'f.obj'), type: 'text/plain; charset=utf-8', size: 8 } : null)) }
    const call = mounted(store)
    const found = await call('/gnomon/api/assets/search?q=biceps&kind=plate&names=biceps%20brachii,humerus')
    expect(found.status).toBe(200)
    expect(JSON.parse(found.body)).toEqual({ candidates: [{ id: 'p', kind: 'plate', title: 'biceps', names: ['biceps brachii', 'humerus'] }], skipped: [] })
    const file = await call(`/gnomon/api/assets/${'a'.repeat(32)}`)
    expect(file).toMatchObject({ status: 200, body: 'v 0 0 0\n', head: { 'content-type': 'text/plain; charset=utf-8' } })
    expect((await call(`/gnomon/api/assets/${'b'.repeat(32)}`)).status).toBe(404)
    expect((await call('/gnomon/api/assets/../../etc/passwd')).status).toBe(404)
    expect((await call('/gnomon/api/assets/search?q=x', 'no')).status).toBe(401)
  })
})
