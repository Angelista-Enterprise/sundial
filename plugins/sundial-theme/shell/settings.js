// The settings, as a card.
//
// Not a modal and not a page: the board is the surface, so the settings stand
// on it like everything else. They are kernel state, not this browser's — the
// rules read them (the notice gate asks whether it may speak at all), the
// model's write tools are refused by them, and every open tab obeys the same
// ones. Every change is a `settings:set` event, so a replay reproduces the
// settings that were in force when a decision was made.
import { el } from './surfaces.js'
import { PERMS, grantAction } from './permissions.js'

const post = (patch) =>
  fetch('/gnomon/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)

/** Everything the client has to obey lives here, so one place applies it. */
export const SETTINGS = { autonomy: 'act', noticeBias: 0, autoAdvanceMs: null, paper: 'system', motion: 'full', blur: 'full', quiet: [], updatedAt: null }

/** Write one setting to the record and apply what comes back. Shared with Find. */
export const setSetting = (patch) => post(patch).then((next) => next && applySettings(next))

/** The blur a card's glass is allowed, as the sheet's one switch reads it. */
export const BLUR_LABEL = { off: 'Off', soft: 'Soft', full: 'Full' }

/**
 * The paper toggle's next paper. Auto, then Dark, then Light: the owner leaves
 * Auto for dark, and the old Auto → Light → Dark order went through light on the
 * way every time (4 of 4 switches on the record).
 */
export const nextPaper = (paper) => ({ system: 'dark', dark: 'light', light: 'system' })[paper] ?? 'dark'

/**
 * Apply the settings to the page: the paper, the glass, and whether anything may move.
 * Called on every `settings` frame, so a change in one tab lands in all of them.
 */
export function applySettings(next) {
  if (next && typeof next === 'object') Object.assign(SETTINGS, next)
  const root = document.documentElement
  if (SETTINGS.paper === 'system') delete root.dataset.theme
  else root.dataset.theme = SETTINGS.paper
  root.dataset.motion = SETTINGS.motion
  // One attribute, one token, every blurring surface in the product: see the
  // glass switch in app.css. `off` is `none`, not a zero blur.
  root.dataset.blur = SETTINGS.blur ?? 'full'
  const label = document.getElementById('theme-name')
  if (label) label.textContent = { system: 'Auto', light: 'Light', dark: 'Dark' }[SETTINGS.paper]
  for (const node of document.querySelectorAll('.settings')) node.dispatchEvent(new Event('sync'))
  return SETTINGS
}

const AUTONOMY = [
  ['off', 'Off', 'Answers when asked. Says nothing on its own, leaves the board alone, and stops for your nod before any command or outward change.'],
  ['notice', 'Notice', 'May speak first when what it noticed clears the bar. Still leaves the board alone, and still asks before running anything.'],
  ['act', 'Act', 'May also place cards, walk you through something, open surfaces, and run commands and actions on its own — still inside the permission preset.'],
]
const BIAS = [
  [-1, 'Chattier'],
  [0, 'As judged'],
  [1, 'Quieter'],
  [2, 'Much quieter'],
]
const DWELL = [
  [null, 'Wait for Next'],
  [4000, '4s'],
  [8000, '8s'],
  [15000, '15s'],
]
const PAPER = [
  ['system', 'Auto'],
  ['light', 'Light'],
  ['dark', 'Dark'],
]
const MOTION = [
  ['full', 'Full'],
  ['reduced', 'Reduced'],
]
const BLUR = [
  ['full', 'Full', 'The card in front frosts the paper behind it.'],
  ['soft', 'Soft', 'Half the frost, and the paper stays legible through it.'],
  ['off', 'Off', 'No blur is drawn at all — the cheapest board there is.'],
]

/** One row: a name, a line about it, and a set of choices. */
function choice(label, hint, options, current, onPick) {
  const buttons = options.map(([value, text, note]) =>
    el('button', {
      type: 'button',
      class: 'set-opt',
      role: 'radio',
      'aria-checked': String(value === current),
      title: note ?? '',
      text,
      onclick: () => onPick(value),
    }),
  )
  return el('div', { class: 'set-row' }, [
    el('div', { class: 'set-name' }, [el('span', { class: 'set-label', text: label }), hint ? el('span', { class: 'set-hint', text: hint }) : null]),
    el('div', { class: 'set-opts', role: 'radiogroup', 'aria-label': label }, buttons),
  ])
}

/**
 * The notice bench: every shape a notice row can take, raised on demand.
 *
 * These go through the RECORD — `board:notice`, the same event `gnomon_board`
 * writes — not through a private client call. So pressing one exercises exactly
 * the path Gnomon takes: the fold, the live channel, the band, and the reply
 * coming back as a turn. A bench that tested a shortcut would be testing
 * nothing, and these are the shapes that break.
 */
const NOTICES = [
  ['A line', { text: 'You left the computer at 22:41 Saturday — 19 min before your own 23:00 target. Entry 1 of the 7-night sleep log.' }],
  ['Short', { text: 'Committed to sundial.' }],
  ['Long', { text: 'Across the last fortnight your deepest hour is 09:00 on twelve of fourteen days, switching peaks at 11:00, and the three days you started after 10:30 are the three with the most switching — which is the pattern worth naming, not the totals.' }],
  ['2s', { text: 'Gone in two seconds.', ms: 2000 }],
  ['15s', { text: 'Standing for fifteen seconds.', ms: 15000 }],
  ['Stays', { text: 'No clock on this one — it stands until you close it.', ms: 0 }],
  [
    'A question',
    {
      text: 'You said you would push the rc branch before the weekend. Shall I open a thread for it?',
      kind: 'ask',
      actions: [
        { label: 'Yes', say: 'yes, open a thread for pushing the rc branch' },
        { label: 'Not now', say: 'not now' },
      ],
    },
  ],
  [
    'Three replies',
    {
      text: 'That stretch had no project on it. Whose was it?',
      kind: 'ask',
      actions: [
        { label: 'sundial', say: 'that stretch was sundial' },
        { label: 'Something else', say: 'that stretch was something else — let me tell you' },
        { label: 'Not work', say: 'that stretch was not work' },
      ],
    },
  ],
]

function noticeBench() {
  const fire = (payload) => postBoard({ action: 'notice', ...payload })
  return el('div', { class: 'set-row' }, [
    el('div', { class: 'set-name' }, [
      el('span', { class: 'set-label', text: 'Notices' }),
      el('span', { class: 'set-hint', text: 'Raise one to see how it lands. A question waits for you, and your reply is said to Gnomon.' }),
    ]),
    el(
      'div',
      { class: 'set-opts' },
      NOTICES.map(([label, payload]) => el('button', { type: 'button', class: 'set-opt', text: label, onclick: () => fire(payload) })),
    ),
  ])
}

/**
 * What macOS lets Sundial see, always one glance away — the setup page's rows,
 * not only on a first run. A grant is given in System Settings, never here, so
 * each row that is not granted opens its pane; inside Sundial.app the app hands
 * that link to macOS. Read from /gnomon/setup (the helpers' own reports) every
 * few seconds while the card is on the board, so a grant shows up without a
 * reload.
 */
function permissionsBlock() {
  const rows = el('div', {})
  const node = el('div', {}, [
    el('div', { class: 'set-row' }, [
      el('div', { class: 'set-name' }, [
        el('span', { class: 'set-label', text: 'Permissions' }),
        el('span', { class: 'set-hint', text: 'What macOS lets Sundial see. You grant it in System Settings; Sundial only reads the answer.' }),
      ]),
      el('div', { class: 'set-opts' }, [el('a', { class: 'set-opt', href: '/setup', text: 'Full setup' })]),
    ]),
    rows,
  ])
  const state = (granted, optional) =>
    granted === true
      ? el('span', { class: 'grant-state', 'data-state': 'on', text: 'Granted' })
      : optional
        ? el('span', { class: 'grant-state', 'data-state': 'unknown', text: 'Off' })
        : granted === false
          ? el('span', { class: 'grant-state', 'data-state': 'off', text: 'Not granted' })
          : el('span', { class: 'grant-state', 'data-state': 'unknown', text: 'Waiting for the sensor' })
  const health = el('div', {})
  node.append(health)
  const read = async () => {
    const data = await fetch('/gnomon/setup', { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    if (data?.health) health.replaceChildren(...healthRows(data.health))
    const list = data?.permissions ?? null
    if (!list) return
    rows.replaceChildren(
      ...list
        .filter((p) => PERMS[p.key])
        .sort((a, b) => Number(Boolean(PERMS[a.key].optional)) - Number(Boolean(PERMS[b.key].optional)))
        .map((p) => {
          const info = PERMS[p.key]
          return el('div', { class: 'set-row' }, [
            el('div', { class: 'set-name' }, [el('span', { class: 'set-label', text: p.label }), el('span', { class: 'set-hint', text: info.optional ? `Optional. ${info.what}` : info.what })]),
            el('div', { class: 'set-perm' }, [
              state(p.granted, info.optional),
              p.granted === true ? null : grantAction(p.key, 'set-opt'),
            ]),
          ])
        }),
    )
  }
  read()
  // Skips while the card is off the board; the settings card lives as long as the page.
  setInterval(() => node.isConnected && read(), 5000)
  return node
}

// lane H
/** What broke, in the owner's words: the key `sensorHealth` files a trouble under. */
function troubleName(key) {
  if (key === 'input-grant') return 'Input Monitoring'
  if (key === 'input-keys') return 'Key presses'
  if (key === 'microphone') return 'Hearing'
  if (key === 'screen-recording') return 'Screen Recording'
  if (key === 'config') return 'config.json'
  if (key.startsWith('llm-auth:')) return 'Model key'
  if (key.startsWith('sidecar:')) return `Sensor: ${key.slice(8)}`
  return key
}

/**
 * Sundial's own health, under the permissions it depends on: what stands
 * broken now (each said once, through the gate), whether the last push
 * reached the phone, the last daily copy of the record, and any budget that
 * ran out today. Nothing here is a switch; the switch is the "Sundial's own
 * health" group above.
 */
export function healthRows(h) {
  const row = (label, hint, state, text) =>
    el('div', { class: 'set-row' }, [
      el('div', { class: 'set-name' }, [el('span', { class: 'set-label', text: label }), hint ? el('span', { class: 'set-hint', text: hint }) : null]),
      el('div', { class: 'set-perm' }, [el('span', { class: 'grant-state', 'data-state': state, text })]),
    ])
  const troubles = h.troubles ?? []
  const pushOk = h.push?.lastOkAt ? Date.parse(h.push.lastOkAt) : null
  const pushFailed = h.push?.lastFailedAt ? Date.parse(h.push.lastFailedAt) : null
  const today = new Date().toLocaleDateString('en-CA')
  const backupAge = h.lastBackup ? Math.round((Date.parse(today) - Date.parse(h.lastBackup)) / 86_400_000) : null
  return [
    el('div', { class: 'set-row' }, [
      el('div', { class: 'set-name' }, [
        el('span', { class: 'set-label', text: "Sundial's own health" }),
        el('span', { class: 'set-hint', text: 'What its sensors, keys and copies report. Anything broken is said once, then stays here until it is fixed.' }),
      ]),
    ]),
    ...(troubles.length === 0
      ? [row('Sensors and keys', null, 'on', 'All reporting')]
      : troubles.map((t) => row(troubleName(t.key), t.observation, 'off', `Since ${since(t.since)}`))),
    h.push?.configured
      ? pushFailed !== null && (pushOk === null || pushFailed > pushOk)
        ? row('Phone push', `The last one did not reach the phone (${h.push.lastError ?? 'unknown'}); the banner stood in.`, 'off', `Failed ${since(h.push.lastFailedAt)}`)
        : row('Phone push', null, pushOk === null ? 'unknown' : 'on', pushOk === null ? 'None sent yet' : `Reached the phone ${since(h.push.lastOkAt)}`)
      : null,
    row('Daily copy of the record', 'Seven are kept. Made after the nightly clean-up.', backupAge === null ? 'unknown' : backupAge <= 1 ? 'on' : 'off', h.lastBackup ? `Last ${new Date(`${h.lastBackup}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : 'None yet'),
    (h.budgetsOutToday ?? []).length > 0 ? row('Model budget', 'Calls for these ran out today; they wait until tomorrow.', 'off', `Out: ${h.budgetsOutToday.join(', ')}`) : null,
  ].filter(Boolean) // `replaceChildren` would print a null as the word "null"
}

/** "4 min ago", "3 h ago", or a date — for a service's last signal. */
function since(iso, now = Date.now()) {
  const min = Math.round((now - Date.parse(iso)) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** A service's health from its own last signal: live, quiet, or never seen. */
function health(s) {
  // A service with no signal of its own has no health to show; one that is off is quiet by choice.
  if (!s.watched || s.value === false || s.value === 'off') return null
  if (s.lastSignal === null) return el('span', { class: 'grant-state', 'data-state': 'unknown', text: 'No signal yet' })
  const fresh = Date.now() - Date.parse(s.lastSignal) < 6 * 3600_000
  return el('span', { class: 'grant-state', 'data-state': fresh ? 'on' : 'off', text: fresh ? `Live, ${since(s.lastSignal)}` : `Last seen ${since(s.lastSignal)}` })
}

/** A service's whole state in one word, for a row that has no switch of its own. */
const textState = (value) => el('span', { class: 'grant-state', 'data-state': value === 'set' ? 'on' : 'off', text: value === 'set' ? 'Set' : 'Not set' })

const call = (url, body) =>
  fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : r.json().catch(() => null).then((j) => ({ failed: j?.unavailable ?? `The server answered ${r.status}.` }))))
    .catch(() => null)

/**
 * Every service Sundial can run (shell/services.js), with its switch or with
 * what it needs from the owner. A config switch waits for a restart, so the
 * block counts what waits, restarts in one press, and says when Sundial is
 * back — the page stays; only the host process goes. A Claude Code hook is
 * live at the next Claude session and never waits.
 */
function servicesBlock() {
  const rows = el('div', {})
  const wait = el('div', { class: 'set-wait', 'aria-live': 'polite' })
  const node = el('div', {}, [
    el('div', { class: 'set-row' }, [
      el('div', { class: 'set-name' }, [
        el('span', { class: 'set-label', text: 'Services' }),
        el('span', { class: 'set-hint', text: 'What Sundial runs. A switch writes config.json; most apply after one restart.' }),
      ]),
    ]),
    wait,
    rows,
  ])
  let restarting = null // the bootedAt we are waiting to see change
  let backUntil = 0 // the "back" line stands a few seconds, then goes
  let last = null
  const say = (text, state, action = null) => {
    wait.hidden = false
    wait.replaceChildren(...[el('span', { class: 'grant-state', 'data-state': state, text }), action].filter(Boolean))
  }
  const restart = async () => {
    say('Restarting Sundial…', 'unknown')
    const got = await call('/gnomon/api/providers', { op: 'restart' })
    if (got && got.restarted === false) return say(`Sundial runs without its app. Run: ${got.command}`, 'off')
    restarting = last?.bootedAt ?? null
    const began = Date.now()
    // The host goes away and comes back; the page does not. Ask until a new boot answers.
    const poll = async () => {
      const data = await call('/gnomon/api/services')
      if (data && !data.failed && data.bootedAt !== restarting) {
        restarting = null
        backUntil = Date.now() + 8000
        setTimeout(() => draw(last), 8100)
        draw(data)
        return say(data.restartNeeded ? 'Back, but some changes still wait.' : 'Sundial is back. Every change is live.', data.restartNeeded ? 'off' : 'on')
      }
      if (Date.now() - began > 90_000) return say('Still not back after 90 s. Check the menu bar app, or run: sundial restart', 'off')
      setTimeout(poll, 1500)
    }
    setTimeout(poll, 1500)
  }
  const pick = (s, value) => async () => {
    const got = await call('/gnomon/api/services', { id: s.id, value })
    if (got?.failed) return say(got.failed, 'off')
    draw(got)
  }
  /** A typed value (the ntfy address, the vault folder): never shown back, only Set, Change and Clear. */
  const textField = (s) => {
    const box = el('div', { class: 'set-opts set-text' })
    const save = (value) => async () => {
      const got = await call('/gnomon/api/services', { id: s.id, text: value() })
      // Said beside the field it is about, and the field stays for the fix.
      if (got?.failed) return box.querySelector('.set-err')?.remove(), box.prepend(el('span', { class: 'grant-state set-err', 'data-state': 'off', role: 'alert', text: got.failed }))
      if (!got) return say('Sundial did not answer. Try again in a moment.', 'off')
      draw(got)
    }
    const edit = () => {
      const input = el('input', { class: 'set-input', type: 'text', placeholder: s.placeholder ?? '', 'aria-label': s.label, spellcheck: 'false', autocomplete: 'off' })
      const ok = el('button', { type: 'button', class: 'set-opt', text: 'Save', onclick: save(() => input.value) })
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') ok.click()
        if (e.key === 'Escape') draw(last)
        e.stopPropagation() // the board's own keys stay out of a field
      })
      box.replaceChildren(input, ok)
      input.focus()
    }
    if (s.value === 'unset') box.replaceChildren(el('button', { type: 'button', class: 'set-opt', text: 'Set…', onclick: edit }))
    else box.replaceChildren(textState('set'), el('button', { type: 'button', class: 'set-opt', text: 'Change', onclick: edit }), el('button', { type: 'button', class: 'set-opt', text: 'Clear', onclick: save(() => '') }))
    return box
  }
  const draw = (data) => {
    if (!data || data.failed) return
    last = data
    if (restarting === null) {
      if (data.restartNeeded) {
        const n = data.waiting.length
        say(`${n === 1 ? 'One change waits' : `${n} changes wait`} for a restart: ${data.waiting.join(', ')}.`, 'off', el('button', { type: 'button', class: 'set-opt', text: 'Restart Sundial', onclick: restart }))
      } else if (Date.now() > backUntil) {
        wait.hidden = true
        wait.replaceChildren()
      }
    }
    rows.replaceChildren(
      ...data.services.map((s) => {
        if (s.sep) return s.title ? el('h4', { class: 'set-title', text: s.title }) : el('div', { class: 'set-sep' })
        const when = s.live ? 'Applies to the next Claude session.' : s.changed ? 'Waits for the restart.' : null
        const hint = [s.what, s.needs ? `Needs: ${s.needs}` : null, when].filter(Boolean).join(' ')
        const right = s.choices
          ? el(
              'div',
              { class: 'set-opts', role: 'radiogroup', 'aria-label': s.label },
              s.choices.map(([value, text]) => el('button', { type: 'button', class: 'set-opt', role: 'radio', 'aria-checked': String(value === s.value), text, onclick: pick(s, value) })),
            )
          : s.value === 'set' || s.value === 'unset'
            ? textField(s)
            : null
        return el('div', { class: 'set-row', 'data-under': s.under ? '' : null, 'data-changed': s.changed ? '' : null }, [
          el('div', { class: 'set-name' }, [el('span', { class: 'set-label', text: s.label }), el('span', { class: 'set-hint', text: hint })]),
          el('div', { class: 'set-perm' }, [health(s), right]),
        ])
      }),
    )
  }
  const read = () => call('/gnomon/api/services').then(draw)
  wait.hidden = true
  read()
  setInterval(() => node.isConnected && restarting === null && read(), 30000)
  return node
}

/**
 * What Gnomon may say first, one switch per group of notices (the kernel's
 * `notice-groups.ts`, served with the services). Kernel settings, so a change
 * is live on the next notice — no restart. A group turned off is still weighed
 * nowhere and recorded as held back, so the Unsaid list can say why.
 */
function quietBlock(groups) {
  if (!groups?.length) return null
  const quiet = new Set(SETTINGS.quiet ?? [])
  return el('div', {}, [
    el('h4', { class: 'set-title', text: 'What Gnomon says first' }),
    ...groups.map((g) =>
      choice(g.label, g.what, [[true, 'On'], [false, 'Off']], !quiet.has(g.id), (on) => {
        const next = new Set(SETTINGS.quiet ?? [])
        if (on) next.delete(g.id)
        else next.add(g.id)
        setSetting({ quiet: [...next] })
      }),
    ),
    el('p', { class: 'set-hint set-note', text: 'Questions Gnomon asks you and reminders you asked for are always said.' }),
  ])
}

/** The board's own write door, which is how a notice reaches the fold. */
const postBoard = (body) =>
  fetch('/gnomon/api/board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})

/** The settings card. Redraws itself from `SETTINGS` on every `sync`. */
export function settingsNode() {
  const body = el('div', { class: 'set-body' })
  // Outside `draw`: a settings sync must not throw away the permission rows and their poll.
  const perms = permissionsBlock()
  const services = servicesBlock()
  const node = el('div', { class: 'settings' }, [body])
  let groups = null
  call('/gnomon/api/services').then((data) => {
    groups = data?.noticeGroups ?? null
    draw()
  })
  const set = (patch) => post(patch).then((next) => next && applySettings(next))
  const draw = () => {
    const level = AUTONOMY.find(([v]) => v === SETTINGS.autonomy)
    body.replaceChildren(
      choice('Auto mode', 'How much Gnomon does unasked — speaking, the board, and running things.', AUTONOMY.map(([v, t, n]) => [v, t, n]), SETTINGS.autonomy, (v) => set({ autonomy: v })),
      el('p', { class: 'set-said', text: level?.[2] ?? '' }),
      // Only meaningful once it is allowed to speak at all.
      SETTINGS.autonomy === 'off' ? null : choice('How much is worth saying', 'Moves the same bar the gate already judges by.', BIAS, SETTINGS.noticeBias, (v) => set({ noticeBias: v })),
      SETTINGS.autonomy === 'off' ? null : quietBlock(groups),
      SETTINGS.autonomy === 'act' ? choice('Walk steps', 'A step goes on by itself unless you touch the board.', DWELL, SETTINGS.autoAdvanceMs, (v) => set({ autoAdvanceMs: v })) : null,
      el('div', { class: 'set-sep' }),
      choice('Paper', 'Every tab, not just this one.', PAPER, SETTINGS.paper, (v) => set({ paper: v })),
      choice('Card blur', 'How much a card frosts what is behind it. A blur is re-sampled every frame, so Off is also the fast one.', BLUR, SETTINGS.blur ?? 'full', (v) => set({ blur: v })),
      noticeBench(),
      choice('Motion', 'Reduced stills the board, whatever the machine says.', MOTION, SETTINGS.motion, (v) => set({ motion: v })),
      el('div', { class: 'set-sep' }),
      perms,
      el('div', { class: 'set-sep' }),
      services,
      el('p', { class: 'set-foot', text: SETTINGS.updatedAt ? `Changed ${new Date(SETTINGS.updatedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Never changed — these are the defaults.' }),
    )
  }
  node.addEventListener('sync', draw)
  draw()
  return node
}

/** Read the settings once at boot, before the live channel has said anything. */
export async function loadSettings() {
  try {
    const got = await (await fetch('/gnomon/api/settings', { headers: { accept: 'application/json' } })).json()
    if (got && typeof got === 'object') applySettings(got)
  } catch {
    // The record could not be read: the defaults stand, which is the safe end.
  }
  return SETTINGS
}
