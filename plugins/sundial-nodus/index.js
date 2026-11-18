// sundial-nodus: registers gnomon_visualize, Gnomon's way of drawing the
// record as a Nodus card, and the route gate that draws when a figure is the
// better answer whatever the words. The engine is packages/nodus; the card is
// drawn by the web client (the theme serves the engine's browser modules as
// they are).
//
// Named exports only: a default export drops `inject`.
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { executeGnomonTool, toolEnv } from '@sundial/kernel/tools/index.js'
import { runAuditedLlmCall } from '@sundial/llm/audited-call.js'
import { getSundialRuntimeDir } from '@sundial/helpers/sundial-paths.js'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'
import { localDate } from '@sundial/helpers/local-day.js'
import { computeEmbedding } from '@sundial/memory/local-embedding.js'
import { createManager } from '@sundial/nodus/orchestrate.js'
import { isOwnerMessage, textOf } from '../sundial-theme/shell/frames.js'
import { post, readJson, route, sendJson } from '../sundial-theme/host/http.js'
import { sharedAssetStore } from '../sundial-theme/host/api-assets.js'
import { CHOICES, MODES, SWITCH } from '@sundial/nodus/modes/index.js'
import { createGate } from './gate.js'
import { createLibrary } from './library.js'
import { createPlacer, createThreadModes, settleOrphans, createVisualize, DESCRIPTION, engineHands, PARAMETERS, screenOf, summaryOf, VISUALIZE_TOOL_NAME } from './visualize.js'

export const name = 'sundial-nodus'
// gnomonDb: the ledger row is written through @sundial/db's singleton, which that plugin opens.
// webServer and connection: the thread's mode switch and the card's Try in another mode, behind the theme's fence.
export const inject = ['tools', 'gnomonKernel', 'gnomonDb', 'webServer', 'connection']

export function apply(ctx) {
  const kernel = ctx.gnomonKernel
  const read = (tool, args) => executeGnomonTool(tool, args, toolEnv(() => kernel.getState()))
  const today = () => localDate(new Date().toISOString(), loadSundialConfig().timezone)
  const library = createLibrary({ file: join(getSundialRuntimeDir(), 'nodus-library.jsonl'), embed: computeEmbedding })
  // One manager for the tool and the gate, so a figure both ask for is built once.
  // assets: Atlas's store, the same one the theme's asset route serves.
  const manager = createManager({ read, ...engineHands({ kernel, call: runAuditedLlmCall }), assets: sharedAssetStore(), examples: library.like, reuse: library.reuse, screen: () => screenOf(kernel.getState()) }, { today })
  // One placer too: a card the gate placed and the tool asked for again is the same card.
  const place = createPlacer({ kernel, library, emit: (board) => ctx.emit('gnomon/board', board) })
  // Each thread's way of drawing, set in the thread bar; the gate and the tool both read it.
  const modes = createThreadModes({ file: join(getSundialRuntimeDir(), 'nodus-thread-modes.json') })
  const canPlace = () => (kernel.getState()?.settings?.autonomy ?? 'act') === 'act'
  const gate = createGate({ manager, place, canPlace, isOwner: isOwnerMessage, textOf, modeFor: modes.get })
  const execute = createVisualize({ kernel, read, call: runAuditedLlmCall, manager, library, today, place, emit: (board) => ctx.emit('gnomon/board', board), takeOver: gate.takeOver, shapeFor: gate.shapeFor, join: gate.join, modeFor: modes.get })
  mountModes(ctx, { modes, manager, place, canPlace })
  settleOrphans(kernel)
  ctx.tools.register(
    defineTool({
      name: VISUALIZE_TOOL_NAME,
      description: DESCRIPTION,
      parameters: PARAMETERS,
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        // The model reads the walk it is about to point at, never the whole spec.
        render: (_args, value) => [{ type: 'text', text: value.done ? JSON.stringify({ ...value, spec: undefined }) : `Not drawn: ${value.reason}` }],
      },
      execute,
    }),
  )
  ctx.on('session/event', gate)
  console.log(`[sundial-nodus] gnomon_visualize registered; route gate on; library holds ${library.size()} walk(s)`)
}

/**
 * The page's two doors to the modes. `/gnomon/api/nodus-mode`: a thread's
 * choice and which modes are there (GET `?session=`), or a new choice (POST
 * `{ sessionId, mode }`). `/gnomon/api/nodus-try`: draw an ask in a mode
 * outside a turn, `{ ask, mode, near?, id?, preview? }`: placed beside `near`,
 * or on card `id` again (Retry), or only returned (`preview`, the catalogue).
 */
function mountModes(ctx, { modes, manager, place, canPlace }) {
  route(ctx, '/gnomon/api/nodus-mode', async (req, res, url) => {
    let chosen = null
    if (req.method === 'POST') {
      const body = await readJson(req, 2048).catch(() => null)
      if (!modes.set(body?.sessionId, body?.mode)) return sendJson(res, 400, { unavailable: `A choice needs a thread and one of ${CHOICES.join(', ')}.` })
      chosen = body.sessionId
      console.log(`[sundial-nodus] thread ${body.sessionId} now draws in ${body.mode}`)
    }
    // A POST answers with the thread's mode as now kept, so the switch marks what the server holds.
    const session = req.method === 'POST' ? chosen : url.searchParams.get('session')
    const ready = Object.fromEntries(await Promise.all(Object.values(MODES).map(async (m) => [m.id, await m.ready()])))
    sendJson(res, 200, { mode: session ? modes.get(session) : undefined, modes: SWITCH.map((m) => ({ ...m, ready: m.id === 'auto' || ready[m.id] })) })
  }, 'sundial-nodus')
  post(ctx, '/gnomon/api/nodus-try', { limit: 4096 }, async (body) => {
    const ask = typeof body.ask === 'string' ? body.ask.trim().slice(0, 400) : ''
    if (ask === '' || !CHOICES.includes(body.mode)) return 'A try needs an ask and a mode.'
    const preview = body.preview === true
    if (!preview && !canPlace()) return [403, { unavailable: 'Board staging is off: nothing can be placed.' }]
    const out = await manager.drawIn({ ask, mode: body.mode, ...(body.mode === 'sketch' ? {} : { view: 'free' }) })
    if (!out.ok) return [200, { done: false, reason: out.reason }]
    if (preview) return { done: true, spec: out.later ? (await out.later).spec ?? out.spec : out.spec }
    const id = await place(out, { near: typeof body.near === 'string' ? body.near : undefined, id: typeof body.id === 'string' && body.id.startsWith('nodus:') ? body.id : undefined })
    return { done: true, id, ...summaryOf(out.spec) }
  })
}
