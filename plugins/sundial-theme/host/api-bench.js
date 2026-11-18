// Bench mode (docs/release/27 section 1.7, C and E): a public benchmark's own events entering the bench install's
// record the way a sensor's do. POST /gnomon/api/bench/ingest { type, payload, ts? } appends one signal through the
// kernel's own appendSignal (sanitized at ingest, folded, effects run), so a memory or a notice benchmark is measured
// on Sundial's real path. Refused (403) unless this install is the bench (bench-guard.js), and only for the few
// types a bench feeds: on the owner's install it writes nothing, ever.
import { benchRefusal } from './bench-guard.js'
import { post } from './http.js'

/** What a bench may write: an owner chat turn and Gnomon's reply (LongMemEval), a clock tick (a day boundary), a window (ProactiveBench). */
export const BENCH_TYPES = new Set(['chat:owner', 'chat:said', 'clock:tick', 'window:changed'])

export function mountBench(ctx, { refusal = benchRefusal } = {}) {
  post(ctx, '/gnomon/api/bench/ingest', { limit: 65_536, method: 'Ingesting takes a POST.' }, async (body) => {
    const refused = refusal()
    if (refused !== null) {
      console.warn(`[sundial-shell] a bench ingest was refused: ${refused}`)
      return [403, { unavailable: `Bench ingest is refused here: ${refused}.` }]
    }
    const type = typeof body.type === 'string' ? body.type : ''
    if (!BENCH_TYPES.has(type)) return `A bench writes ${[...BENCH_TYPES].join(', ')} only.`
    const payload = body.payload !== null && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : {}
    const ts = typeof body.ts === 'string' && !Number.isNaN(Date.parse(body.ts)) ? new Date(body.ts).toISOString() : undefined
    await ctx.gnomonKernel.appendSignal(type, payload, ts)
    return { ingested: true, type, ...(ts ? { ts } : {}) }
  })
}
