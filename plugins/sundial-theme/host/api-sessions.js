// The conversation's routes: the thread list and one thread's log, new, archive and delete, a turn
// and everything a turn can be asked (attach, bring, compact, question, stop, approve, watch), the model.
import { post, readJson, sendJson, view } from './http.js'
import { readModels } from './read-models.js'
import { readSession } from './read-session.js'
import { readFile, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname } from 'node:path'
import { COMPANION_SESSION_ID, TURN_IDLE_MS } from '@sundial/helpers/vocab.js'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { replayFrames, titleFrom } from '../shell/frames.js'
import { forget, readArchive, setArchived } from './archive.js'
import { readTitles, writeTitles } from './session-titles.js'

/** A turn that produces nothing for this long has stopped being a turn. */
/** How much of a side thread rides into the conversation when it is brought in. */
const BRING_CHARS = 6000

/** A manual compaction summarizes the transcript with one model call; past this it has failed rather than being slow. */
const COMPACT_TIMEOUT_MS = 180_000

/**
 * The projection units the sidebar reads, and the only ones it asks for: a
 * selected read views those rows and leaves every other unit's wire value
 * unproduced.
 */
const LIST_PROJECTIONS = ['title', 'sessionListMetadata', 'turnOutline']

/**
 * A presented file this big is not something to push through a browser tab —
 * the route reads it into memory to send it, and a deliverable is meant to be
 * a result, not a dataset. Past this the owner is told where it is instead.
 */
const MAX_DELIVERABLE_BYTES = 64 * 1024 * 1024

/** Per turn. The store allows twenty per message; a chat composer wants far fewer. */
const MAX_IMAGES_PER_TURN = 4

/** Above the attachment store's own default per-image ceiling, so its validator is what refuses and says why. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

/**
 * Sessions Gnomon itself owns. Archivable — the owner may hide them — but NEVER
 * deletable through this shell, live or not.
 *
 * The first version guarded only a LIVE agent. Both of these are built lazily
 * (the companion on its first notice, the ask agent on its first question), so
 * after a restart neither is live, `ctx.agents.get()` finds nothing, and the
 * guard let a delete through. It deleted them. The companion's transcript —
 * every unprompted thing Gnomon had said and every reply — was lost to a test
 * that expected a refusal. Ownership is a property of the id, not of whether
 * the process happens to have woken it yet.
 */
const OWN_SESSIONS = new Set([COMPANION_SESSION_ID])

export function mountSessions(ctx, shell) {
  const { PLUGIN, agentFor, api, briefMessage, handles, home, live, openAsk, openQuestions, pending, readSnapshot, rememberedModel, selection, snapshot, snapshots, stoppers, threadModel, threadModels, turnClosed, turnOpened, turning, waiting, watch } = shell

  /**
   * One session's list facts WITHOUT reading its log.
   *
   * dsh 0.1.5 persists every projection unit's fold to `~/.dsh/storages`, and
   * `cachedSnapshot` is that cache's zero-I/O listing read: synchronous, off
   * the storage domain's in-memory state, as stale as the last checkpoint but
   * never wrong (the header is the identity witness, so a recreated id cannot
   * be served another log's state).
   *
   * `inheritedEventCount` completes the checkpoint identity and is Session
   * state, not header metadata, so it is not on a listed record. A session
   * that is not a fork has none — the offset is exactly 0 — and a seeded one
   * skips this rung rather than guessing a prefix length.
   *
   * Expect this to MISS for a while. 0.1.5 widened the cache's identity (it
   * now binds format version, seeding and inherited prefix as well as
   * createdAt and cwd), so every row written by rc.6 is correctly refused
   * rather than trusted, and a record only gains the new shape when its
   * session is next written. Nothing here can warm the other rows: the
   * sidebar reads and never writes. The batched path below is what has to be
   * fast, and this rung is the bonus that grows over time.
   */
  const listHint = (header) => {
    if (header.isSeeded === true) return null
    try {
      const snapshot = ctx.sessionProjectionCache.cachedSnapshot(header, SessionLogOffset(0), LIST_PROJECTIONS)
      if (snapshot === undefined) return null
      const meta = snapshot.values.sessionListMetadata
      return {
        // `title` is the wire shape the list rows want already: a plain string
        // or null. A session Gnomon has spoken in since the upgrade also has a
        // turnOutline, whose first entry carries a bounded prompt preview —
        // a better name than the id for a thread the titler never got to.
        title: snapshot.values.title ?? snapshot.values.turnOutline?.[0]?.prompt ?? '',
        blank: meta?.blank === true,
        lastPromptAt: meta?.lastPromptAt ?? null,
      }
    } catch {
      // A cache that cannot answer is not an error, only a slower path.
      return null
    }
  }

  /** The sidebar: every session, newest first, named by something a human can read. */
  // A session that is not live is a closed file: its log cannot gain a word, so
  // the title read off it is the same answer every time. Only the answer is
  // kept, including the empty one — the corpus here is ~190 sessions and the
  // comment below explains that almost none of them yield a name, so it is the
  // fruitless reads that cost the second, and they are the ones worth not
  // repeating. A live session is never cached; it is still being written.
  //
  // Loaded from disk so it survives a restart: the first listing after login is
  // the one the owner actually waits on, and without this it paid the whole
  // ~1.5 seconds every single login. See session-titles.js for the safety rules.
  const titleMemo = readTitles(home)
  /** Written only when the map changed — a listing that learns nothing writes nothing. */
  const saveTitles = () => {
    try {
      writeTitles(home, titleMemo)
    } catch (error) {
      // A cache that cannot be written is a slower next boot, not a failure.
      console.error(`[${PLUGIN}] session titles could not be cached: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  /** This server just wrote to that session: whatever it was called may have changed. */
  const forgetTitle = (id) => {
    if (titleMemo.delete(id)) saveTitles()
  }

  view(ctx, '/gnomon/api/sessions', 'Gnomon could not answer that.', async () => {
    const records = await ctx.sessionQuery.listSessions()
    const archived = readArchive(home)

    const hints = new Map()
    for (const record of records) {
      const hint = listHint(record.header)
      if (hint !== null) hints.set(record.header.id, hint)
    }

    // Everything the cache could not answer, in ONE batched observation of the
    // corpus — `readTitleSnapshots` folds every requested session's title from
    // a single cancellable pass.
    //
    // This is where the four seconds were, and it was never one slow read: it
    // was the shape. A `readTitle` per session, and then, for each of the fifty
    // that came back empty, a read of that session's ENTIRE log to look for the
    // first thing the owner said.
    //
    // That second read is gone rather than batched. Measured over all 185
    // sessions here, it found a name in exactly ZERO of them: every session dsh
    // never titled has three or four events in it — created, never spoken in —
    // so the read was guaranteed waste, repeated on every single load. A
    // session that really does have words and no title is still named exactly,
    // just one step later: `/gnomon/api/session` derives the title from the
    // whole log when the owner opens it, and that read was happening anyway.
    const isLive = new Map(records.map((record) => [record.header.id, record.live === true]))
    // A live session's log is still growing, so anything remembered about it is
    // suspect — and a session Gnomon deleted should not keep a row in the file
    // for ever. Both are dropped before the cache is consulted.
    let changed = false
    for (const id of [...titleMemo.keys()]) {
      if (isLive.get(id) !== false && titleMemo.delete(id)) changed = true
    }

    const derived = new Map([...titleMemo])
    const cold = records.map((record) => record.header.id).filter((id) => !hints.has(id) && !titleMemo.has(id))
    if (cold.length > 0) {
      for (const result of await ctx.sessionQuery.readTitleSnapshots(cold)) {
        // Per-session failures are isolated by contract; such a row keeps the
        // id as its name, exactly as it did before. A failure is not memoised —
        // it says nothing durable about the file.
        if (result.status !== 'fulfilled') continue
        const title = result.value.title?.title?.trim() ?? ''
        if (title !== '') derived.set(result.sessionId, title)
        if (isLive.get(result.sessionId) === false) {
          titleMemo.set(result.sessionId, title)
          changed = true
        }
      }
    }
    if (changed) saveTitles()

    const rows = records.map((record) => {
      const header = record.header
      const id = header.id
      const hint = hints.get(id)
      return {
        id,
        title: hint?.title || derived.get(id) || '',
        createdAt: header.createdAt ?? null,
        live: record.live === true,
        // The thread's own model when it is live and chose one; null says "the default, as far as this list knows".
        model: threadModel(id)?.model ?? null,
        archived: archived.has(id),
        // Both come from the cache only, so they are hints and not facts about
        // every row. The client uses `blank` to say "empty" instead of
        // "Untitled session", which is the honest name for a thread with no
        // turn in it; a row without the hint keeps the old wording.
        blank: hint?.blank ?? null,
        lastPromptAt: hint?.lastPromptAt ?? null,
      }
    })
    rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    return { sessions: rows, model: selection().model ?? null }
  })

  /**
   * Archive or restore. A UI fact, not a log fact: the sessions are untouched,
   * so this costs nothing and restoring is exact. See archive.js.
   */
  post(ctx, '/gnomon/api/sessions/archive', { limit: 65_536, method: 'Archiving takes a POST.' }, async (body) => {
    const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string') : []
    if (ids.length === 0) return 'Which sessions?'
    return { archived: [...setArchived(home, ids, body.archived !== false)] }
  })

  /**
   * Delete — the one irreversible thing this shell does, so it is the one place
   * that refuses.
   *
   * A session with a live agent this shell created is disposed first, which
   * stops the driver and removes it from the store; then the backend's artefact
   * is removed through `locate()`, never by guessing a path. A session whose
   * live agent belongs to someone else — the companion, the ask channel — is
   * REFUSED with the reason: Gnomon is using it, and pulling its file out from
   * under an appending writer would corrupt the record it is mid-sentence in.
   */
  api('/gnomon/api/sessions/delete', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Deleting takes a POST.' })
      return
    }
    const body = await readJson(req, 65_536)
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === 'string' && id !== '') : []
    if (ids.length === 0) {
      sendJson(res, 400, { unavailable: 'Which sessions?' })
      return
    }

    for (const id of ids) snapshots.delete(id)
    const headers = new Map((await ctx.sessionQuery.listSessions()).map((record) => [record.header.id, record.header]))
    const deleted = []
    const refused = []

    for (const id of ids) {
      // Refused by IDENTITY, before anything is looked up. See OWN_SESSIONS.
      if (OWN_SESSIONS.has(id)) {
        refused.push({ id, reason: `${id} is Gnomon's own session. Archive it if you do not want to see it.` })
        continue
      }
      const live = ctx.agents.get(SessionId(id))
      if (live !== undefined && live.status !== 'disposed') {
        const dispose = handles.get(id)
        if (dispose === undefined) {
          refused.push({ id, reason: 'Another part of Gnomon is driving this session right now.' })
          continue
        }
        try {
          await dispose()
        } catch (error) {
          refused.push({ id, reason: `Could not close it: ${error instanceof Error ? error.message : String(error)}` })
          continue
        }
        handles.delete(id)
      }

      const header = headers.get(id)
      const location = header === undefined ? undefined : ctx.sessionPersistence.locate(header)
      if (location === undefined) {
        // Not on disk and not live: nothing to delete, and nothing to refuse.
        // The archive is still cleaned so it does not name a ghost.
        deleted.push(id)
        continue
      }
      try {
        // The jsonl backend keeps each session in its own directory named by
        // the id, with the artefact inside. Remove the directory when it IS the
        // session's own; otherwise only the artefact, so a shared directory is
        // never taken out with it.
        const target = location.path
        const parent = dirname(target)
        const isFile = (await stat(target)).isFile()
        await rm(isFile && basename(parent) === id ? parent : target, { recursive: true, force: true })
        deleted.push(id)
      } catch (error) {
        refused.push({ id, reason: `Could not remove it: ${error instanceof Error ? error.message : String(error)}` })
      }
    }

    if (deleted.length > 0) {
      forget(home, deleted)
      // W1 step 8: the log and the ledger forget the thread too (`conversationTrack` → DeleteRows{sessionId}).
      for (const id of deleted) await ctx.gnomonKernel.appendSignal('chat:forget', { sessionId: id }).catch((error) => console.warn(`[${PLUGIN}] chat:forget ${id}: ${error.message}`))
      console.log(`[${PLUGIN}] deleted ${deleted.length} session(s)`)
    }
    sendJson(res, 200, { deleted, refused })
  })

  /** One session's whole transcript, as the frames that redraw it. */
  api('/gnomon/api/session', async (_req, res, url) => {
    const id = url.searchParams.get('id') ?? ''
    if (id === '') return sendJson(res, 400, { unavailable: 'Which session?' })
    sendJson(res, 200, await readSession({ id, all: url.searchParams.get('all') === '1', model: selection().model ?? null, readSnapshot }))
  })

  /**
   * Hand over one file Gnomon presented.
   *
   * THE SESSION LOG IS THE ALLOWLIST, and that is the whole security design.
   * This route serves a path only when that exact string appears in a
   * `deliverables/presented` event in the named session — an event dsh appends
   * only after its `present` tool resolved the path through the sandboxed
   * `ctx.fs` and confirmed an existing regular file. So a servable path was
   * chosen by the model, checked by dsh's sandbox, and recorded durably,
   * before this route will look at it.
   *
   * There is deliberately no path handling here: no joining, no normalizing,
   * no `..` stripping, no root prefix check. Every one of those is a way to be
   * clever about an attacker-supplied string, and none is needed — an exact
   * match against a recorded delivery cannot be talked into a traversal. If
   * the string is not in the log, the answer is 404 and nothing is read.
   *
   * The bytes are read at request time, never at present time: dsh's contract
   * is that the owner opens the CURRENT file, so what they get is what is
   * there when they click, and a file since deleted is an honest 404.
   */
  api('/gnomon/api/deliverable', async (req, res, url) => {
    const id = url.searchParams.get('session') ?? ''
    const wanted = url.searchParams.get('path') ?? ''
    if (id === '' || wanted === '') {
      sendJson(res, 400, { unavailable: 'Which file, from which session?' })
      return
    }

    const snapshot = await readSnapshot(id)
    const presented = new Set()
    for (const event of snapshot.events ?? []) {
      if (event?.type !== 'deliverables/presented') continue
      for (const file of event.data?.files ?? []) {
        if (typeof file?.path === 'string') presented.add(file.path)
      }
    }
    if (!presented.has(wanted)) {
      sendJson(res, 404, { unavailable: 'Gnomon did not hand you that file.' })
      return
    }

    let info = null
    try {
      info = await stat(wanted)
    } catch {
      info = null
    }
    if (info === null || !info.isFile()) {
      sendJson(res, 404, { unavailable: 'That file is no longer there. Gnomon points at the file where it sits; it never kept a copy.' })
      return
    }
    if (info.size > MAX_DELIVERABLE_BYTES) {
      sendJson(res, 413, { unavailable: `That file is ${Math.round(info.size / 1_000_000)}MB — too large to hand over through the browser. Open it from ${wanted}.` })
      return
    }

    // `attachment` so a browser saves it rather than trying to render it, and
    // a quoted basename so a name with a space or a comma survives the header.
    const name = basename(wanted).replace(/["\\]/g, '') || 'deliverable'
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(info.size),
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    })
    res.end(await readFile(wanted))
  })

  /**
   * Start a session.
   *
   * The id is minted here rather than by the client so that two tabs pressing
   * "new" cannot collide on one, and so the client never has to know dsh's id
   * shape.
   */
  api('/gnomon/api/session/new', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Starting a session takes a POST.' })
      return
    }
    const id = `session-${randomUUID()}`
    await agentFor(id, { create: true })
    console.log(`[${PLUGIN}] session ${id} created`)
    sendJson(res, 200, { id })
  })

  /**
   * Say something, and stream the turn it opens.
   *
   * One request, not a POST plus a separate stream to subscribe on: there is
   * then no window in which the turn has started and nobody is listening.
   * Closing the tab aborts the request, which unwatches the stream and never
   * cancels the turn — an answer the owner walked away from still lands in the
   * log, and the tokens are already spent either way.
   */
  /**
   * Compact this conversation now, rather than waiting for the threshold.
   *
   * `command-compact` is enabled in the profile (dsh-base mounts it,
   * dsh-web-app disabled it, the machine's patch re-enables it) and
   * `compaction-basic` already compacts automatically at 80% of the model's
   * declared window. This is the manual lever for the pinned conversation,
   * where the owner can see the gauge and decide the transcript has served its
   * purpose.
   *
   * Through `commands.execute`, which parses the slash line and resolves the
   * command FOR THAT AGENT — not by sending "/compact" down the turn route,
   * where it would reach the model as the literal text of a message. A name
   * that does not resolve returns undefined rather than throwing, so a profile
   * without the command answers honestly instead of pretending.
   */
  /**
   * One image in, a durable reference out.
   *
   * `attachment-local` is enabled and was unused: it content-addresses the
   * bytes under `DSH_HOME/attachments/v1` and validates media type, byte size
   * and pixel count against its own limits (png/jpeg/webp/gif, 20 per message).
   * The ref it returns is what an `ImageBlock` carries, which is why a
   * transcript does not end up holding base64 for the life of the session —
   * the adapter reads the bytes back per request instead.
   *
   * The client posts raw bytes with the real content-type rather than a JSON
   * data URI: base64 in a JSON body is a third larger and buys nothing here.
   */
  api('/gnomon/api/attach', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Attaching takes a POST.' })
      return
    }
    const attachments = ctx.get?.('attachments')
    if (attachments === undefined || typeof attachments.saveImage !== 'function') {
      sendJson(res, 501, { unavailable: 'This profile stores no attachments.' })
      return
    }

    const chunks = []
    let size = 0
    try {
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_IMAGE_BYTES) {
          sendJson(res, 413, { unavailable: 'That image is too large.' })
          return
        }
        chunks.push(chunk)
      }
    } catch {
      sendJson(res, 400, { unavailable: 'The image could not be read.' })
      return
    }

    try {
      // The store validates media type, dimensions and byte count itself, and
      // throws with its own reason — which is worth passing on verbatim, since
      // "not a PNG" and "too many pixels" need different fixes from the owner.
      const ref = await attachments.saveImage({
        data: new Uint8Array(Buffer.concat(chunks)),
        mediaType: String(req.headers['content-type'] ?? '').split(';')[0].trim(),
        ...(typeof req.headers['x-gnomon-filename'] === 'string' ? { name: req.headers['x-gnomon-filename'].slice(0, 120) } : {}),
      })
      sendJson(res, 200, { attachment: ref })
    } catch (error) {
      sendJson(res, 400, { unavailable: error instanceof Error ? error.message : 'That image was refused.' })
    }
  })

  post(ctx, '/gnomon/api/compact', { limit: 262_144, method: 'Compacting takes a POST.' }, async (body) => {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (sessionId === '') return 'Compacting needs a session.'
    const commands = ctx.get?.('commands') // resolved at call time, like every other optional dsh service here
    if (typeof commands?.execute !== 'function') return [501, { unavailable: 'This profile has no commands service.' }]
    const agent = await agentFor(sessionId)
    if (!agent || agent.status === 'disposed') return [409, { unavailable: 'That session is no longer running.' }]
    const settled = await commands.execute(agent, '/compact', AbortSignal.timeout(COMPACT_TIMEOUT_MS))
    return settled === undefined ? [501, { unavailable: 'The /compact command is not available on this profile.' }] : { compacted: true }
  })

  /**
   * Watch a session: every frame of every turn in it, as it happens.
   *
   * The POST below streams only the turn the owner opened. A turn nobody typed
   * — the companion woken by a notice, a job reporting back, a turn that went
   * quiet on the POST and carried on — used to appear only after the session
   * was reopened. The browser keeps one of these open for the session it shows;
   * it is silent while that session's own POST is streaming, so nothing draws
   * twice. A `turn` frame opens each new run of frames so it lands in its own block.
   */
  /**
   * Bring a side thread into the conversation. Its words (the latest part, if
   * long) ride into the companion as context, and the companion says in a line
   * or two what that thread settled — a turn the session watch streams live.
   */
  api('/gnomon/api/bring', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Bringing a thread in takes a POST.' })
      return
    }
    const body = await readJson(req)
    const from = typeof body?.from === 'string' ? body.from.trim() : ''
    if (from === '' || from === COMPANION_SESSION_ID) {
      sendJson(res, 400, { unavailable: 'Which thread? (The conversation cannot be brought into itself.)' })
      return
    }
    const snapshot = await readSnapshot(from)
    // A thread too new for the log to name falls back to the name the owner saw on it.
    const title = (titleFrom(snapshot.events, '') || (typeof body.title === 'string' ? body.title.trim() : '') || 'a side thread').slice(0, 120)
    const lines = replayFrames(snapshot.events)
      .filter((f) => f.type === 'user' || f.type === 'say')
      .map((f) => `${f.type === 'user' ? 'Owner' : 'Gnomon'}: ${f.text.trim()}`)
    if (lines.length === 0) {
      sendJson(res, 409, { unavailable: 'That thread has nothing in it to bring.' })
      return
    }
    const joined = lines.join('\n\n')
    const digest = joined.length > BRING_CHARS ? `…${joined.slice(-BRING_CHARS)}` : joined
    const agent = await agentFor(COMPANION_SESSION_ID)
    // W1: the reply is briefed like any turn (the clock, the memory, the present).
    agent.inject(briefMessage(await ctx.gnomonKernel.brief({ sessionId: COMPANION_SESSION_ID, cause: { kind: 'bring' } })))
    agent.inject(
      createUserMessage({
        content: [{ type: 'text', text: `The owner brought another thread into this conversation: "${title}". Its words, oldest first${digest === joined ? '' : ' (only the latest part)'}:\n\n${digest}` }],
        source: { kind: 'plugin', plugin: PLUGIN, form: 'notice', summary: `Brought in: ${title}` },
      }),
    )
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'In one or two sentences, say what that thread settled and what is still open, so the owner can carry on from here. No offer.' }],
        source: { kind: 'plugin', plugin: PLUGIN },
      }),
    )
    sendJson(res, 200, { brought: true, title })
  })

  /** The owner's answer to the open `ask_user_question` in a session. */
  post(ctx, '/gnomon/api/question', { limit: 262_144, method: 'Answering takes a POST.' }, async (body) => {
    const settle = openQuestions.get(typeof body.sessionId === 'string' ? body.sessionId : '')
    if (settle === undefined) return [404, { unavailable: 'That question is no longer waiting.' }]
    const custom = (a) => (typeof a.custom === 'string' && a.custom.trim() !== '' ? { custom: a.custom.trim() } : {})
    settle((Array.isArray(body.answers) ? body.answers : []).filter((a) => a && typeof a.id === 'string').map((a) => ({ id: a.id, selected: (Array.isArray(a.selected) ? a.selected : []).filter((x) => typeof x === 'string'), ...custom(a) })))
    return { answered: true }
  })

  /** Stop one running tool call; the turn goes on. */
  post(ctx, '/gnomon/api/tool/stop', { limit: 262_144, method: 'Stopping takes a POST.' }, async (body) => {
    const controller = stoppers.get(typeof body.callId === 'string' ? body.callId : '')
    if (controller === undefined) return [404, { unavailable: 'That call is no longer running.' }]
    controller.abort('owner')
    return { stopped: true }
  })

  api('/gnomon/api/watch', async (req, res, url) => {
    const id = url.searchParams.get('id') ?? ''
    if (id === '') {
      sendJson(res, 400, { unavailable: 'Which session?' })
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    const write = (frame) => {
      try {
        res.write(`data: ${JSON.stringify(frame)}\n\n`)
      } catch {
        // Gone mid-frame: the close handler below cleans up.
      }
    }
    // Whatever this thread is still waiting on, asked again for the browser
    // that just opened it: an approval, or that its open question is live.
    for (const { sessionId, frame } of waiting.values()) if (sessionId === id) write(frame)
    if (openQuestions.has(id)) write({ type: 'question-open' })
    let between = true
    const off = watch(id, (frame) => {
      if (turning.has(id) || res.writableEnded) return
      if (between && frame.type !== 'done') write({ type: 'turn', by: 'gnomon' })
      between = frame.type === 'done'
      write(frame)
    })
    const beat = setInterval(() => {
      try {
        res.write(': beat\n\n')
      } catch {
        // Closed; see below.
      }
    }, 25_000)
    req.on('close', () => {
      off()
      clearInterval(beat)
    })
  })

  api('/gnomon/api/turn', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'A turn takes a POST.' })
      return
    }
    const body = await readJson(req)
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (sessionId === '' || text === '') {
      sendJson(res, 400, { unavailable: 'A turn needs a session and something to say.' })
      return
    }

    const agent = await agentFor(sessionId)
    if (agent === null || agent === undefined || agent.status === 'disposed') {
      sendJson(res, 409, { unavailable: 'That session is no longer running.' })
      return
    }
    // This turn is about to put words in that log, so whatever the thread list
    // remembers it is called is now a guess. The next listing reads it again.
    forgetTitle(sessionId)

    // WHERE the owner was standing when they said it. This is the one thing a
    // client can tell a model that the model cannot find out for itself: "why?"
    // asked over the Shape instrument is a different question from "why?" asked
    // over Today, and it cannot see the screen.
    //
    // Injected as CONTEXT rather than folded into the message, so the owner's
    // own words stay theirs in the transcript.
    // And WHAT they are doing, off the kernel. This is the line that makes the
    // difference between an assistant and a search box: "am I doing okay?" is
    // answerable without a tool call, because the answer was already in hand.
    const place = typeof body.place === 'string' ? body.place.trim().slice(0, 200) : ''
    // The owner is answering Gnomon's own question. The client has already
    // recorded the answer; this tells the model WHAT was asked, so the reply
    // is read as the answer it is and not as a new topic.
    const answering = typeof body.answering?.question === 'string' ? body.answering.question.trim().slice(0, 400) : ''
    // Refs the client got back from /gnomon/api/attach. Shape-checked rather
    // than trusted: a malformed ref would reach the adapter's byte read.
    const images = Array.isArray(body.images)
      ? body.images
          .filter((ref) => ref !== null && typeof ref === 'object' && typeof ref.attachmentId === 'string' && typeof ref.mediaType === 'string')
          .slice(0, MAX_IMAGES_PER_TURN)
      : []
    // W1: the brief — the facts this turn is shown, logged as `chat:shown`, rendered once.
    const brief = await ctx.gnomonKernel.brief({ sessionId, cause: { kind: 'owner', askId: typeof body.answering?.askId === 'string' ? body.answering.askId : null }, place, answering, text })
    agent.inject(briefMessage(brief, place !== '' ? `Looking at ${place}` : brief.present))

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // No proxy sits in front of this today, but a Tailscale Serve route would
      // buffer the whole stream into one lump.
      'x-accel-buffering': 'no',
    })

    await new Promise((resolve) => {
      let settled = false
      let timer = null

      // A turn that ends having produced NOTHING — no text, no tool call — is
      // not a turn that chose silence. dsh closes a turn whose step it could
      // not build (a model id the route does not serve, for one) with
      // `turn/end: complete` and zero steps, logs nothing, and the ledger never
      // sees a call. Seen live: an owner asked "what time is it?" and got an
      // empty turn that looked exactly like Gnomon declining to answer. Say so.
      let produced = false
      const emit = (frame) => {
        if (res.writableEnded) return
        if (frame.type === 'text' || frame.type === 'tool' || frame.type === 'surface') produced = true
        if (frame.type === 'done' && !produced) {
          const current = selection()
          // dsh's OWN reason, when it has one, beats the guess. A turn that
          // died on a plugin exception carries the message here
          // (`autonomy is not defined` did, for three days) and the guess
          // blamed the model instead, sending the owner to the model picker.
          const message =
            typeof frame.message === 'string' && frame.message !== ''
              ? `The turn ended before a single step ran: ${frame.message}`
              : `The model produced nothing — the turn ended before a single step ran. ${current.provider}/${current.model} refused the call or is not served by that route. Say it again, or pick another model in the rail's foot.`
          frame = { type: 'error', message }
          produced = true
          emitRaw(frame)
          emitRaw({ type: 'done', reason: 'empty' })
          finish()
          return
        }
        emitRaw(frame)
        // Any frame at all is progress, a long tool run included.
        arm()
        if (frame.type === 'done') finish()
      }
      const emitRaw = (frame) => {
        try {
          res.write(`data: ${JSON.stringify(frame)}\n\n`)
        } catch {
          // A client that went away mid-frame is the normal case, not a fault.
        }
      }

      const unwatch = watch(sessionId, emit)
      turnOpened(sessionId)

      const finish = () => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        unwatch()
        turnClosed(sessionId)
        resolve()
      }
      function arm() {
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(() => {
          // An approval waiting on the owner is not a quiet turn: it outlives this (APPROVAL_TTL_MS), and its close re-arms it.
          if ([...waiting.values()].some((w) => w.sessionId === sessionId)) return arm()
          emit({ type: 'error', message: 'That turn went quiet. It may still be running — reopen the session to see.' })
          finish()
        }, TURN_IDLE_MS)
      }

      res.on('close', finish)
      // Images ride WITH the owner's words, in the same message: a picture
      // sent as its own turn is a turn with no question in it.
      agent.followup(createUserMessage({ content: [{ type: 'text', text }, ...images.map((attachment) => ({ type: 'image', attachment }))], source: { kind: 'user' } }))
      arm()
    })

    if (!res.writableEnded) res.end()
  })

  /**
   * The models this deployment can reach, and which one is current.
   *
   * Discovery is best-effort per provider: a route whose adapter cannot list
   * (a local server that is down, a key that expired) contributes nothing
   * rather than failing the whole picker, because the OTHER provider is still
   * usable and a picker that vanishes is worse than a short one.
   */
  api('/gnomon/api/models', async (_req, res, url) => {
    // `?session=` asks for THAT thread's model; without it, the default.
    const session = url.searchParams.get('session') ?? ''
    const current = (session !== '' ? threadModel(session) ?? (await rememberedModel(SessionId(session))) : null) ?? selection()
    sendJson(res, 200, await readModels({ llm: ctx.llm, current, scope: session !== '' ? 'thread' : 'default' }))
  })

  // A thread named → that thread, from its next step on (J1.10; dsh notes the switch in the
  // conversation). No thread → the default for agents created from here on.
  post(ctx, '/gnomon/api/model', { method: 'Choosing a model takes a POST.' }, async (body) => {
    const [provider, model] = [body.provider, body.model].map((v) => (typeof v === 'string' ? v : ''))
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (provider === '' || model === '') return 'A choice needs a provider and a model.'
    const ref = sessionId === '' ? null : await agentFor(sessionId).then(() => threadModels.get(sessionId))
    if (sessionId !== '') ref.current = { ...ref.current, provider, model }
    else await ctx.agentDefaultModel.saveSelection({ ...selection(), provider, model })
    console.log(`[${PLUGIN}] ${sessionId !== '' ? `thread ${sessionId} now uses` : 'default model is now'} ${provider}/${model}`)
    return sessionId !== '' ? { current: ref.current, scope: 'thread' } : { current: selection(), scope: 'default' }
  })

  /** The live channel. Opens with the present and the open question, then follows. */
  api('/gnomon/api/live', async (_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const emit = (frame) => {
      if (res.writableEnded) return
      try {
        res.write(`data: ${JSON.stringify(frame)}\n\n`)
      } catch {
        // Gone. The close handler below takes it out of the set.
      }
    }
    live.add(emit)
    emit({ type: 'now', now: snapshot() })
    emit({ type: 'ask', open: openAsk() })
    // A tab that connects mid-session gets the settings in force, not the defaults.
    emit({ type: 'settings', settings: ctx.gnomonKernel.getState()?.settings ?? null })
    await new Promise((resolve) => res.on('close', resolve))
    live.delete(emit)
  })

  /**
   * Stop the turn that is running, because the owner said so.
   *
   * Aborting the SSE read was never a stop: the comment on `/gnomon/api/turn`
   * says so outright — "the turn keeps running and lands in the log, because
   * the tokens are spent either way". So a shell command that hung, or a model
   * grinding through a tool loop, could not be called off from the one surface
   * the owner has. `agent.cancel` is the real thing, and dsh gives the cause a
   * first-class `user` variant, so "they stopped it" is durable in the log
   * rather than inferred from a turn that merely went quiet.
   *
   * `keepInbox: true` because this is "stop what you are doing", not "forget
   * everything I asked". It also keeps the note below, which is injected after
   * the cancel and would otherwise be swept out with the inbox.
   */
  api('/gnomon/api/stop', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { unavailable: 'Stopping takes a POST.' })
      return
    }
    const body = await readJson(req, 8192)
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : ''
    if (sessionId === '') {
      sendJson(res, 400, { unavailable: 'Stopping needs a session.' })
      return
    }
    const agent = ctx.agents.get(SessionId(sessionId))
    if (agent === undefined || agent.status === 'disposed') {
      sendJson(res, 409, { unavailable: 'That session is not running.' })
      return
    }

    agent.cancel({ kind: 'user' }, { keepInbox: true })

    // What the next turn needs to know, in one line: that the silence was the
    // owner's doing and not a failure, and — when they said why — what they
    // actually wanted instead. Without it the model opens the next turn seeing
    // a half-finished tool chain and no idea whether to resume it.
    agent.inject(
      createUserMessage({
        content: [
          {
            type: 'text',
            text: [
              'The owner stopped that turn themselves — it did not fail, and nothing is wrong.',
              note !== '' ? `They said: "${note}"` : null,
              'Do not silently start it again. Pick it up from what you already had, do what they asked instead, or ask what they want — briefly.',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
        source: { kind: 'plugin', plugin: PLUGIN, form: 'notice', summary: boundContextSummary(note !== '' ? `Stopped: ${note}` : 'The owner stopped that turn') },
      }),
    )

    console.log(`[${PLUGIN}] ${sessionId} stopped by the owner${note !== '' ? ` — "${note}"` : ''}`)
    sendJson(res, 200, { stopped: true, note: note === '' ? null : note })
  })

  /** Stop the running job: a logged request; the executor aborts the child (StopSubagent) and closes the record. */
  post(ctx, '/gnomon/api/work/stop', { method: 'Stopping takes a POST.' }, async (body) => {
    const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : ''
    if (jobId === '') return 'Which job?'
    await ctx.gnomonKernel.appendSignal('work:stop-requested', { jobId })
    return { stopping: true, jobId }
  })

  post(ctx, '/gnomon/api/approve', { method: 'Answering takes a POST.' }, async (body) => {
    const outcome = body.outcome === 'allowed-once' ? 'allowed-once' : 'rejected'
    const settle = pending.get(typeof body.id === 'string' ? body.id : '')
    // Already answered, expired, or withdrawn: a stale tab answering a question that moved on is inert, not a fault.
    if (settle === undefined) return { answered: false }
    settle(outcome)
    return { answered: true, outcome }
  })
}
