// The first-run page: one reading (/gnomon/setup), redrawn every few seconds
// while the tab is visible, so a grant or the first observations show up
// without a reload. Plain DOM, no framework, like the rest of the client.

import { PERMS, grantAction, inApp, tellApp } from './permissions.js'

const $ = (id) => document.getElementById(id)

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v
    else node.setAttribute(k, v)
  }
  for (const c of children) node.append(c)
  return node
}

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (s < 60) return `${s} second${s === 1 ? '' : 's'} ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`
  return `${Math.round(h / 24)} days ago`
}

const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** The proof that capture works: the count, and the last few moments it made of them. */
function drawRecord({ count, last }, moments = []) {
  $('record').textContent =
    count === 0
      ? 'Nothing recorded yet. The first observations arrive within a minute of the sensors starting.'
      : `${count.toLocaleString()} observation${count === 1 ? '' : 's'} so far. The last one came in ${ago(last)}.`
  $('moments').replaceChildren(
    ...moments.map((m) => el('li', { class: 'setup-moment' }, el('span', { class: 'setup-moment-time', text: `${clock(m.start)}–${clock(m.end)}` }), el('strong', { text: m.app }), m.title && m.title !== m.app ? el('span', { class: 'setup-moment-title', text: m.title }) : '')),
  )
  $('moments-lead').hidden = moments.length === 0
}

function status(granted, optional) {
  // An optional grant that is off is the expected state, not a warning.
  if (optional && granted !== true) return el('span', { class: 'grant-state', 'data-state': 'unknown', text: 'Off' })
  if (granted === true) return el('span', { class: 'grant-state', 'data-state': 'on', text: 'Granted' })
  if (granted === false) return el('span', { class: 'grant-state', 'data-state': 'off', text: 'Not granted' })
  return el('span', { class: 'grant-state', 'data-state': 'unknown', text: 'Waiting for the sensor' })
}

function drawPerms(list) {
  const rows = list
    .filter((p) => PERMS[p.key])
    .sort((a, b) => Number(Boolean(PERMS[a.key].optional)) - Number(Boolean(PERMS[b.key].optional)))
    .map((p) => {
      const info = PERMS[p.key]
      const name = el('h3', { class: 'grant-name', text: p.label })
      if (info.optional) name.append(el('span', { class: 'grant-optional', text: 'optional' }))
      return el(
        'li',
        { class: 'grant' },
        el('div', { class: 'grant-text' }, name, el('p', { class: 'grant-what', text: info.what })),
        status(p.granted, info.optional),
        p.granted === true ? el('span', { class: 'grant-act' }) : grantAction(p.key, 'grant-act'),
      )
    })
  $('perms').replaceChildren(...rows)
}

// ── A model for Gnomon ─────────────────────────────────────────────────
// Its own reading (/gnomon/api/providers), never redrawn by the 3 s loop:
// that would wipe a half-typed key. Keys go in and never come back out.

const PRESETS = [
  { name: 'Ollama on this Mac', baseUrl: 'http://127.0.0.1:11434/v1', local: true },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { name: 'Other', baseUrl: '' },
]

let models = { default: null, providers: [], use: {}, restartNeeded: false }
/** The chat's default model (/gnomon/api/models), or null until read. */
let chat = null

/** The background work /setup can route, in the order a person meets it. Mirrors USE_PURPOSES in server.js. */
const WORK = [
  ['intent', 'Naming each moment'],
  ['companion', 'The note on something it tells you'],
  ['extract', 'Facts and promises from your day'],
  ['journal', 'The journal and project status'],
  ['reflect', 'Reflection on your days'],
  ['refute', 'Checking what it believes'],
  ['goal', 'Plans for your goals'],
  ['transcript', 'Cleaning up what it heard'],
]
/** The one open form: `{ target, row }`, or null. */
let editing = null

async function providersPost(body) {
  const res = await fetch('/gnomon/api/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.unavailable ?? `Sundial answered ${res.status}.`)
  return data
}

function privacyLine(row) {
  return row.local
    ? 'It runs on this Mac, so nothing leaves it.'
    : `Sanitized text from your record goes to ${row.label} when Gnomon writes or answers. Every call is listed in the Ledger.`
}

function rowActs(target, row) {
  const change = el('button', { type: 'button', class: 'setup-link', text: 'Change' })
  change.addEventListener('click', () => {
    editing = { target, row }
    drawModels()
  })
  const remove = el('button', { type: 'button', class: 'setup-link', text: 'Remove' })
  remove.addEventListener('click', async () => {
    if (remove.dataset.confirm !== '1') {
      remove.dataset.confirm = '1'
      remove.textContent = 'Remove it?'
      return
    }
    models = await providersPost({ op: 'remove', target })
    editing = null
    drawModels()
  })
  return el('span', { class: 'model-acts' }, change, remove)
}

function form({ target, row }) {
  const isDefault = target === 'default'
  const node = el('form', { class: 'model-form', novalidate: '' })
  const presetRow = el('div', { class: 'model-presets', role: 'group', 'aria-label': 'Provider' })
  const base = el('input', { class: 'model-input', type: 'url', id: 'm-base', spellcheck: 'false', autocomplete: 'off', placeholder: 'https://…/v1' })
  const key = el('input', { class: 'model-input', type: 'password', id: 'm-key', spellcheck: 'false', autocomplete: 'off' })
  const model = el('input', { class: 'model-input', type: 'text', id: 'm-model', spellcheck: 'false', autocomplete: 'off', list: 'm-models', placeholder: 'Press Check to list the models' })
  const list = el('datalist', { id: 'm-models' })
  const label = el('input', { class: 'model-input model-text', type: 'text', id: 'm-label', spellcheck: 'false', autocomplete: 'off' })
  const keyHint = el('p', { class: 'fill-hint' })
  const out = el('p', { class: 'fill-note model-out', role: 'status', 'aria-live': 'polite' })
  base.value = row?.baseUrl ?? ''
  model.value = row?.model ?? ''
  label.value = row?.label ?? ''

  const syncKey = () => {
    const local = /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:|\/|$)/.test(base.value.trim())
    key.placeholder = row?.hasKey ? 'Saved. Leave empty to keep it.' : local ? 'Not needed for a model on this Mac' : 'Paste the API key'
    keyHint.textContent = local ? 'A model on this Mac needs no key, and nothing leaves the Mac.' : 'The key stays in your .env file on this Mac. Sundial never shows it again.'
    for (const chip of presetRow.children) chip.setAttribute('aria-pressed', String(chip.dataset.url !== '' && base.value.trim().replace(/\/+$/, '') === chip.dataset.url))
  }
  for (const preset of PRESETS) {
    const chip = el('button', { type: 'button', class: 'model-chip', 'data-url': preset.baseUrl, 'aria-pressed': 'false', text: preset.name })
    chip.addEventListener('click', () => {
      base.value = preset.baseUrl
      if (!isDefault && preset.baseUrl !== '') label.value = preset.name
      list.replaceChildren()
      syncKey()
      ;(preset.baseUrl === '' ? base : preset.local ? model : key).focus()
    })
    presetRow.append(chip)
  }
  base.addEventListener('input', syncKey)

  const check = el('button', { type: 'button', class: 'setup-button', text: 'Check' })
  check.addEventListener('click', async () => {
    check.disabled = true
    out.dataset.state = ''
    out.textContent = 'Asking the provider…'
    try {
      const answer = await providersPost({ op: 'check', baseUrl: base.value, apiKey: key.value, target })
      if (!answer.ok) throw new Error(answer.error)
      list.replaceChildren(...answer.models.map((id) => el('option', { value: id })))
      out.dataset.state = 'ok'
      out.textContent = answer.models.length > 0 ? `Connected. ${answer.label} lists ${answer.models.length} model${answer.models.length === 1 ? '' : 's'}; pick one in the model field.` : `Connected to ${answer.label}. It lists no models, so type the model name.`
      if (model.value === '' && answer.models.length === 1) model.value = answer.models[0]
      model.focus()
    } catch (error) {
      out.dataset.state = 'error'
      out.textContent = `${error.message} Check the address and the key.`
    } finally {
      check.disabled = false
    }
  })

  const field = (text, input, ...more) => el('div', { class: 'model-field' }, el('label', { class: 'fill-label', for: input.id, text }), input, ...more)
  const cancel = el('button', { type: 'button', class: 'setup-link', text: 'Cancel' })
  cancel.addEventListener('click', () => {
    editing = null
    drawModels()
  })
  const save = el('button', { type: 'submit', class: 'setup-button', 'data-primary': '', text: isDefault ? 'Use this model' : 'Save provider' })
  node.addEventListener('submit', async (event) => {
    event.preventDefault()
    save.disabled = true
    try {
      models = await providersPost({ op: 'save', target, baseUrl: base.value, model: model.value, apiKey: key.value, label: label.value })
      editing = null
      drawModels()
    } catch (error) {
      out.dataset.state = 'error'
      out.textContent = error.message
      save.disabled = false
    }
  })

  node.append(
    presetRow,
    field('Address', base),
    field('API key', key, keyHint),
    el('div', { class: 'model-field' }, el('label', { class: 'fill-label', for: 'm-model', text: 'Model' }), el('div', { class: 'model-pair' }, model, check), list),
    ...(isDefault ? [] : [field('Name in the model picker', label)]),
    out,
    el('div', { class: 'fill-acts' }, save, cancel),
  )
  syncKey()
  return node
}

function drawModels() {
  const box = $('model')
  const nodes = []
  const d = models.default
  if (d) {
    nodes.push(
      el('div', { class: 'model-row' },
        el('div', {},
          el('p', { class: 'setup-prose' }, 'Gnomon’s own model is ', el('strong', { text: d.model || 'no model named' }), ` on ${d.label}. Below, choose which model does what.`),
          el('p', { class: 'fill-note', text: privacyLine(d) }),
        ),
        rowActs('default', d)),
    )
  } else if (editing?.target !== 'default') {
    nodes.push(el('p', { class: 'setup-prose', text: 'No model yet. Sundial still records, and Today still shows your day. Gnomon’s chat and its written summaries need a model.' }))
    const add = el('button', { type: 'button', class: 'setup-button', 'data-primary': '', text: 'Choose a model' })
    add.addEventListener('click', () => {
      editing = { target: 'default', row: null }
      drawModels()
    })
    nodes.push(el('div', { class: 'fill-acts' }, add))
  }
  if (editing?.target === 'default') {
    if (!d) nodes.push(el('p', { class: 'setup-prose', text: 'Choose where Gnomon’s model runs. On this Mac, nothing leaves it; any OpenAI-compatible service works too.' }))
    nodes.push(form(editing))
  }

  if (d && (models.providers.length > 0 || editing?.target !== 'default')) {
    const others = el('div', { class: 'model-others' }, el('h3', { class: 'model-sub', text: 'More providers' }))
    if (models.providers.length === 0) others.append(el('p', { class: 'fill-note', text: 'Add another provider to give it some of the work, or all of it.' }))
    const ul = el('ul', { class: 'model-list' })
    for (const p of models.providers) {
      ul.append(el('li', { class: 'model-row' },
        el('div', {}, el('p', { class: 'model-name', text: p.label }), el('p', { class: 'fill-note' }, el('code', { text: p.model }), ` · ${p.local ? 'on this Mac' : new URL(p.baseUrl).host}`)),
        rowActs(p.id, p)))
      if (editing?.target === p.id) ul.append(el('li', { class: 'model-edit' }, form(editing)))
    }
    if (ul.children.length > 0) others.append(ul)
    if (editing?.target === 'new') others.append(form(editing))
    else if (editing === null) {
      const add = el('button', { type: 'button', class: 'setup-button', text: 'Add a provider' })
      add.addEventListener('click', () => {
        editing = { target: 'new', row: null }
        drawModels()
      })
      others.append(el('div', { class: 'fill-acts' }, add))
    }
    nodes.push(others)
  }

  if (models.providers.length > 0 && editing === null) nodes.push(whoDoesWhat())

  if (models.restartNeeded) {
    const restart = el('button', { type: 'button', class: 'setup-button', 'data-primary': '', text: 'Restart Sundial' })
    const say = el('span', { class: 'fill-note', text: 'Saved. Sundial uses it after a restart.' })
    restart.addEventListener('click', async () => {
      restart.disabled = true
      say.textContent = 'Restarting…'
      try {
        const answer = await providersPost({ op: 'restart' })
        if (!answer.restarted) {
          say.replaceChildren('Run ', el('code', { text: answer.command }), ' in a terminal, then reload this page.')
          return
        }
        await new Promise((r) => setTimeout(r, 2500))
        for (let i = 0; i < 60; i++) {
          const ok = await fetch('/gnomon/api/providers').then((r) => r.ok, () => false)
          if (ok) return location.reload()
          await new Promise((r) => setTimeout(r, 1000))
        }
        say.textContent = 'Sundial has not come back yet. Run sundial status in a terminal.'
      } catch (error) {
        say.textContent = error.message
        restart.disabled = false
      }
    })
    nodes.push(el('div', { class: 'model-restart', role: 'status' }, say, restart))
  }
  box.replaceChildren(...nodes)
  box.querySelector('.model-form input')?.focus({ preventScroll: true })
}

/** One select per kind of work: the chat (live), the background default, and each purpose (after a restart). */
function whoDoesWhat() {
  const routes = [...(models.default ? [models.default] : []), ...models.providers]
  const option = (r) => el('option', { value: r.id, text: `${r.label} · ${r.model}` })
  const pick = (id, label, value, options, onChange) => {
    const select = el('select', { class: 'model-input use-select', id: `use-${id}` }, ...options)
    select.value = value
    select.addEventListener('change', async () => {
      select.disabled = true
      try {
        await onChange(select.value)
      } catch (error) {
        note.dataset.state = 'error'
        note.textContent = error.message
      } finally {
        select.disabled = false
      }
    })
    return el('li', { class: 'use-row' }, el('label', { class: 'use-label', for: select.id, text: label }), select)
  }
  const note = el('p', { class: 'fill-note model-out', role: 'status', 'aria-live': 'polite' })
  const save = async (purpose, target) => {
    models = await providersPost({ op: 'use', purpose, target })
    drawModels()
  }
  const ul = el('ul', { class: 'model-list use-list' })
  const chatRoute = routes.find((r) => r.id === chat?.provider)
  ul.append(pick('chat', 'The chat', chatRoute?.id ?? '', [...(chatRoute ? [] : [el('option', { value: '', text: chat ? `${chat.provider} · ${chat.model}` : 'Reading…' })]), ...routes.map(option)], async (id) => {
    const r = routes.find((x) => x.id === id)
    const res = await fetch('/gnomon/api/model', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: r.id, model: r.model }) })
    if (!res.ok) throw new Error(`Sundial answered ${res.status}.`)
    chat = (await res.json()).current
    note.dataset.state = 'ok'
    note.textContent = `New chats use ${r.label}. A chat that is open keeps its model; switch it in its model picker.`
  }))
  const fallback = models.use.default ?? 'openai'
  const same = routes.find((r) => r.id === fallback)
  ul.append(pick('default', 'Everything else, unless set below', same?.id ?? '', [...(same ? [] : [el('option', { value: '', text: 'Nothing chosen yet' })]), ...routes.map(option)], (id) => save('default', id === 'openai' ? '' : id)))
  for (const [purpose, label] of WORK) {
    const own = models.use[purpose]
    ul.append(pick(purpose, label, routes.some((r) => r.id === own) ? own : '', [el('option', { value: '', text: 'Same as above' }), ...routes.map(option)], (id) => save(purpose, id)))
  }
  const remote = routes.filter((r) => !r.local).map((r) => r.label)
  return el('div', { class: 'model-others' },
    el('h3', { class: 'model-sub', text: 'Who does what' }),
    el('p', { class: 'fill-note use-intro', text: remote.length > 0 ? `Work you give to ${remote.join(' or ')} sends sanitized text there. Every call is listed in the Ledger, with its price.` : 'Every model here runs on this Mac, so nothing leaves it.' }),
    ul,
    note)
}

fetch('/gnomon/api/models', { headers: { accept: 'application/json' } })
  .then((res) => (res.ok ? res.json() : null))
  .then((data) => {
    if (!data?.current) return
    chat = data.current
    if (editing === null && models.providers.length > 0) drawModels()
  })
  .catch(() => {})

fetch('/gnomon/api/providers', { headers: { accept: 'application/json' } })
  .then((res) => (res.ok ? res.json() : null))
  .then((data) => {
    if (!data) return
    models = data
    drawModels()
  })
  .catch(() => {})

async function read() {
  try {
    const res = await fetch('/gnomon/setup', { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(String(res.status))
    const data = await res.json()
    $('app-path').textContent = data.app ?? `${data.home}/Sundial.app`
    $('bundle-id').textContent = data.bundleId
    drawRecord(data.record, data.moments)
    drawPerms(data.permissions)
  } catch {
    $('record').textContent = 'Sundial did not answer. Is it running? Try `sundial status` in a terminal.'
  }
}

$('copy-path').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('app-path').textContent)
    $('copy-path').textContent = 'Copied'
    setTimeout(() => ($('copy-path').textContent = 'Copy path'), 1600)
  } catch {
    $('copy-path').textContent = 'Select and copy it'
  }
})

// Seen once is enough: `/` stops sending this browser here.
document.querySelector('.setup-go').addEventListener('click', () => {
  tellApp({ setupDone: true })
  try {
    localStorage.setItem('sundial-setup-seen', '1')
  } catch {}
})

// ── Start with your history ────────────────────────────────────────────
// Read on load only, never on the 3 s redraw: that loop would wipe what the
// owner is typing. Find counts and writes nothing; Read writes.

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

function fillOptions() {
  return {
    roots: $('fill-roots').value.split('\n').map((r) => r.trim()).filter(Boolean),
    gitDays: Number($('fill-git').value),
    calendarDays: Number($('fill-cal').value),
    mailDays: Number($('fill-mail').value),
  }
}

async function fillPost(body) {
  const res = await fetch('/gnomon/api/backfill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.unavailable ?? `Sundial answered ${res.status}.`)
  return data
}

function fillSay(...nodes) {
  $('fill-out').replaceChildren(...nodes)
}

function lastLine(last) {
  if (!last) return null
  const also = [last.meetings === null ? null : plural(last.meetings, 'meeting'), typeof last.mails === 'number' ? plural(last.mails, 'mail') : null].filter(Boolean)
  return el('p', { class: 'fill-last', text: `Last read ${ago(last.at)}: ${[plural(last.commits, 'commit'), ...also].join(', ')}. Reading again adds only what is new.` })
}

function drawPlan(plan) {
  const found = plan.repos.filter((r) => r.commits > 0).sort((a, b) => b.commits - a.commits)
  const quiet = plan.repos.length - found.length
  const nodes = []
  if (plan.repos.length === 0) nodes.push(el('p', { class: 'fill-note', text: 'No git repositories in these folders.' }))
  if (found.length > 0) {
    nodes.push(el('ul', { class: 'fill-repos' }, ...found.map((r) => el('li', {}, el('code', { text: r.path }), el('span', { class: 'fill-n', text: plural(r.commits, 'commit') })))))
  }
  if (quiet > 0) nodes.push(el('p', { class: 'fill-note', text: `${plural(quiet, 'more repository', 'more repositories')} with nothing new.` }))
  nodes.push(
    el('p', { class: 'fill-note', text: plan.meetings === null ? 'Calendar is not granted yet, so no meetings. Grant it above, then press Find again.' : `${plural(plan.meetings, 'meeting')} you went to.` }),
  )
  nodes.push(
    el('p', { class: 'fill-note', text: plan.mails === null ? 'Mail.app has no index Sundial can read. Add your account to Mail, and grant Full Disk Access above.' : `${plural(plan.mails, 'mail')} received — the sender and subject only.` }),
  )
  fillSay(...nodes)
  const meetings = plan.meetings ?? 0
  const mails = plan.mails ?? 0
  const go = $('fill-go')
  go.hidden = plan.commits + meetings + mails === 0
  go.textContent = [plan.commits > 0 ? plural(plan.commits, 'commit') : null, meetings > 0 ? plural(meetings, 'meeting') : null, mails > 0 ? plural(mails, 'mail') : null].filter(Boolean).join(', ').replace(/, ([^,]*)$/, ' and $1').replace(/^/, 'Read ')
  if (go.hidden) $('fill-out').append(el('p', { class: 'fill-note', text: 'Nothing new to read here.' }))
}

function fillBusy(busy, label) {
  for (const id of ['fill-roots', 'fill-git', 'fill-cal', 'fill-mail', 'fill-find', 'fill-go']) $(id).disabled = busy
  $('fill').setAttribute('aria-busy', String(busy))
  if (label) fillSay(el('p', { class: 'fill-note', text: label }))
}

$('fill').addEventListener('submit', async (event) => {
  event.preventDefault()
  $('fill-go').hidden = true
  fillBusy(true, 'Looking…')
  try {
    drawPlan(await fillPost({ ...fillOptions(), dryRun: true }))
  } catch (error) {
    fillSay(el('p', { class: 'fill-error', text: `Sundial could not look there. ${error.message}` }))
  } finally {
    fillBusy(false)
  }
})

$('fill-go').addEventListener('click', async () => {
  fillBusy(true, 'Reading. A month of commits takes a few seconds.')
  $('fill-go').hidden = true
  try {
    const done = await fillPost(fillOptions())
    const also = [done.meetings === null ? null : plural(done.meetings, 'meeting'), done.mails === null || done.mails === undefined ? null : plural(done.mails, 'mail')].filter(Boolean)
    fillSay(
      el('p', { class: 'fill-done', text: `Done. Read ${plural(done.commits, 'commit')} from ${plural(done.repos, 'repository', 'repositories')}${also.map((a) => `, ${a}`).join('')}.` }),
      el('p', { class: 'fill-note' }, 'Ask Gnomon what you worked on last week, from ', el('a', { href: '/', text: 'Today' }), '.'),
    )
  } catch (error) {
    fillSay(el('p', { class: 'fill-error', text: `The read stopped. ${error.message} What was read before it stopped is kept; press Find to see what is left.` }))
  } finally {
    fillBusy(false)
  }
})

// A changed reach makes the count stale: ask for a new one.
for (const id of ['fill-roots', 'fill-git', 'fill-cal', 'fill-mail']) {
  $(id).addEventListener('input', () => {
    if ($('fill-go').hidden) return
    $('fill-go').hidden = true
    fillSay(el('p', { class: 'fill-note', text: 'Press Find again to count with the new reach.' }))
  })
}

fetch('/gnomon/api/backfill', { headers: { accept: 'application/json' } })
  .then((res) => (res.ok ? res.json() : null))
  .then((data) => {
    if (!data) return
    $('fill-roots').value = data.roots.join('\n')
    $('fill-git').value = String(data.gitDays)
    $('fill-cal').value = String(data.calendarDays)
    $('fill-mail').value = String(data.mailDays ?? 7)
    const last = lastLine(data.last)
    if (last) fillSay(last)
  })
  .catch(() => {})

// Inside the app, a grant needs no restart by hand and no path to paste.
if (inApp()) for (const node of document.querySelectorAll('[data-browser-only]')) node.hidden = true
for (const node of document.querySelectorAll('[data-app-only]')) node.hidden = !inApp()

read()
setInterval(() => {
  if (document.visibilityState === 'visible') read()
}, 3000)
