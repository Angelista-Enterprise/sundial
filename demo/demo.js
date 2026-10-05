// The Sundial web demo. Sundial's own client runs unchanged; this file, loaded first, answers
// every /gnomon request it makes: reads from snapshot.json (recorded from the demo install by
// `node launch/qa.mjs --capture`), the board through the real board rule, and the chat through
// Chrome's built-in model (the Prompt API) over the same read tools Gnomon uses. Nothing is sent
// anywhere and nothing is saved: a reload is a fresh Thursday morning.
;(() => {
  // ── The demo's clock: always Thursday 1 October 2026, 09:05, the morning after the story's Wednesday.
  const AT = Date.parse('2026-10-01T09:05:00+02:00')
  const RealDate = Date, offset = AT - RealDate.now()
  function FakeDate(...a) {
    if (!new.target) return new RealDate(RealDate.now() + offset).toString()
    return a.length ? new RealDate(...a) : new RealDate(RealDate.now() + offset)
  }
  FakeDate.prototype = RealDate.prototype
  Object.setPrototypeOf(FakeDate, RealDate)
  FakeDate.now = () => RealDate.now() + offset
  globalThis.Date = FakeDate
  try { localStorage.setItem('sundial-setup-seen', '1') } catch {}

  const BASE = new URL('./', document.currentScript.src)
  const realFetch = window.fetch.bind(window)
  const snap = realFetch(new URL('snapshot.json', BASE)).then((r) => r.json())
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const json = (v, status = 200) => new Response(typeof v === 'string' ? v : JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
  const NOT_HERE = { unavailable: 'Not in this demo: it holds one recorded week.' }
  const MODEL = 'Chrome built-in model'
  // Counting (GoatCounter, only when the site was built with a code, and only here in the demo):
  // the moves a visitor makes — a board action, a question, which tool and model answered, a tap.
  // Named events only; never a page view, never what was typed.
  const count = (p) => { try { window.goatcounter?.count?.({ path: p, event: true }) } catch {} }

  // A request the recording did not make exactly: the same route with the most matching
  // parameters, but never a different tool, day, thread or moment.
  const STRICT = ['tool', 'date', 'id', 'momentId', 'q']
  function lookup(get, url) {
    const key = url.pathname + url.search
    if (key in get) return get[key]
    let best = null, score = -1
    for (const k of Object.keys(get)) {
      const u = new URL(k, location.origin)
      if (u.pathname !== url.pathname) continue
      if (STRICT.some((p) => url.searchParams.has(p) && u.searchParams.get(p) !== url.searchParams.get(p))) continue
      let s = 0
      for (const [p, v] of url.searchParams) if (u.searchParams.get(p) === v) s += 2
      s -= [...u.searchParams].length * 0.1
      if (s > score) [best, score] = [k, s]
    }
    return best === null ? null : get[best]
  }

  // ── Gnomon's open question: the recording's, until the visitor answers it.
  let askOpen = undefined // undefined = not read yet; null = answered
  const openAsk = (s) => { if (askOpen === undefined) askOpen = JSON.parse((s.sse['/gnomon/api/live'] ?? []).find((f) => f.startsWith('{"type":"ask"')) ?? '{}').open ?? null; return askOpen }
  const answerAsk = () => { askOpen = null; live({ type: 'ask', open: null }) }

  // ── The board: the real rule (packages/rules board-track), folded here instead of in the kernel.
  let board = null, boardTrack = null
  const ready = snap.then((s) => { board = JSON.parse(s.get['/gnomon/api/board'] ?? '{"cards":{}}') })
  async function boardMove(body) {
    boardTrack ??= (await import(new URL('app/board-track.js', BASE).href)).boardTrack
    const { action, ...payload } = body
    const out = boardTrack({ board, config: { timezone: 'Europe/Amsterdam' } }, { type: `board:${action}`, payload: { by: 'owner', ...payload }, ts: new Date().toISOString() })
    board = out.state.board
    live({ type: 'board', board })
    return board
  }

  // ── Streams: EventSource for /gnomon, answered here.
  const streams = new Set()
  class DemoSource extends EventTarget {
    constructor(url) {
      super()
      Object.assign(this, { url: url.href, readyState: 1, onmessage: null, onerror: null, onopen: null, withCredentials: false })
      streams.add(this)
      void openStream(this, url)
    }
    close() { this.readyState = 2; streams.delete(this) }
    send(frame) {
      if (this.readyState === 2) return
      const event = new MessageEvent('message', { data: JSON.stringify(frame) })
      this.onmessage?.(event)
      this.dispatchEvent(event)
    }
  }
  const live = (frame) => { for (const s of streams) if (new URL(s.url).pathname === '/gnomon/api/live') s.send(frame) }
  async function openStream(source, url) {
    const s = await snap
    await ready
    await sleep(50)
    if (url.pathname === '/gnomon/api/live') {
      const seen = new Set()
      for (const raw of s.sse['/gnomon/api/live'] ?? []) {
        const frame = JSON.parse(raw)
        if (['now', 'settings'].includes(frame.type) && !seen.has(frame.type)) { seen.add(frame.type); source.send(frame) }
      }
      source.send({ type: 'ask', open: openAsk(s) })
      source.send({ type: 'board', board })
    } else if (url.pathname === '/gnomon/api/search') {
      const frames = (s.sse[url.pathname + url.search] ?? []).map((f) => JSON.parse(f)).filter((f) => f.type !== 'reading')
      for (const f of frames.length ? frames : [{ type: 'hits', record: [], conversations: [] }, { type: 'done' }]) source.send(f)
    }
    // /gnomon/api/watch and webview: nothing arrives that this page did not start.
  }
  const RealEventSource = window.EventSource
  window.EventSource = function (url, options) {
    const u = new URL(url, location.href)
    return u.pathname.startsWith('/gnomon/') ? new DemoSource(u) : new RealEventSource(url, options)
  }

  // ── The chat.
  const threads = new Map() // id → frames, for /gnomon/api/session
  let n = 0
  const TOOLS = [
    ['gnomon_today_summary', {}, 'today so far, this morning, what is on my plate'],
    ['gnomon_today_summary', { date: '2026-09-30' }, 'yesterday (Wednesday): what I did, got done'],
    ['gnomon_open_commitments', {}, 'promises, what I owe, to whom, open commitments, deadlines'],
    ['gnomon_brief', { kind: 'standup' }, 'standup prep, what to say at standup'],
    ['gnomon_brief', { kind: 'week' }, 'this week, the week in review, most time spent'],
    ['gnomon_timeline', { date: '2026-09-30' }, 'timeline of yesterday hour by hour, meetings'],
    ['gnomon_recent_activity', {}, 'recent activity, the last hours, apps, focus'],
    ['gnomon_current_context', {}, 'right now, current context'],
    ['gnomon_people', {}, 'people, colleagues, who I work with, who I met'],
    ['gnomon_entity_history', { name: 'harbor-api' }, 'harbor-api project, Harbor release'],
    ['gnomon_entity_history', { name: 'Daan Mulder' }, 'Daan Mulder'],
    ['gnomon_entity_history', { name: 'the-salt-archive' }, 'The Salt Archive novel, writing, chapters'],
    ['gnomon_entity_history', { name: 'BOX-491' }, 'ticket BOX-491'],
    ['gnomon_project_handoff', { project: 'puzzlebox-studio' }, 'puzzlebox-studio handoff, game studio project'],
    ['gnomon_semantic_search', { query: 'rate limiter Redis' }, 'Redis, rate limiter, timeouts'],
    ['gnomon_did_i', { what: 'send Priya the build' }, 'did I send Priya the build'],
    ['gnomon_tickets', {}, 'tickets, Jira, issues'],
    ['gnomon_goals', {}, 'goals'],
    ['gnomon_routines', {}, 'habits, routines, when I usually start or stop'],
    ['gnomon_drift', {}, 'drift, what changed in how I work'],
    ['gnomon_anomalies', {}, 'unusual, anomalies, odd days'],
    ['gnomon_agent_yield', {}, 'coding agents, Claude Code, agent sessions'],
    ['gnomon_llm_ledger', {}, 'model cost, tokens, money the AI spent'],
    ['gnomon_reliability', {}, 'sensors, reliability, health'],
  ]
  // Which card shows what a tool reads: the answer's note lands beside it.
  const CARD_OF = { gnomon_today_summary: 'today', gnomon_brief: 'rhythm', gnomon_open_commitments: 'kanban', gnomon_timeline: 'dial', gnomon_recent_activity: 'today', gnomon_people: 'explore', gnomon_routines: 'rhythm', gnomon_llm_ledger: 'engine', gnomon_reliability: 'engine', gnomon_goals: 'voice', gnomon_tickets: 'kanban' }
  const wantsBoard = (text) => /\b(board|pin (it|this)|put (it|this|that)|place (it|this)|shelve)\b/i.test(text)
  async function* placeAnswer(tool, answer) {
    const callId = `demo-${++n}`, id = `note:demo-${n}`, card = CARD_OF[tool[0]]
    const title = answer.split('\n').find((l) => l.trim())?.replace(/^[#*\-\s]+/, '').slice(0, 60) ?? 'From the chat'
    yield { type: 'tool', callId, name: 'gnomon_board', args: { action: 'place', kind: 'note', title, near: card } }
    await boardMove({ action: 'place', id, kind: 'note', text: answer, near: card, w: 360, h: 260 })
    if (card && !board.cards[card]) await boardMove({ action: 'place', id: card, kind: card, near: id })
    await boardMove({ action: 'focus', ids: card ? [id, card] : [id], text: title })
    yield { type: 'tool-done', callId, text: `Placed “${title}” on the board${card ? `, beside ${card}` : ''}.` }
  }
  const toolKey = ([name, args]) => `/gnomon/api/read?tool=${name}&args=${encodeURIComponent(JSON.stringify(args))}`
  // Without a model: the menu line sharing the most words with the question.
  function pickByWords(text) {
    const words = new Set(text.toLowerCase().match(/[a-z0-9-]{3,}/g) ?? [])
    let best = 0, score = 0
    TOOLS.forEach((t, i) => {
      const s = (`${t[2]} ${JSON.stringify(t[1])}`.toLowerCase().match(/[a-z0-9-]{3,}/g) ?? []).filter((w) => words.has(w)).length
      if (s > score) [best, score] = [i, s]
    })
    return TOOLS[best]
  }

  const SYSTEM = 'You are Gnomon, the assistant inside Sundial, a local-first app that records what its owner does on their Mac and answers from that record. The owner is Alex Morgan. It is Thursday 1 October 2026, 09:05, Europe/Amsterdam; yesterday was Wednesday 30 September. Answer only from the record you are given. Be short and specific: names, times, counts, at most six lines or bullets. If the record does not say, say so plainly. Never invent people, numbers or events.'
  // Answers null (no model here), 'loading' (Chrome is still downloading it), or a session.
  let modelState = null, loading = null, downloaded = 0, why = 'browser'
  async function openModel(options) {
    const lm = await LanguageModel.create(options)
    // A browser with the API but no real model echoes the prompt back (plain Chromium says so;
    // Chrome's test backend prints its settings, then the prompt). An echo is no model.
    const probe = await lm.prompt('Reply with the word ok.').catch(() => '')
    return /not available in Chromium|reply with the word ok|System:/i.test(probe) ? null : lm
  }
  async function model() {
    if (modelState !== null) return modelState === 'none' ? null : modelState
    if (!('LanguageModel' in self)) return (modelState = 'none'), (why = 'browser'), null
    const io = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] }
    const availability = await LanguageModel.availability(io).catch(() => 'unavailable')
    if (availability === 'unavailable') return (modelState = 'none'), (why = 'device'), null
    loading ??= openModel({ ...io, initialPrompts: [{ role: 'system', content: SYSTEM }], monitor: (m) => m.addEventListener('downloadprogress', (e) => { downloaded = e.loaded }) })
      .then((lm) => { modelState = lm ?? 'none'; if (!lm) why = 'echo' }, () => { modelState = 'none'; why = 'device' })
    await (availability === 'available' ? loading : Promise.race([loading, sleep(3000)]))
    return modelState === null ? 'loading' : modelState === 'none' ? null : modelState
  }

  async function* turn(text, extra = {}) {
    yield { type: 'turn' }
    yield { type: 'user', text }
    if (extra.answering) {
      answerAsk()
      yield { type: 'text', delta: `Noted: “${text}”. In Sundial that answer is recorded against the promise and the promise moves with it. This demo forgets it when you reload.` }
      return yield { type: 'done', reason: 'complete' }
    }
    yield { type: 'thinking' }
    const s = await snap
    const lm = await model()
    count(`demo/model/${lm === null ? why : lm === 'loading' ? 'loading' : 'chrome'}`)
    let tool = pickByWords(text)
    if (lm && lm !== 'loading') {
      try {
        const menu = TOOLS.map((t, i) => `${i}: ${t[2]}`).join('\n')
        const picker = await lm.clone()
        try {
          const got = JSON.parse(await picker.prompt(`Which ONE record read answers this question best?\n${menu}\n\nQuestion: ${text}`, { responseConstraint: { type: 'object', properties: { read: { type: 'integer', minimum: 0, maximum: TOOLS.length - 1 } }, required: ['read'] }, omitResponseConstraintInput: true }))
          tool = TOOLS[got.read] ?? tool
        } finally { picker.destroy?.() }
      } catch {}
    }
    const callId = `demo-${++n}`
    count(`demo/tool/${tool[0]}`)
    const result = s.get[toolKey(tool)] ?? JSON.stringify(NOT_HERE)
    yield { type: 'tool', callId, name: tool[0], args: tool[1] }
    await sleep(250)
    yield { type: 'tool-done', callId, text: result }
    // No written answer: say what Gnomon read, why there are no words, and how to get them.
    const READ = 'Gnomon read the record for this question. Open the line above to see what it found.'
    const STEPS = '\n\n**To get a written answer**, this demo needs Chrome\'s built-in model (Gemini Nano). It runs on your own computer, so nothing you ask leaves it.\n\n1. Use Google Chrome 148 or newer on a desktop (Windows, macOS, Linux).\n2. Open `chrome://on-device-internals` and check the model status. Chrome needs about 22 GB free disk, and a GPU with more than 4 GB of memory or 16 GB of RAM.\n3. Reload this page and ask again.'
    if (lm === null) {
      const lead = { browser: 'This browser has no built-in model.', echo: 'This browser has Chrome\'s AI switch but not Google\'s model, so it only repeats the question back. Browsers built on Chromium, like Arc or Brave, do this.', device: 'Chrome says its built-in model cannot run on this computer.' }[why]
      yield { type: 'text', delta: `${READ}\n\n${lead}${STEPS}` }
      return yield { type: 'done', reason: 'complete' }
    }
    if (lm === 'loading') {
      yield { type: 'text', delta: `${READ}\n\nChrome is downloading its built-in model${downloaded ? ` (${Math.round(downloaded * 100)}% done)` : ''}. This happens once. Ask again in a few minutes. You can follow it at \`chrome://on-device-internals\`.` }
      return yield { type: 'done', reason: 'complete' }
    }
    const one = await lm.clone()
    try {
      const room = Math.max(2000, ((one.inputQuota ?? 6000) - (one.inputUsage ?? 0) - 600) * 3)
      const prompt = `The record (${tool[0]}):\n${result.slice(0, room)}\n\nQuestion: ${text}`
      let answer = ''
      for await (const delta of one.promptStreaming(prompt)) { answer += delta; yield { type: 'text', delta } }
      if (wantsBoard(text)) yield* placeAnswer(tool, answer.trim())
      yield { type: 'done', reason: 'complete' }
    } catch (error) {
      yield { type: 'done', reason: 'error', message: String(error?.message ?? error) }
    } finally {
      one.destroy?.()
    }
  }
  function streamTurn(sessionId, text, extra) {
    const frames = threads.get(sessionId) ?? []
    threads.set(sessionId, frames)
    const it = turn(text, extra)
    const enc = new TextEncoder()
    return new Response(new ReadableStream({
      async pull(controller) {
        const { done, value } = await it.next()
        if (done) return controller.close()
        if (value.type !== 'thinking') frames.push(value.type === 'text' ? { ...value } : value)
        controller.enqueue(enc.encode(`data: ${JSON.stringify(value)}\n\n`))
      },
    }), { headers: { 'content-type': 'text/event-stream' } })
  }
  // A replayed thread: the text deltas joined into one `say`, the way the server replays.
  function replay(frames) {
    const out = []
    for (const f of frames) {
      if (f.type === 'text' && out.at(-1)?.type === 'say') out.at(-1).text += f.delta
      else if (f.type === 'text') out.push({ type: 'say', text: f.delta })
      else out.push(f)
    }
    return out
  }

  // ── fetch: every /gnomon request is answered here.
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href)
    if (url.origin !== location.origin || !url.pathname.startsWith('/gnomon/')) return realFetch(input, init)
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const body = typeof init.body === 'string' ? (() => { try { return JSON.parse(init.body) } catch { return {} } })() : {}
    const s = await snap
    await ready
    const path = url.pathname
    if (path === '/gnomon/api/board') { if (method === 'POST') count(`demo/board/${body.action}${body.action === 'place' ? `/${String(body.kind ?? body.id ?? '').split(':')[0]}` : ''}`); return json(method === 'POST' ? await boardMove(body) : board) }
    if (path === '/gnomon/ask/open') return json({ open: openAsk(s) })
    if (path === '/gnomon/ask/answer') { count('demo/ask/answered'); answerAsk(); return json({ recorded: true, askId: body.askId }) }
    if (path === '/gnomon/api/turn') { count(ASKS.includes(body.text) ? 'demo/ask/suggested' : 'demo/ask/typed'); return streamTurn(body.sessionId, String(body.text ?? ''), body) }
    if (path === '/gnomon/api/session/new') { const id = `demo-thread-${++n}`; threads.set(id, []); return json({ id }) }
    if (path === '/gnomon/api/session' && threads.has(url.searchParams.get('id') ?? '')) return json({ id: url.searchParams.get('id'), title: '', frames: replay(threads.get(url.searchParams.get('id'))), model: MODEL })
    if (path === '/gnomon/api/session' && url.searchParams.get('id') === 'gnomon-companion' && !threads.has('gnomon-companion')) threads.set('gnomon-companion', [])
    if (path === '/gnomon/api/session') return json({ id: url.searchParams.get('id'), title: '', frames: replay(threads.get(url.searchParams.get('id')) ?? []), model: MODEL })
    if (method !== 'GET') { count(`demo/post${path.replace('/gnomon', '')}${typeof body.verdict === 'string' ? `/${body.verdict}` : ''}`); return json({ ok: false, unavailable: 'This is a demo: nothing is saved.' }) }
    const got = lookup(s.get, url)
    return got === null ? json(NOT_HERE) : json(got)
  }

  // ── The demo's own words: one line above the board, and questions to start from.
  const ASKS = ['What is on my plate this morning?', 'Which promises are still open, and to whom?', 'What did I get done yesterday?', 'What do I know about harbor-api?']
  addEventListener('DOMContentLoaded', () => {
    const note = document.createElement('div')
    note.className = 'demo-note'
    note.innerHTML = '<b>Sundial demo</b><span>Alex Morgan’s made-up week, frozen on Thursday 1 October, 09:05. Nothing is saved; the chat runs on your own computer. The demo counts the moves you make here, never your words.</span><a href="../">About Sundial</a><a href="../feedback/">Feedback</a><button type="button" class="demo-note-x">Hide</button>'
    const hide = () => { note.toggleAttribute('data-gone', true); setTimeout(() => note.remove(), 400) }
    note.querySelector('.demo-note-x').onclick = hide
    // It says its piece once: the first touch anywhere else puts it away.
    addEventListener('pointerdown', (e) => { if (!note.contains(e.target)) hide() }, { once: true, capture: true })
    document.body.append(note)
    const bar = document.getElementById('bar'), input = document.getElementById('input')
    if (!bar || !input) return
    const asks = document.createElement('div')
    asks.className = 'demo-asks'
    for (const q of ASKS) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = q
      b.onclick = () => { input.value = q; input.dispatchEvent(new Event('input', { bubbles: true })); bar.requestSubmit() }
      asks.append(b)
    }
    bar.prepend(asks)
  })
})()

// ── Notes on the demo, pinned where they were made ──────────────────────────────────────────────
// A visitor presses Comment, clicks a spot on a card, writes a line, and posts it; the note is a
// GitHub issue (label `feedback`), with the card and the spot in the form's "Where" field. Every
// visitor sees the open notes as numbered pins on the cards they belong to. Closing the issue on
// GitHub removes the pin: that is the moderation. SHOW_LABEL = 'shown' would hide every note until
// a maintainer adds that label.
;(() => {
  const REPO = 'Angelista-Enterprise/sundial', API = `https://api.github.com/repos/${REPO}`, SHOW_LABEL = null
  const ANCHOR = /^demo:([^@\s]+)@(\d{1,3}),(\d{1,3})$/
  const count = (p) => { try { window.goatcounter?.count?.({ path: p, event: true }) } catch {} }
  const el = (tag, attrs = {}, children = []) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) if (k === 'text') n.textContent = v; else if (v != null) n.setAttribute(k, v); n.append(...children.filter(Boolean)); return n }
  const when = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  async function github(url, ttl = 600_000) {
    try { const hit = JSON.parse(localStorage.getItem(`gh:${url}`)); if (hit && Date.now() - hit.at < ttl) return hit.data } catch {}
    const r = await window.fetch(url, { headers: { accept: 'application/vnd.github+json' } })
    if (!r.ok) throw new Error(`GitHub ${r.status}`)
    const data = await r.json()
    try { localStorage.setItem(`gh:${url}`, JSON.stringify({ at: Date.now(), data })) } catch {}
    return data
  }
  // The note's spot, from the issue form's "Where" answer.
  const anchorOf = (issue) => ANCHOR.exec(issue.body?.match(/### Where[^\n]*\n+([^\n]+)/)?.[1]?.trim() ?? '')
  let notes = [], armed = false, popover = null
  const titleOf = (card) => document.querySelector(`article.pane[data-pane="${CSS.escape(card)}"] .pane-title`)?.textContent?.trim() || card

  // ── The pins, drawn into the cards they belong to (so they pan and zoom with the board).
  function drawPins() {
    for (const old of document.querySelectorAll('.demo-pin')) old.remove()
    notes.forEach((note, i) => {
      const m = anchorOf(note)
      if (!m) return
      const pane = document.querySelector(`article.pane[data-pane="${CSS.escape(m[1])}"]`)
      if (!pane) return
      const pin = el('button', { type: 'button', class: 'demo-pin', style: `left:${m[2]}%;top:${m[3]}%`, title: note.title, 'aria-label': `Note ${i + 1}: ${note.title}` }, [el('span', { text: String(i + 1) })])
      pin.onclick = (e) => { e.stopPropagation(); openNote(note, i + 1, pin) }
      pane.append(pin)
    })
    const n = notes.filter(anchorOf).length
    const b = document.querySelector('.demo-comment')
    if (b) b.dataset.count = n ? String(n) : ''
  }
  // The board redraws its cards; the pins follow.
  const redraw = () => requestAnimationFrame(drawPins)
  document.addEventListener('gnomon:beat', redraw)

  // ── One note, opened: the text, who, when, the replies, and the way to answer.
  function closePopover() { popover?.remove(); popover = null }
  function place(node, near) {
    const r = near.getBoundingClientRect()
    node.style.left = `${Math.min(innerWidth - 336, Math.max(16, r.left + 14))}px`
    node.style.top = `${Math.min(innerHeight - 220, Math.max(16, r.top + 14))}px`
  }
  async function openNote(note, n, pin) {
    closePopover()
    const body = (note.body ?? '').match(/### What[^\n]*\n+([\s\S]*?)(?=\n### |$)/)?.[1]?.trim() ?? note.body ?? ''
    const replies = el('div', { class: 'demo-note-replies' })
    popover = el('div', { class: 'demo-popover', role: 'dialog', 'aria-label': `Note ${n}` }, [
      el('div', { class: 'demo-popover-head' }, [el('span', { class: 'demo-popover-n', text: String(n) }), el('span', { class: 'demo-popover-meta', text: `${note.user?.login ?? ''} · ${when(note.created_at)}` }), el('button', { type: 'button', class: 'demo-popover-x', text: 'Close' })]),
      el('p', { class: 'demo-popover-text', text: body.slice(0, 600) }),
      replies,
      el('p', { class: 'demo-popover-acts' }, [el('a', { href: note.html_url, target: '_blank', rel: 'noopener', text: note.comments ? `Reply on GitHub (${note.comments})` : 'Reply on GitHub' })]),
    ])
    popover.querySelector('.demo-popover-x').onclick = closePopover
    document.body.append(popover)
    place(popover, pin)
    if (note.comments) github(`${API}/issues/${note.number}/comments?per_page=5`).then((list) => {
      replies.replaceChildren(...list.map((c) => el('p', { class: 'demo-reply' }, [el('b', { text: c.user?.login ?? '' }), document.createTextNode(` ${(c.body ?? '').slice(0, 300)}`)])))
    }).catch(() => {})
  }

  // ── A new note: Comment, then a click on a card, then the words.
  function arm(on) {
    armed = on
    document.body.toggleAttribute('data-commenting', on)
    document.querySelector('.demo-comment')?.toggleAttribute('data-on', on)
  }
  function draft(e) {
    if (!armed) return
    const pane = e.target.closest?.('article.pane')
    if (!pane || e.target.closest('.demo-pin, .demo-popover')) return
    e.preventDefault(); e.stopPropagation()
    arm(false); closePopover()
    const r = pane.getBoundingClientRect()
    const x = Math.round(((e.clientX - r.left) / r.width) * 100), y = Math.round(((e.clientY - r.top) / r.height) * 100)
    const card = pane.dataset.pane, anchor = `demo:${card}@${x},${y}`
    const ghost = el('span', { class: 'demo-pin demo-pin-draft', style: `left:${x}%;top:${y}%` })
    pane.append(ghost)
    const text = el('textarea', { class: 'demo-popover-input', rows: '3', placeholder: `A note on ${titleOf(card)}…`, 'aria-label': 'Your note' })
    popover = el('div', { class: 'demo-popover', role: 'dialog', 'aria-label': 'New note' }, [
      el('div', { class: 'demo-popover-head' }, [el('span', { class: 'demo-popover-meta', text: `On ${titleOf(card)}` }), el('button', { type: 'button', class: 'demo-popover-x', text: 'Cancel' })]),
      text,
      el('p', { class: 'demo-popover-acts' }, [el('button', { type: 'button', class: 'act act-small demo-post', text: 'Post on GitHub' }), el('span', { class: 'demo-popover-hint', text: 'Opens GitHub with the note filled in. Posting needs a GitHub account; the note shows here once it is open.' })]),
    ])
    const done = () => { ghost.remove(); closePopover() }
    popover.querySelector('.demo-popover-x').onclick = done
    popover.querySelector('.demo-post').onclick = () => {
      const what = text.value.trim()
      if (!what) return text.focus()
      count('demo/note/posted')
      const url = new URL(`https://github.com/${REPO}/issues/new`)
      url.searchParams.set('template', 'feedback.yml')
      url.searchParams.set('title', `${titleOf(card)}: ${what.slice(0, 60)}${what.length > 60 ? '…' : ''}`)
      url.searchParams.set('what', what)
      url.searchParams.set('where', anchor)
      url.searchParams.set('browser', navigator.userAgent.match(/(Chrome|Firefox|Safari|Edg|Arc)\/[\d.]+/)?.[0] ?? '')
      window.open(url, '_blank', 'noopener')
      done()
    }
    // Keys typed in the note are the note's: the board's shortcuts and the composer do not hear them.
    for (const type of ['keydown', 'keyup', 'keypress']) popover.addEventListener(type, (e) => { if (e.key !== 'Escape') e.stopPropagation() })
    document.body.append(popover)
    place(popover, ghost)
    text.focus()
  }
  document.addEventListener('click', draft, true)
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (armed || popover)) { arm(false); closePopover() } })
  document.addEventListener('pointerdown', (e) => { if (popover && !popover.contains(e.target) && !e.target.closest('.demo-pin')) closePopover() })

  addEventListener('DOMContentLoaded', () => {
    new MutationObserver((muts) => { if (muts.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && (n.matches?.('article.pane') || n.querySelector?.('article.pane'))))) redraw() }).observe(document.body, { childList: true, subtree: true })
    const b = el('button', { type: 'button', class: 'demo-comment', 'aria-pressed': 'false', title: 'Leave a note on a card (then click where it belongs)' }, [el('span', { class: 'demo-comment-dot' }), el('span', { text: 'Comment' })])
    b.onclick = () => { arm(!armed); b.setAttribute('aria-pressed', String(armed)); if (armed) count('demo/note/armed') }
    document.body.append(b)
    github(`${API}/issues?labels=${SHOW_LABEL ? `feedback,${SHOW_LABEL}` : 'feedback'}&state=open&per_page=50`).then((list) => { notes = list.filter((i) => !i.pull_request); drawPins() }).catch(() => {})
  })
})()
