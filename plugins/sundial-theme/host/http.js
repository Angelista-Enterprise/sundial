// The host's shared HTTP grammar: one JSON writer, one bounded body reader, one
// read-only view, and the board's span. Every route file imports these rather
// than keeping a copy (W4 step 4).
import { guard } from './guard.js'
import { liveSpan } from '../shell/span.js'
import { localDate } from '@sundial/helpers/local-day.js'

export function sendJson(res, status, body) {
  // A cached answer is a lie about the present, which is what every route here is about.
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * Read one JSON body, bounded. Null when it is not JSON; throws with `status`
 * 413 past `limit` and 400 when the request cannot be read.
 */
export async function readJson(req, limit = 262_144) {
  const body = await readText(req, limit)
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

async function readText(req, limit) {
  try {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > limit) throw Object.assign(new Error('too large'), { status: 413 })
    }
    return body
  } catch (error) {
    throw error?.status ? error : Object.assign(new Error('unreadable'), { status: 400 })
  }
}

/**
 * Every view's read, by path. In-process readers (the card readers behind `gnomon_look`) call
 * `readPath` through the theme's `gnomonReads` service instead of fetching the loopback (W4 step 10).
 */
export const READS = new Map()

/** Read a view by its path and query, as the route would answer it. */
export async function readPath(path) {
  const url = new URL(path, 'http://127.0.0.1')
  const read = READS.get(url.pathname)
  if (read === undefined) throw new Error(`${url.pathname} is not a read`)
  return read(url)
}

/** One read-only JSON route behind the fence: `read(url)` answers, a failure says `unavailable`. */
export function view(ctx, path, unavailable, read) {
  READS.set(path, read)
  ctx.effect(() =>
    ctx.webServer.register(
      guard(ctx.connection, {
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            sendJson(res, 200, await read(new URL(req.url ?? '/', 'http://127.0.0.1')))
          } catch (error) {
            console.error(`[sundial-theme] ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
            sendJson(res, 500, { unavailable })
          }
        },
      }),
    ),
  )
}

/** Any route behind the fence: `handler(req, res, url)`; a throw answers 500 (or ends a stream already begun). */
export function route(ctx, path, handler, plugin = 'sundial-shell') {
  ctx.effect(() =>
    ctx.webServer.register(
      guard(ctx.connection, {
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            await handler(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'))
          } catch (error) {
            console.error(`[${plugin}] ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
            if (!res.headersSent) sendJson(res, 500, { unavailable: 'Gnomon could not answer that.' })
            else if (!res.writableEnded) res.end()
          }
        },
      }),
    ),
  )
}

/**
 * The owner's write: a POST whose body `handle(body, url)` validates, then appends. It returns the
 * answer, a string saying what is wrong (400), or `[status, body]`. Anything but a POST is told `method` (405).
 */
export function post(ctx, path, { limit = 4096, method = 'This takes a POST.', tooLong = 'That is too long.' }, handle) {
  route(ctx, path, async (req, res, url) => {
    if (req.method !== 'POST') return sendJson(res, 405, { unavailable: method })
    let body
    try {
      body = (await readJson(req, limit)) ?? {}
    } catch (error) {
      return sendJson(res, error.status ?? 400, { unavailable: error.status === 413 ? tooLong : 'That could not be read.' })
    }
    const answer = await handle(body, url)
    if (Array.isArray(answer)) return sendJson(res, answer[0], answer[1])
    sendJson(res, typeof answer === 'string' ? 400 : 200, typeof answer === 'string' ? { unavailable: answer } : answer)
  })
}

/** `JSON.parse(text)`, or `fallback` when it is not JSON. */
export function jsonOr(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** A day in the owner's own local reckoning (`config.timezone`, not the machine's), which is what the dial is keyed by. */
export const today = (timeZone, now = new Date()) => localDate(now.toISOString(), timeZone)

/** Calendar-day arithmetic on a `YYYY-MM-DD` — never 24h subtraction, which drifts across DST. */
export function shiftDate(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10)
}

/**
 * WHEN a request is about: the board's own span unless the caller named one.
 *
 * Every route used to answer for its own idea of time — `date` defaulting to
 * today, `days` defaulting to 14 or 60, the ledger with a private `window` of
 * its own — so the same board could show one card's Tuesday beside another
 * card's fortnight and nothing on screen said so. The span lives in the record
 * (`state.board.span`), so this is the one place that reads it.
 *
 * An explicit query parameter still WINS: a card may pin itself to a span and
 * say so, `gnomon_look`'s readers pass their own, and a route called directly
 * should answer exactly what it was asked. The board span is a default.
 *
 * Returns inclusive owner-local dates plus the two shapes callers speak: `date`
 * is the last day of the span (what a day-bound card shows), `days` the count.
 */
export function spanFrom(url, getState, fallbackDays = 1, now = new Date()) {
  const state = getState()
  const day = today(state?.config?.timezone, now)
  // A preset is resolved against today, not read as the dates it was set on.
  const span = liveSpan(state?.board?.span ?? null, day)
  const asked = { date: url.searchParams.get('date'), days: Number(url.searchParams.get('days')) || 0 }
  const to = asked.date || span?.to || day
  const days = asked.days > 0 ? asked.days : asked.date ? 1 : span ? Math.max(1, Math.round((Date.parse(`${span.to}T00:00:00Z`) - Date.parse(`${span.from}T00:00:00Z`)) / 86_400_000) + 1) : fallbackDays
  const from = shiftDate(to, -(days - 1))
  return { from, to, days, date: to, label: span?.label ?? null, pinned: Boolean(asked.date || asked.days > 0) }
}
