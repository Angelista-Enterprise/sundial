// Atlas mode's asset door (Nodus): real things from open libraries, fetched
// once and kept on this Mac. `GET /gnomon/api/assets/search?q=…&kind=mesh|plate`
// answers candidates as text (titles, descriptions, licences, credits and the
// ids to ask for), and `GET /gnomon/api/assets/<id>` streams the cached file.
//
// What leaves the Mac: the search words (Atlas sends the sanitized ask, or the
// plain names a model read out of it) to the libraries below, and the fetch of
// the files they name. Nothing else: no record, no ids, no cookies.
// `atlas.libraries: false` in config.json stops all of it: no search, no fetch.
//
// Sources, each tried on its own (one unreachable is skipped, never faked):
// - BodyParts3D (DBCLS, CC BY-SA 2.1 JP): per-structure OBJ meshes of the human
//   body named by FMA. The archive at dbarchive.biosciencedbc.jp keeps them in
//   two zips (65 and 143 MB) served with byte ranges, so only the structures
//   asked are read: the zips' central directories once, then one range per
//   element file, inflated here. The name lists (a few MB) are kept beside.
// - Wikimedia Commons (plates; Gray's Anatomy is public domain): the API with
//   a User-Agent naming this client, thumbnails 720 px wide (Jev takes 280 to 1568).
// - Poly Pizza (CC0 and CC BY): its API wants a key, so the public search page's
//   own state is read (titles, creators, licences); the GLB is static.
// - Smithsonian 3D (CC0 open access): the 3d-api search; only packages with an
//   uncompressed download GLB (no Draco decoder is vendored) and a JPEG thumb.
//
// The store: `$SUNDIAL_HOME/.daemon/nodus-assets/<id>.<ext>`, an id the sha of
// where the bytes come from. Download once, keep forever; a file over 25 MB is
// refused, and past 2 GB the oldest files go first (their index rows stay, so
// a file evicted is fetched again when asked).
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'
import { getSundialRuntimeDir } from '@sundial/helpers/sundial-paths.js'
import { guard } from './guard.js'
import { sendJson } from './http.js'

const OFF = 'atlas.libraries is false in config.json'

export const LIMITS = { file: 25 * 2 ** 20, store: 2 * 2 ** 30 }
/** Wikimedia asks every client to name itself; this names the software, never the owner. */
export const UA = 'Sundial-Nodus/0.1 (Atlas mode; a single-user local client) node-fetch'
const TYPES = { obj: 'text/plain; charset=utf-8', glb: 'model/gltf-binary', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }
const BP3D = 'https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST'
const BP3D_ZIPS = { partof: `${BP3D}/partof_BP3D_4.0_obj_99.zip`, isa: `${BP3D}/isa_BP3D_4.0_obj_99.zip` }
const COMMONS = 'https://commons.wikimedia.org/w/api.php'

export const idOf = (key) => createHash('sha256').update(key).digest('hex').slice(0, 32)
const strip = (s, n = 300) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)

// ── BodyParts3D names ─────────────────────────────────────────────────────────

/** Everyday words to the FMA names BodyParts3D files its meshes under. */
export const PLAIN = {
  bicep: 'biceps brachii', biceps: 'biceps brachii', tricep: 'triceps brachii', triceps: 'triceps brachii',
  quad: 'quadriceps femoris', quads: 'quadriceps femoris', hamstring: 'biceps femoris', calf: 'gastrocnemius',
  'shoulder blade': 'scapula', collarbone: 'clavicle', 'thigh bone': 'femur', 'shin bone': 'tibia', kneecap: 'patella',
  'upper arm bone': 'humerus', breastbone: 'sternum', jawbone: 'mandible', pec: 'pectoralis major', pecs: 'pectoralis major', delt: 'deltoid', delts: 'deltoid', glute: 'gluteus maximus',
}
export const normName = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
/** An FMA name as the card says it, in sentence case; a paired structure is named as asked, without the side its mesh was taken from. */
export const plainOf = (fma) => {
  const s = normName(PLAIN[normName(fma)] ?? fma)
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * The element files of a structure, by name. One side when the body has two
 * (the right one), the structure's own elements when it has them, else its
 * parts'; a name that is no structure (biceps brachii is filed as its two
 * heads) gathers every structure whose name holds it as words.
 * @param idx `{ elements: Map<name, string[]>, children: Map<name, string[]> }`
 * @returns `{ name, files }` or null
 */
export function filesFor(name, idx) {
  const n = normName(PLAIN[normName(name)] ?? name)
  if (!n) return null
  const collect = (k, seen = new Set()) => {
    if (seen.has(k)) return []
    seen.add(k)
    const own = idx.elements.get(k)
    if (own?.length) return own
    return (idx.children.get(k) ?? []).flatMap((c) => collect(c, seen))
  }
  const files = (k) => [...new Set(collect(k))]
  for (const k of [`right ${n}`, n]) if (files(k).length) return { name: n, files: files(k) }
  const found = [...new Set([...idx.elements.keys(), ...idx.children.keys()])].filter((k) => ` ${k} `.includes(` ${n} `))
  const right = found.filter((k) => / right /.test(` ${k} `))
  const hits = right.length ? right : found.filter((k) => !/ left /.test(` ${k} `))
  const all = [...new Set(hits.flatMap((k) => files(k)))]
  return all.length ? { name: n, files: all } : null
}

/** A zip's central directory: entry name to where its bytes are. */
export function centralDirectory(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (end < 0) return null
  const count = buf.readUInt16LE(end + 10)
  const size = buf.readUInt32LE(end + 12)
  const offset = buf.readUInt32LE(end + 16)
  return { count, size, offset }
}
export function zipEntries(cd) {
  const out = new Map()
  for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; ) {
    const nl = cd.readUInt16LE(p + 28)
    const el = cd.readUInt16LE(p + 30)
    const cl = cd.readUInt16LE(p + 32)
    const name = cd.toString('utf8', p + 46, p + 46 + nl)
    out.set(name.replace(/^.*\//, '').replace(/\.obj$/, ''), { method: cd.readUInt16LE(p + 10), csize: cd.readUInt32LE(p + 20), usize: cd.readUInt32LE(p + 24), offset: cd.readUInt32LE(p + 42) })
    p += 46 + nl + el + cl
  }
  return out
}
/** One zip entry's bytes from a ranged read that starts at its local header. */
export function unzipEntry(buf, { method, csize }) {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('not a zip entry')
  const start = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28)
  const data = buf.subarray(start, start + csize)
  return method === 8 ? inflateRawSync(data) : method === 0 ? data : null
}

/** A PNG's or JPEG's size, read from its header; null when it is neither. */
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), format: 'png' }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2
    while (p + 9 < buf.length) {
      if (buf[p] !== 0xff) return null
      const m = buf[p + 1]
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { w: buf.readUInt16BE(p + 7), h: buf.readUInt16BE(p + 5), format: 'jpeg' }
      p += 2 + buf.readUInt16BE(p + 2)
    }
  }
  return null
}

// ── The store ─────────────────────────────────────────────────────────────────

/**
 * @param opts.dir where the files live
 * @param opts.fetch the network (a stub in tests)
 * @param opts.limits `{ file, store }` in bytes
 */
export function createAssetStore({ dir = join(getSundialRuntimeDir(), 'nodus-assets'), fetch = globalThis.fetch, libraries = () => loadSundialConfig().atlas.libraries, limits = LIMITS, log = (m) => console.warn(`[sundial-theme] assets: ${m}`) } = {}) {
  mkdirSync(dir, { recursive: true })
  // Every request to a library goes through here, so the switch (read per call) stops them all.
  const get = (url, init) => (libraries() ? fetch(url, init) : Promise.reject(new Error(OFF)))
  const indexFile = join(dir, 'index.json')
  const index = (() => {
    try {
      return JSON.parse(readFileSync(indexFile, 'utf8'))
    } catch {
      return {}
    }
  })()
  const saveIndex = () => {
    writeFileSync(`${indexFile}.tmp`, JSON.stringify(index))
    renameSync(`${indexFile}.tmp`, indexFile)
  }
  const pathOf = (id) => join(dir, `${id}.${index[id].ext}`)
  const flights = new Map()
  const times = {}

  /** Name a file by where it comes from; nothing is fetched yet. */
  function remember(url, ext, extra = {}) {
    const id = idOf(`${url}#${extra.entry ?? ''}`)
    if (!index[id]) {
      index[id] = { url, ext, ...extra }
      saveIndex()
    }
    return id
  }

  async function grab(url, headers = {}) {
    const res = await get(url, { headers: { 'user-agent': UA, ...headers }, redirect: 'follow' })
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`)
    const length = Number(res.headers?.get?.('content-length') ?? 0)
    if (length > limits.file + 4096) throw new Error(`a file of ${length} bytes is over the ${limits.file} byte cap`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > limits.file + 4096) throw new Error(`a file of ${buf.length} bytes is over the ${limits.file} byte cap`)
    return buf
  }

  /** The file on disk, fetched the first time it is asked for. */
  function file(id) {
    const row = index[id]
    if (!row) return Promise.resolve(null)
    if (existsSync(pathOf(id))) return Promise.resolve({ path: pathOf(id), type: TYPES[row.ext] ?? 'application/octet-stream', size: statSync(pathOf(id)).size, cached: true })
    if (flights.has(id)) return flights.get(id)
    const flight = (async () => {
      const t = performance.now()
      let buf
      if (row.zip) {
        const raw = await grab(row.url, { range: `bytes=${row.zip.offset}-${row.zip.offset + row.zip.csize + 1024}` })
        buf = unzipEntry(raw, row.zip)
        if (!buf) throw new Error('a zip entry in a method this cannot read')
      } else buf = await grab(row.url)
      if (buf.length > limits.file) throw new Error(`a file of ${buf.length} bytes is over the ${limits.file} byte cap`)
      writeFileSync(`${pathOf(id)}.tmp`, buf)
      renameSync(`${pathOf(id)}.tmp`, pathOf(id))
      times[id] = Math.round(performance.now() - t)
      evict(id)
      return { path: pathOf(id), type: TYPES[row.ext] ?? 'application/octet-stream', size: buf.length, cached: false }
    })().finally(() => flights.delete(id))
    flights.set(id, flight)
    return flight
  }
  const bytes = async (id) => {
    const f = await file(id)
    return f ? readFileSync(f.path) : null
  }
  /** An image as Jev takes it (280 to 1568 px a side, PNG or JPEG), or null. */
  const image = async (id) => {
    const b = await bytes(id).catch(() => null)
    const s = b && imageSize(b)
    if (!s || Math.min(s.w, s.h) < 280 || Math.max(s.w, s.h) > 1568) return null
    return { type: 'image', data_base64: b.toString('base64'), format: s.format, w: s.w, h: s.h }
  }

  /** Past the store's cap the oldest files go (never `keep`); their rows stay, so they can come back. */
  function evict(keep = null) {
    const files = readdirSync(dir)
      .filter((n) => /^[0-9a-f]{32}\.\w+$/.test(n))
      .map((n) => ({ n, ...((s) => ({ size: s.size, at: s.mtimeMs }))(statSync(join(dir, n))) }))
      .sort((a, b) => a.at - b.at)
    let total = files.reduce((s, f) => s + f.size, 0)
    for (const f of files) {
      if (total <= limits.store) break
      if (keep && f.n.startsWith(keep)) continue
      unlinkSync(join(dir, f.n))
      total -= f.size
    }
    return total
  }

  // ── BodyParts3D: the lists and the zips' directories, once ──
  // The BodyParts3D index, loaded once per store (a failed load is forgotten, so the next search tries again).
  const once = { bp3d: null }
  const textOnce = async (name, url) => {
    const at = join(dir, 'bp3d', name)
    if (existsSync(at)) return readFileSync(at, 'utf8')
    const text = (await grab(url)).toString('utf8')
    mkdirSync(join(dir, 'bp3d'), { recursive: true })
    writeFileSync(at, text)
    return text
  }
  const directoryOnce = async (tree) => {
    const at = join(dir, 'bp3d', `${tree}-entries.json`)
    if (existsSync(at)) return new Map(JSON.parse(readFileSync(at, 'utf8')))
    const head = await get(BP3D_ZIPS[tree], { method: 'HEAD', headers: { 'user-agent': UA } })
    const length = Number(head.headers.get('content-length'))
    const tail = await grab(BP3D_ZIPS[tree], { range: `bytes=${length - 65536}-${length - 1}` })
    const cd = centralDirectory(tail)
    const entries = zipEntries(await grab(BP3D_ZIPS[tree], { range: `bytes=${cd.offset}-${cd.offset + cd.size - 1}` }))
    mkdirSync(join(dir, 'bp3d'), { recursive: true })
    writeFileSync(at, JSON.stringify([...entries]))
    return entries
  }
  function loadBp3d() {
    once.bp3d ??= (async () => {
      const [isaE, partE, isaR, partR, isaZ, partZ] = await Promise.all([
        textOnce('isa_element_parts.txt', `${BP3D}/isa_element_parts.txt`),
        textOnce('partof_element_parts.txt', `${BP3D}/partof_element_parts.txt`),
        textOnce('isa_inclusion_relation_list.txt', `${BP3D}/isa_inclusion_relation_list.txt`),
        textOnce('partof_inclusion_relation_list.txt', `${BP3D}/partof_inclusion_relation_list.txt`),
        directoryOnce('isa'),
        directoryOnce('partof'),
      ])
      const elements = new Map()
      const children = new Map()
      const add = (m, k, v) => (m.get(k) ?? m.set(k, []).get(k)).push(v)
      for (const line of `${isaE}\n${partE}`.split('\n').slice(1)) {
        const [, name, fj] = line.split('\t')
        if (fj && name !== 'name') add(elements, normName(name), fj.trim())
      }
      for (const line of `${isaR}\n${partR}`.split('\n')) {
        const [, parent, , child] = line.split('\t')
        if (child && parent !== 'parent name') add(children, normName(parent), normName(child))
      }
      for (const [k, v] of elements) elements.set(k, [...new Set(v)])
      return { elements, children, zips: { partof: partZ, isa: isaZ } }
    })().catch((error) => {
      once.bp3d = null
      throw error
    })
    return once.bp3d
  }

  /** One candidate: the asked structures as a set of BodyParts3D meshes. */
  async function bodyParts(names) {
    const idx = await loadBp3d()
    const parts = []
    for (const asked of names.slice(0, 9)) {
      const hit = filesFor(asked, idx)
      if (!hit) continue
      const files = hit.files
        .map((fj) => {
          const tree = idx.zips.partof.has(fj) ? 'partof' : idx.zips.isa.has(fj) ? 'isa' : null
          return tree && { fj, tree, ...idx.zips[tree].get(fj) }
        })
        .filter(Boolean)
        .slice(0, 40)
      if (!files.length || parts.some((p) => p.fma === hit.name)) continue
      parts.push({ fma: hit.name, label: plainOf(hit.name), bytes: files.reduce((s, f) => s + f.usize, 0), files: files.map((f) => remember(BP3D_ZIPS[f.tree], 'obj', { entry: f.fj, zip: { offset: f.offset, csize: f.csize, method: f.method } })) })
    }
    if (!parts.length) return []
    return [{ id: idOf(`bp3d:${parts.map((p) => p.fma).join('|')}`), kind: 'mesh', format: 'obj', source: 'BodyParts3D', license: 'CC BY-SA 2.1 JP', credit: 'BodyParts3D, The Database Center for Life Science', url: 'https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html', title: `BodyParts3D: ${parts.map((p) => p.label).join(', ')}`, description: `Anatomical meshes of the human body, one per structure: ${parts.map((p) => p.label).join(', ')}.`, up: 'z', parts }]
  }

  async function commons(q, n = 6) {
    const params = new URLSearchParams({ action: 'query', format: 'json', generator: 'search', gsrsearch: `filetype:bitmap ${q}`, gsrnamespace: '6', gsrlimit: String(n), prop: 'imageinfo', iiprop: 'url|extmetadata|size|mime', iiurlwidth: '720' })
    const res = await get(`${COMMONS}?${params}`, { headers: { 'user-agent': UA } })
    if (!res.ok) throw new Error(`Commons answered ${res.status}`)
    const pages = Object.values((await res.json())?.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    return pages.flatMap((p) => {
      const ii = p.imageinfo?.[0]
      const meta = ii?.extmetadata ?? {}
      const w = ii?.thumbwidth ?? ii?.width
      const h = ii?.thumbheight ?? ii?.height
      // Jev reads PNG and JPEG only; a GIF or an SVG is no plate here.
      if (!ii?.thumburl || Math.min(w, h) < 280 || !/^image\/(png|jpeg)$/.test(ii.mime ?? '')) return []
      const ext = /\.png(\?|$)/i.test(ii.thumburl) ? 'png' : 'jpg'
      const image = remember(ii.thumburl, ext)
      return [{ id: image, kind: 'plate', image, thumb: image, source: 'Wikimedia Commons', license: strip(meta.LicenseShortName?.value, 80) || 'see the file page', credit: strip(meta.Artist?.value, 160) || strip(strip(meta.Credit?.value, 600).replace(/https?:\/\/\S+|Gallery:/g, ''), 160) || 'unknown', url: ii.descriptionurl, title: String(p.title ?? '').replace(/^File:/, ''), description: strip(meta.ImageDescription?.value), w, h }]
    })
  }

  async function polyPizza(q, n = 4) {
    const res = await get(`https://poly.pizza/search/${encodeURIComponent(q)}`, { headers: { 'user-agent': UA } })
    if (!res.ok) throw new Error(`Poly Pizza answered ${res.status}`)
    const html = await res.text()
    const m = /window\.__SERVER_APP_STATE__\s*=\s*(\{.*?\})\s*<\/script>/s.exec(html)
    const found = m ? JSON.parse(m[1])?.initialData?.result ?? [] : []
    return found.slice(0, n).flatMap((r) => {
      const uuid = /static\.poly\.pizza\/([0-9a-f-]{36})\.webp/.exec(r.previewUrl ?? '')?.[1]
      if (!uuid || !/^CC/.test(r.licence ?? '')) return []
      const glb = remember(`https://static.poly.pizza/${uuid}.glb`, 'glb')
      return [{ id: glb, kind: 'mesh', format: 'glb', file: glb, source: 'Poly Pizza', license: r.licence === 'CC0 1.0' ? 'CC0' : r.licence, credit: strip(r.creator?.username, 80) || 'unknown', url: `https://poly.pizza${r.url ?? ''}`, title: strip(r.title, 120), description: `A low-poly model: ${strip(r.title, 120)}.` }]
    })
  }

  async function smithsonian(q, n = 3) {
    const res = await get(`https://3d-api.si.edu/api/v1.0/content/file/search?${new URLSearchParams({ q, rows: '60' })}`, { headers: { 'user-agent': UA } })
    if (!res.ok) throw new Error(`Smithsonian 3D answered ${res.status}`)
    const byPackage = new Map()
    for (const r of (await res.json())?.rows ?? []) {
      const c = r.content ?? {}
      const pkg = c.model_url ?? /3d_package:[0-9a-f-]+/.exec(c.uri ?? '')?.[0]
      if (!pkg) continue
      const it = byPackage.get(pkg) ?? byPackage.set(pkg, {}).get(pkg)
      it.title ||= strip(r.title, 160)
      if (c.usage === 'Download3D' && c.file_type === 'glb' && !c.draco_compressed && !/draco/i.test(c.uri) && /low/i.test(c.quality ?? '')) it.glb = c.uri
      if (c.usage === 'Image2D' && c.quality === 'Thumb' && /\.jpe?g$/i.test(c.uri)) it.thumb = c.uri
    }
    return [...byPackage.entries()]
      .filter(([, it]) => it.glb)
      .slice(0, n)
      .map(([pkg, it]) => {
        const glb = remember(it.glb, 'glb')
        return { id: glb, kind: 'mesh', format: 'glb', file: glb, ...(it.thumb ? { thumb: remember(it.thumb, 'jpg') } : {}), source: 'Smithsonian 3D', license: 'CC0', credit: 'Smithsonian Institution', url: `https://3d.si.edu/object/${pkg.replace(/^3d_package:/, '')}`, title: it.title, description: `A scanned museum object: ${it.title}.` }
      })
  }

  /**
   * Candidates for a search, text only. `names` are structures to look up in
   * BodyParts3D (FMA or plain words); a source that cannot be reached is said
   * in `skipped` and the others still answer.
   */
  async function search(q, kind = 'mesh', { names = [] } = {}) {
    if (!libraries()) return { candidates: [], skipped: [{ source: 'the open libraries', reason: OFF }] }
    const words = String(q ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
    const asks = kind === 'plate' ? [['Wikimedia Commons', () => commons(words)]] : [['BodyParts3D', () => (names.length ? bodyParts(names) : [])], ['Poly Pizza', () => (words ? polyPizza(words) : [])], ['Smithsonian 3D', () => (words ? smithsonian(words) : [])]]
    const settled = await Promise.allSettled(asks.map(([, run]) => run()))
    const skipped = []
    const candidates = settled.flatMap((s, i) => {
      if (s.status === 'fulfilled') return s.value
      skipped.push({ source: asks[i][0], reason: String(s.reason?.message ?? s.reason).slice(0, 160) })
      log(`${asks[i][0]} skipped: ${skipped.at(-1).reason}`)
      return []
    })
    return { candidates, skipped }
  }

  return { search, file, bytes, image, remember, evict, times, dir, bodyParts, loadBp3d }
}

/** One store per folder in the process: the theme's route and Atlas's build read the same files. */
const STORES = new Map()
export const sharedAssetStore = (dir = join(getSundialRuntimeDir(), 'nodus-assets')) => STORES.get(dir) ?? STORES.set(dir, createAssetStore({ dir })).get(dir)

export function mountAssets(ctx, { store = null } = {}) {
  const assets = () => store ?? sharedAssetStore()
  // One prefix route: `/search`, and `/<id>` for a file. Behind the fence like every route.
  ctx.effect(() =>
    ctx.webServer.register(
      guard(ctx.connection, {
        kind: 'prefix',
        path: '/gnomon/api/assets',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const rest = url.pathname.slice('/gnomon/api/assets/'.length)
          try {
            if (rest === 'search') {
              const kind = url.searchParams.get('kind') === 'plate' ? 'plate' : 'mesh'
              const names = (url.searchParams.get('names') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 9)
              return sendJson(res, 200, await assets().search(url.searchParams.get('q') ?? '', kind, { names }))
            }
            if (!/^[0-9a-f]{32}$/.test(rest)) return sendJson(res, 404, { unavailable: 'No such asset.' })
            const f = await assets().file(rest)
            if (!f) return sendJson(res, 404, { unavailable: 'No such asset.' })
            // Content-addressed by where it came from: the bytes behind an id never change.
            res.writeHead(200, { 'content-type': f.type, 'content-length': f.size, 'cache-control': 'private, max-age=31536000, immutable' })
            createReadStream(f.path).pipe(res)
          } catch (error) {
            console.error(`[sundial-shell] ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`)
            if (!res.headersSent) sendJson(res, 502, { unavailable: 'That asset could not be fetched.' })
          }
        },
      }),
    ),
  )
}
