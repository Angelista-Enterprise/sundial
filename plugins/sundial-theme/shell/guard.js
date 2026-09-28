// The fence in front of every route Sundial registers on dsh's web server.
//
// dsh guards its own /api with `connection.requestRejection` (a Host/Origin/
// Sec-Fetch fence plus a signed, SameSite=Strict session cookie) and its index
// with `connection.authorizeIndex` (the launch-token → cookie exchange). The web
// server itself knows nothing about either, so a route registered directly on it
// is open to any page in the browser (CSRF) and to DNS rebinding. Every route
// here goes through `guard` instead, so the check cannot be forgotten per route.
//
// One exemption: this process calling its own routes over loopback (card readers
// in sundial-tools). Those send a per-process secret no browser can know.
import crypto from 'node:crypto'

const INTERNAL_HEADER = 'x-sundial-internal'

/** The per-process secret for in-process callers. Minted once, never written anywhere. */
export function internalToken() {
  process.env.SUNDIAL_INTERNAL_TOKEN ||= crypto.randomBytes(32).toString('hex')
  return process.env.SUNDIAL_INTERNAL_TOKEN
}

/** Headers an in-process caller adds to reach a guarded route. */
export function internalHeaders() {
  return { [INTERNAL_HEADER]: internalToken() }
}

function isInternal(req) {
  const sent = req.headers?.[INTERNAL_HEADER]
  if (typeof sent !== 'string') return false
  const a = Buffer.from(sent)
  const b = Buffer.from(internalToken())
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '')
  return a.length === b.length && crypto.timingSafeEqual(a, b) && (host === '127.0.0.1' || host === 'localhost' || host === '[::1]')
}

/**
 * Why this request may not proceed: 403 (wrong Host/Origin, cross-site), 401
 * (no session cookie), or undefined when it may. Without a `connection`
 * service (a test harness) every request is refused — failing closed.
 */
export function rejection(connection, req) {
  if (isInternal(req)) return undefined
  if (typeof connection?.requestRejection !== 'function') return 403
  return connection.requestRejection(req)
}

/** Wrap a route so its handler runs only for an authenticated, same-origin request. */
export function guard(connection, route) {
  const handler = route.handler
  return {
    ...route,
    handler: async (req, res) => {
      const status = rejection(connection, req)
      if (status !== undefined) {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(status === 401 ? 'Sundial needs you to sign in: run `sundial open` in a terminal.\n' : 'forbidden\n')
        return
      }
      return handler(req, res)
    },
  }
}

/** The page route: the launch-token exchange on `/`, the session cookie everywhere else. */
export function guardPage(connection, route) {
  const handler = route.handler
  return {
    ...route,
    handler: async (req, res) => {
      if (typeof connection?.authorizeIndex !== 'function') {
        res.writeHead(403).end()
        return
      }
      const status = rejection(connection, req)
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.searchParams.has('token') || status === 401) {
        // authorizeIndex answers the token exchange (303 to a clean `/`) or a
        // 401 itself; it returns true only for a request it lets through.
        if (status === 403 || !connection.authorizeIndex(req, res)) {
          if (!res.headersSent) res.writeHead(403).end()
          return
        }
      } else if (status !== undefined) {
        res.writeHead(status).end()
        return
      }
      return handler(req, res)
    },
  }
}
