// @sundial/dsh-theme (host half) — mounts Gnomon's own client (host/server.js)
// and the routes behind it, which live in host/: routes-*.js register views and
// appends, read-*.js are the selectors the views read, http.js is the shared
// grammar (sendJson, readJson, view, spanFrom). The routes project what the
// rest of the system already decided with — the dial is the composer
// `gnomon_compose_figure` calls, the ledger reads `llm_audit` — and keep no
// counters or state of their own.
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountShell } from './host/server.js'
import { mountInstruments } from './host/routes-instruments.js'
import { mountProposals } from './host/routes-proposals.js'
import { mountPeople } from './host/routes-people.js'
import { mountBrief } from './host/routes-brief.js'
import { mountToday } from './host/routes-today.js'
import { readPath, route } from './host/http.js'

export const name = 'sundial-theme'
// `agents` + `agentDefaultModel` are what host/server.js drives sessions with —
// the same two services sundial-proactive injects to own its companion.
//
// A note on the name. This package stopped being "the theme" some time ago: it
// serves Today, the Ledger, six instruments, and the conversation shell. It is the
// Gnomon web UI. Renaming it means touching the profile's link list in
// $SUNDIAL_HOME/dsh/profiles/web/package.json, which is a machine-level file outside the
// repo, so the debt is recorded here rather than paid halfway.
// `gnomonDb` is injected but unused directly: it is what guarantees the DB is
// open and migrated before `composeFigure` reads through it.
// `gnomonKernel` is read for ONE thing: the open research goal on
// `state.mind.goals`, which is live state rather than anything the DB holds —
// a goal is a working intention, and only the closed ones leave a durable
// trace (as the `self-report` notice they produce).
// `sessionProjectionCache` is dsh 0.1.5's persisted projection cache and it is
// what makes the sidebar cheap — see `listHint` in host/api-sessions.js. Declared
// rather than read opportunistically on purpose: without it the list silently
// falls back to reading 185 whole session logs, which is a four-second stall
// that looks like nothing in particular. A missing service should say so.
export const inject = [
  'webServer',
  'connection',
  'gnomonDb',
  'gnomonKernel',
  'agents',
  'agentDefaultModel',
  'sessionQuery',
  'sessionPersistence',
  'sessionProjectionCache',
  'llm',
  'tools',
  'gnomonReach',
]

const HERE = dirname(fileURLToPath(import.meta.url))
const FONT_PATH = join(HERE, 'assets', 'InterTight-Variable.ttf')

export function apply(ctx) {
  // Every route goes through the fence (host/guard.js, by way of host/http.js): a same-origin, signed-in browser.
  // Gnomon's own client, at `/`. See host/server.js for why leaving dsh's web
  // app is one route registration rather than a fork: its SPA is whoever claims
  // the web server's FALLBACK seat, and a named exact route is matched first.
  mountShell(ctx, { cwd: process.cwd() })
  // The views, for in-process readers (sundial-tools' card readers): no loopback, no token.
  ctx.provide('gnomonReads', { read: readPath })

  // Content-addressed by version in practice (the file changes with the plugin); a missing face
  // degrades to the fallback stack, so it answers 404 rather than 500.
  route(ctx, '/gnomon/font/inter-tight.ttf', async (_req, res) => {
    const font = await readFile(FONT_PATH).catch((error) => console.warn(`[sundial-theme] could not read the bundled face: ${error.message}`))
    if (!font) return res.writeHead(404).end()
    res.writeHead(200, { 'content-type': 'font/ttf', 'cache-control': 'public, max-age=31536000, immutable' })
    res.end(font)
  })

  mountToday(ctx)
  mountBrief(ctx)
  mountPeople(ctx)
  mountProposals(ctx)
  mountInstruments(ctx)
}
