// Reads the client asks for by name: a tool from TOOL_REGISTRY (`gnomon_look`'s generic door), the global search, the reminders.
import { jsonOr, sendJson } from './http.js'
import { readSearch, searchLines } from './read-search.js'
import { wakeupsOf } from '@sundial/helpers/loops.js'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { executeGnomonTool, TOOL_REGISTRY, toolEnv } from '@sundial/kernel/tools/index.js'

export function mountRead(ctx, shell) {
  const { PLUGIN, api, selection } = shell

  /**
   * The record, for the owner's own hands.
   *
   * Explore runs the SAME read tools the model reads the record through, so
   * what the owner sees on a pane and what Gnomon can say are one record read
   * two ways. Restricted to tools that declare themselves read-only, by the
   * registry's own flag rather than a list here — a new read tool is
   * explorable the day it exists, and a write tool never is.
   */
  api('/gnomon/api/read', async (_req, res, url) => {
    const name = url.searchParams.get('tool') ?? ''
    const tool = TOOL_REGISTRY.find((candidate) => candidate.name === name)
    if (tool === undefined || tool.readOnly !== true) return sendJson(res, 404, { unavailable: 'Not a read tool.' })
    const args = jsonOr(url.searchParams.get('args') ?? '{}', undefined)
    if (args === undefined) return sendJson(res, 400, { unavailable: 'The arguments were not JSON.' })
    sendJson(res, 200, await executeGnomonTool(name, args, toolEnv(() => ctx.gnomonKernel.getState())))
  })

  /**
   * One search over everything Gnomon holds, answered twice: the hits, then a
   * reading of them.
   *
   * TWO CORPORA, ONE FIELD. The record (moments, facts, knowledge entries) and
   * the owner's own conversations with Gnomon are indexed by different
   * machinery and are deliberately not folded into one ranking — the retriever's
   * scoring was measured over the record, and mixing a literal text index into
   * it means re-measuring. They are searched together and shown apart, which is
   * also the truer reading: "what I did" and "what we said" are different kinds
   * of evidence and the owner should always know which they are looking at.
   *
   * WHY IT STREAMS. The searches are a linear scan and a text index — fast. The
   * reading is a model call and is not. One request that waited for both would
   * hold a list the owner could already have been reading. So this speaks the
   * same SSE grammar `/gnomon/api/live` and `/gnomon/api/turn` already do: a
   * `hits` frame the moment there are hits, a `reading` frame when the model
   * has answered, and `done`. No new concept, and no second route.
   *
   * WHY THE MODEL ONLY EVER SEES THE HITS. The reading is one bounded call over
   * the finalized result — not a turn, not an agent, no tools, no board
   * context, no transcript. It cannot search further, so it cannot cost more
   * than what is already on the owner's screen, and it cannot answer from
   * anything the owner is not also looking at. That second property is the
   * point: a reading that cites something absent from the list below it would
   * be unfalsifiable by the person reading it.
   *
   * It rides `ctx.llm.stream`, which means it passes through the SAME
   * `llm/stream` waterfall `gnomon-tools` installs — so it lands in `llm_audit`
   * and meters against the `ask` budget like every other call Gnomon makes.
   * Nothing here is off the ledger.
   */
  /**
   * How long the reading may take before the card stops waiting for it.
   *
   * Not a guess: the ledger has this same call answering in 8 s and in 62 s,
   * and once hanging 516 s before the provider gave up on its own. The hits are
   * already on screen throughout, so the cost of cutting a slow reading short
   * is one sentence, and the cost of not cutting it is a card that says
   * "Reading…" until the owner reloads. Bound it.
   */
  const SEARCH_READING_TIMEOUT_MS = 45_000

  api('/gnomon/api/search', async (_req, res, url) => {
    const query = (url.searchParams.get('q') ?? '').trim()
    if (query === '') {
      sendJson(res, 400, { unavailable: 'A search needs something to look for.' })
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    let gone = false
    res.on('close', () => {
      gone = true
    })
    const emit = (frame) => {
      if (gone || res.writableEnded) return
      try {
        res.write(`data: ${JSON.stringify(frame)}\n\n`)
      } catch {
        // The owner closed the card or searched again. Nothing to do.
      }
    }

    const hits = await readSearch({ query, state: ctx.gnomonKernel.getState(), sessionQuery: ctx.sessionQuery })
    const { record, conversations } = hits
    emit({ type: 'hits', ...hits })

    if (record.length === 0 && conversations.length === 0) {
      // Nothing to read. The empty list already says so, and a model asked to
      // summarise nothing writes an apology, which is worse than silence.
      emit({ type: 'done' })
      res.end()
      return
    }
    if (gone) return void res.end()

    const lines = searchLines(hits)

    // The owner closing the card also aborts the call: a reading nobody will
    // read is not worth finishing, and the provider is billed by the token.
    const stopReading = new AbortController()
    const tooLong = setTimeout(() => stopReading.abort(new Error('the model took too long')), SEARCH_READING_TIMEOUT_MS)
    res.on('close', () => stopReading.abort(new Error('the card was closed')))
    // Outside the try: an abort throws, and whatever the model had already
    // streamed is still the best answer available.
    let text = ''
    try {
      for await (const chunk of ctx.llm.stream({
        ...selection(),
        signal: stopReading.signal,
        messages: [
          createSystemMessage(
            [
              "You are Gnomon, reading back what a search of the owner's own record just returned. Address the owner as 'you'.",
              'Answer their search in at most three sentences: what the results show about it, and the one thing worth noticing. Name the specific projects, people, tools and days that appear in the results.',
              'Every result you were given is listed on screen directly beneath your answer, so never enumerate them and never repeat a line verbatim — say what they add up to.',
              'These results are ALL you have. Do not add anything you were not given, do not guess at what is missing, and do not offer to search again.',
              'Results tagged [conversation] are things said in chat; every other tag is observed activity. Keep the difference when it matters.',
              'If the results do not actually answer the search, say so plainly in one sentence instead of forcing a summary. Plain prose, no markdown, no headings, no lists.',
            ].join(' '),
          ),
          createUserMessage({ content: [{ type: 'text', text: `Search: ${query}\n\nResults:\n${lines.join('\n')}` }], source: { kind: 'user' } }),
        ],
      })) {
        if (gone) break
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
          throw new Error(chunk.reason.failure?.message ?? 'the model call failed')
        }
      }
      // Cut short with words already streamed: that partial sentence IS the
      // reading, and showing it beats replacing it with a timeout notice.
      emit(text.trim() === '' ? { type: 'reading', unavailable: 'The model returned nothing.' } : { type: 'reading', text: text.trim() })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${PLUGIN}] search reading failed: ${message}`)
      // The hits are already on screen and are the durable half of the answer;
      // a failed reading says so in its own seat rather than replacing them.
      // A reading that got most of the way there is still worth reading, so it
      // ships with the cut marked rather than being thrown away for a notice.
      emit(text.trim() === '' ? { type: 'reading', unavailable: `Gnomon could not read these: ${message}` } : { type: 'reading', text: `${text.trim()} …[cut short: ${message}]` })
    } finally {
      clearTimeout(tooLong)
    }
    emit({ type: 'done' })
    res.end()
  })

  // What Gnomon has set itself to come back to (gnomon_schedule_wakeup), for the Work card.
  api('/gnomon/api/wakeups', async (_req, res) => sendJson(res, 200, { open: wakeupsOf(ctx.gnomonKernel.getState()) }))
}
