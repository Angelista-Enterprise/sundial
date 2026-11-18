// The thread head: which conversation the slip is talking to, as the slip's own title.
//
// The board picks a thread by opening it, and its conversation card holds the list. The slip used to be
// nailed to the companion thread, which made every test run and every spoken aside land in the same
// growing conversation: run 18 measured one that had grown all day, and the leftover of a killed turn
// answered itself inside the next run's first task.
//
// In the slip the thread's name sits where a frame's title sits (overlay.js moves `#thread` into its row).
// One click or Alt+L opens a short list upward: the companion thread, the side threads newest first with
// their age, "New thread" (Alt+K), and the model for this thread as the last line (the app's own picker,
// moved in). The markup keeps `.model`'s shape in index.html; the slip's sheet restyles it (overlay.css).
//
// Named exports only.

import { askCard } from './slip-read.js'

const SLIP_THREAD = 'gnomon.slip.thread'
const SLIP_THREAD_AT = 'gnomon.slip.thread.at'

/** How long ago, in the fewest words: a thread's age is a hint, never a timestamp to read. */
const ago = (at) => {
  const ms = Date.parse(String(at ?? ''))
  if (!Number.isFinite(ms)) return ''
  const min = Math.round((Date.now() - ms) / 60000)
  if (min < 1) return 'now'
  if (min < 60) return `${min} min`
  const hours = Math.round(min / 60)
  return hours < 24 ? `${hours} h` : `${Math.round(hours / 24)} d`
}

/**
 * Wire the pill, and hand back the one thing the rest of the app needs: how to join a thread.
 *
 * @param state the shell's own state object; `state.sessionId` is the thread the next turn joins
 * @param el the element helper, `ago` the shell's relative-time words
 * @param loadModels re-read the model pill, because a model is per thread
 */
export function mountThreadPill({ state, el, $, COMPANION_SESSION_ID, loadModels }) {
  const threadPick = $('thread-pick')
  const threadMenu = $('thread-menu')
  const threadRows = { list: [], at: 0 }
  const threadTitle = (id) => (id === null || id === COMPANION_SESSION_ID ? 'Gnomon' : threadRows.list.find((r) => r.id === id)?.title || 'Side thread')
  const setThreadButton = () => { $('thread-name').textContent = threadTitle(state.sessionId) }

  /** The threads worth offering: the owner's own, newest first. */
  async function loadThreads() {
    if (Date.now() - threadRows.at < 2000) return threadRows.list
    try {
      const body = await (await fetch('/gnomon/api/sessions', { headers: { accept: 'application/json' } })).json()
      threadRows.list = (body.sessions ?? body.rows ?? []).filter((r) => typeof r?.id === 'string' && !r.archived)
      threadRows.picked = body.picked ?? null
      threadRows.at = Date.now()
    } catch {
      // Offline: the pill keeps the name it has, and the menu says what it knows.
    }
    return threadRows.list
  }

  /** Join a thread from here on. Remembered, so the slip opens where it was left. */
  function joinThread(id) {
    setThreadMenu(false)
    // The chosen option hides with the list; in the slip the field takes the focus, so the keys stay in the panel.
    if (document.documentElement.dataset.overlay) $('input')?.focus?.()
    state.sessionId = id
    try {
      localStorage.setItem(SLIP_THREAD, id)
      localStorage.setItem(SLIP_THREAD_AT, String(Date.now()))
    } catch { /* a private window still works, it just forgets */ }
    setThreadButton()
    loadModels()
  }

  async function startThread() {
    setThreadMenu(false)
    try {
      const body = await (await fetch('/gnomon/api/session/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()
      if (typeof body.id === 'string') {
        threadRows.at = 0
        joinThread(body.id)
      }
    } catch {
      threadPick.focus()
    }
  }

  async function renderThreadMenu() {
    const rows = await loadThreads()
    const here = state.sessionId ?? COMPANION_SESSION_ID
    const sep = () => el('div', { class: 'thread-sep', role: 'presentation' })
    // Each thread: its name and age, and under the name the first words of its last answer (one line, cut by the sheet).
    const option = (id, title, note, when, answer) =>
      el('button', { type: 'button', class: 'thread-opt', role: 'option', 'aria-selected': String(id === here), onclick: () => (busy() ? refuse() : joinThread(id)) }, [
        el('i', { class: 'thread-here', 'aria-hidden': 'true' }),
        el('span', { class: 'thread-title' }, [title, note ? el('em', { text: note }) : null]),
        el('span', { class: 'thread-age', text: when }),
        answer ? el('span', { class: 'thread-last', text: answer, title: answer }) : null,
      ])
    const side = rows
      .filter((r) => r.id !== COMPANION_SESSION_ID && String(r.id).startsWith('session-'))
      .sort((a, b) => String(b.lastPromptAt ?? b.createdAt ?? '').localeCompare(String(a.lastPromptAt ?? a.createdAt ?? '')))
      .slice(0, 8)
    const companion = rows.find((r) => r.id === COMPANION_SESSION_ID)
    // The model for this thread, last: the app's own picker in the slip, the same list and the same choice (app.js chooseModel).
    const model = document.documentElement.dataset.overlay ? $('model') : null
    threadMenu.replaceChildren(
      option(COMPANION_SESSION_ID, 'Gnomon', 'companion', ago(companion?.lastPromptAt ?? companion?.createdAt), companion?.answer),
      ...side.map((r) => option(r.id, r.title || 'Side thread', '', ago(r.lastPromptAt ?? r.createdAt), r.answer)),
      sep(),
      el('div', { class: 'thread-new-row' }, [
        el('button', { type: 'button', class: 'thread-new', title: 'Start a clean conversation (⌥K)', onclick: () => (busy() ? refuse() : startThread()) }, [el('i', { 'aria-hidden': 'true' }), el('span', { text: 'New thread' }), el('kbd', { text: '⌥K' })]),
        model ? el('button', { type: 'button', class: 'thread-open', text: 'Open Sundial', onclick: () => window.webkit?.messageHandlers?.open?.postMessage(true) }) : null,
      ]),
      ...(model ? [sep(), el('div', { class: 'thread-model' }, [el('span', { text: 'Model for this thread' }), model])] : []),
    )
  }

  function setThreadMenu(open) {
    threadMenu.hidden = !open
    threadPick.setAttribute('aria-expanded', String(open))
    if (!open) return
    void renderThreadMenu().then(() => {
      const selected = threadMenu.querySelector('[aria-selected="true"]') ?? threadMenu.querySelector('.thread-opt')
      selected?.focus()
      selected?.scrollIntoView({ block: 'nearest' })
    })
  }

  /**
   * Whether the thread may change now. Not while a turn runs or an ask waits: the correction typed mid-turn and the message
   * that waits for the turn's end belong to THIS thread. Only the owner's own picks are held; a pick from outside is not.
   */
  // The ask the slip itself shows (slip-read.js askCard): a dead card, a settled one or one in an ended turn never holds the thread.
  const busy = () => Boolean(document.documentElement.dataset.overlay) && (document.body.dataset.running === 'true' || askCard([...document.querySelectorAll('#ghost .turn')].at(-1)) !== null)
  const refuse = () => {
    setThreadMenu(false)
    const thread = $('thread')
    thread.dataset.refused = '1'
    clearTimeout(refuse.timer)
    refuse.timer = setTimeout(() => delete thread.dataset.refused, 3000)
  }
  threadPick.addEventListener('click', () => (busy() && threadMenu.hidden ? refuse() : setThreadMenu(threadMenu.hidden)))
  document.addEventListener('click', (event) => { if (!threadMenu.hidden && !$('thread').contains(event.target)) setThreadMenu(false) })
  $('thread').addEventListener('keydown', (event) => {
    if (threadMenu.hidden) return
    // Up and down walk the list; Enter is the focused button's own.
    // The model's own options are app.js's to walk (#model is the list's last line).
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !event.target.closest?.('#model')) {
      const all = [...threadMenu.querySelectorAll('button')].filter((b) => !b.closest('#model'))
      const at = all.indexOf(document.activeElement)
      const next = event.key === 'ArrowDown' ? (at + 1) % all.length : at < 0 ? all.length - 1 : (at - 1 + all.length) % all.length
      all[next]?.focus()
      return void event.preventDefault()
    }
    if (event.key !== 'Escape') return
    event.preventDefault()
    setThreadMenu(false)
    // In the slip the field takes the keys back, so the panel keeps them (overlay.js reports focus for the whole slip).
    ;(document.documentElement.dataset.overlay ? $('input') : threadPick)?.focus()
  })
  const kept = (key) => { try { return localStorage.getItem(key) } catch { return null } }
  /** A thread picked from outside ({id, at}): joined, unless the owner chose a thread here after that pick. */
  const joinPicked = (pick) => (typeof pick?.id === 'string' && pick.at > Number(kept(SLIP_THREAD_AT) ?? 0) ? joinThread(pick.id) : setThreadButton())
  // In the slip, open where it was left. The board keeps its own navigation.
  if (document.documentElement.dataset.overlay) {
    // Alt+L opens the list, Alt+K starts a thread: keys no layout turns into a dead key, and none the slip or the board takes.
    document.addEventListener('keydown', (event) => {
      if (!event.altKey || (event.code !== 'KeyL' && event.code !== 'KeyK')) return
      event.preventDefault()
      // The board's own keys (stage.js wireKeys) read L and K as directions: these are the slip's alone.
      event.stopImmediatePropagation()
      if (busy() && (event.code === 'KeyK' || threadMenu.hidden)) return void refuse()
      if (event.code === 'KeyK') return void startThread()
      setThreadMenu(threadMenu.hidden)
    }, true)
    const was = kept(SLIP_THREAD)
    if (typeof was === 'string' && was !== '') state.sessionId = was
    setThreadButton()
    // A thread picked from outside while no page was up (the runner picks, then summons the slip).
    void loadThreads().then(() => joinPicked(threadRows.picked))
  }
  return { joinThread, joinPicked }
}
