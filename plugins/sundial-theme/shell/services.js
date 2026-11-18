// Every service Sundial can run, and how to switch it — one catalog, read by
// the /gnomon/api/services route and drawn by the Settings card.
//
// A switch here writes `$SUNDIAL_HOME/config.json`, the same file the owner
// edits by hand, and takes effect on the next restart; nothing else is
// changed, and a key the owner never set stays unset until they touch it. A
// service that needs something only the owner can do (a login, a phone
// Shortcut, a network route) says what, and has no switch. Health is the last
// time the service's own signal reached the log.
//
// Pure: no I/O, so the route and the test read the same thing.

/**
 * `path`: the config key. `values`: what the switch may write, in order, with
 * labels; the first is the code default when `fallback` is not given.
 * `signal`: `type:event` rows whose newest capture is the health. `under`: the
 * service this one refines, drawn only while that one is on. `claude`: a hook
 * in Claude Code's own settings rather than a config key — it takes effect on
 * the next Claude session, with no restart here. `now`: true when the switch
 * applies at once (its reader reads config.json per call), false when it waits
 * for a restart; unset says nothing. `ask`: said while the key holds `"ask"`,
 * a question the owner has not answered yet.
 */
export const SERVICES = [
  { sep: true, title: 'What Sundial senses' },
  { id: 'ocr', label: 'Screen text', what: 'Reads the text of the window in front, on this Mac, for moments and search.', path: 'ocr.enabled', signal: ['screen:ocr'] },
  { id: 'screenJevText', label: 'Screen text to Jev', what: 'Up to eight cleaned lines of the window in front go to your quick-judgement model (TypeSafe\'s Jev) at most every two minutes, after redaction, to say what kind of work it is. No picture.', path: 'ocr.jev.text', under: 'ocr' },
  { id: 'screenJevFrames', label: 'Screen pictures to Jev', what: 'A picture of the window in front goes to TypeSafe, downscaled to 768 pixels, at most 12 an hour and 200 a day, and only its answer is kept: what it shows, whether it is a call. Never a password prompt, a sensitive or hidden app, or Sundial itself. Off until you turn it on.', path: 'ocr.jev.frames', signal: ['screen:frame'], needs: 'TYPESAFE_API_KEY in ~/.sundial/.env and Jev as the quick-judgement model. The helper writes pictures after a rebuild of the app (pnpm sidecars:build), which asks for Screen Recording again.', under: 'ocr' },
  { id: 'vision', label: 'Screen facts', what: 'A local vision model notes up to three facts per screen.', path: 'ocr.vision.enabled', signal: ['screen:fact'], needs: 'Ollama running with the configured vision model.', under: 'ocr' },
  { id: 'pageText', label: 'Page text', what: 'The visible text of the browser tab in front.', path: 'browser.pageText', signal: ['page:text'] },
  { id: 'clipboard', label: 'Clipboard', what: 'Only the kind and size of what you copy, never the content.', path: 'clipboardEnabled', signal: ['clipboard:activity'] },
  { id: 'mail', label: 'Mail', what: 'Senders, recipients and subjects from Mail.app. Never a body.', path: 'privacy.mail', signal: ['mail:received', 'mail:sent'], needs: 'Your accounts in Mail.app. Mail read only in a browser is not seen.' },
  { id: 'messages', label: 'Messages', what: 'Who wrote in Messages, and in which chat. Never the text.', path: 'privacy.messages', signal: ['message:received'], needs: 'Full Disk Access for Sundial.' },
  { id: 'hearing', label: 'Hearing', what: 'Local transcripts of what is said near this Mac, while you press Listen.', path: 'audio.enabled', signal: ['audio:transcript'] },
  { id: 'hearMeetings', label: 'Hear meetings by itself', what: 'Every meeting with attendees and every call opens the microphone without a Listen. Nobody else is told.', path: 'audio.autoMeetings', under: 'hearing' },
  { id: 'presence', label: 'Devices nearby', what: 'Hashed devices on a network you agreed to, as a sign of where you are.', path: 'experiments.presence', signal: ['presence:scan'] },
  { id: 'vault', label: 'Obsidian vault', what: 'Notes edited today as subjects, and the day\'s journal page written into the vault.', path: 'vault', text: true, placeholder: '~/Documents/Notes' },
  { sep: true, title: 'How Gnomon reaches you' },
  { id: 'banners', label: 'Mac banners', what: 'A banner when Gnomon speaks first, with Useful, Not now and Wrong.', path: 'notifications.enabled' },
  { id: 'push', label: 'Phone push', what: 'Notices and shelved work to your phone through ntfy. The topic is as private as its name.', path: 'notifications.ntfy', text: true, placeholder: 'https://ntfy.sh/a-long-private-topic' },
  { id: 'pushAtMac', label: 'Push while at the Mac', what: 'Always: the phone hears everything. Only when away: at the Mac the banner is enough.', path: 'notifications.pushAtMac', values: [[true, 'Always'], [false, 'Only when away']], under: 'push' },
  { id: 'phone', label: 'Phone signals', what: 'Place, motion, steps and sleep from your phone. The phone posts to an ntfy topic on an always-on host, and the Mac reads what it missed when it wakes.', signal: ['phone:place', 'phone:motion', 'health:steps', 'health:sleep'], needs: 'Shortcuts or a home hub that post to that topic, and its https URL as notifications.inbox in config.json.' },
  { sep: true, title: 'Coding agents' },
  { id: 'agentTranscripts', label: 'Agent conversations', what: 'Your prompts, each final reply and each no you gave, from Claude Code, Codex, Gemini, Copilot, Cursor and opencode. Never tool output. Secrets are scrubbed before anything is saved.', path: 'privacy.agentTranscripts', fallback: true, signal: ['agent:turn'] },
  { id: 'claudeHooks', label: 'Claude reports to Gnomon', what: 'Each session tells Gnomon when it waits, asks, fails or ends. Report only: it never approves anything.', claude: 'hooks', signal: ['agent:hook'] },
  { id: 'claudeContext', label: 'Context at session start', what: 'A new session gets up to five lines: the project, its open ticket, promises, the last failure.', claude: 'context' },
  { id: 'backgroundRole', label: 'Background work', what: 'The labels on your day, the journal, the facts. Off: your providers. Claude Sonnet or Opus: your own Claude Code, on your plan. Sonnet beat qwen on 25 of 31 labels; Opus is stronger, slower and heavier on your plan. The chat keeps its own model.', path: 'llm.roles.background', values: [['', 'Providers'], ['claude:sonnet', 'Claude Sonnet'], ['claude:opus', 'Claude Opus']], needs: 'For Claude: Claude Code installed and signed in. The calls count against your plan.' },
  { id: 'judgeRole', label: 'Quick judgements', what: 'The small yes-or-no questions behind a notice, a fact, a search or a forecast. Claude picked the right tool 35 of 40 times against Jev\'s 24, and takes 2 seconds where Jev takes a quarter.', path: 'llm.roles.judge', values: [['claude:sonnet', 'Claude'], ['jev', 'Jev']], under: 'backgroundRole' },
  { id: 'jobsRole', label: 'Jobs on Claude Code', what: 'Background jobs run on your own Claude Code, read-only, capped per job.', path: 'llm.roles.jobs', values: [['', 'Off'], ['claude', 'On']], needs: 'Claude Code installed and signed in.' },
  { id: 'nightShift', label: 'Night shift', what: 'Jobs you ask for in chat run while you are away, each in its own worktree. Never pushed, never approved for you.', path: 'jobs.enabled', needs: 'tmux, and Claude Code signed in.' },
  { id: 'jobsPerNight', label: 'Jobs a night', what: 'At most this many night jobs, 90 minutes each.', path: 'jobs.maxJobsPerNight', values: [[1, '1'], [2, '2'], [3, '3']], fallback: 2, under: 'nightShift' },
  { id: 'usdPerNight', label: 'Spend a night', what: 'Claude stops a night once its estimate passes this.', path: 'jobs.maxUsdPerNight', values: [[2, '$2'], [5, '$5'], [10, '$10']], fallback: 5, under: 'nightShift' },
  { sep: true, title: 'What Gnomon may do' },
  { id: 'outward', label: 'Outward actions', what: 'Steps Gnomon takes on your screen: clicking, typing, sending and deleting in your apps. Also shell commands, calendar events, reminders and web actions. Anything final (a send, a delete, a payment) waits for your confirm every time, whatever this switch says. Off by default.', path: 'actions.outward.all', values: [['off', 'Off'], ['ask', 'Ask'], ['auto', 'Auto']] },
  { id: 'webSearch', label: 'Web search', what: 'Searches for jobs and answers, through your own SearXNG.', signal: ['web:search'], needs: 'The SearXNG container on 127.0.0.1:8888.' },
  { id: 'refutation', label: 'Nightly skeptic', what: 'Checks each night whether a fact still holds.', path: 'refutationEnabled', fallback: true },
  { sep: true, title: 'Experiments' },
  { id: 'forecasting', label: 'Forecasts', what: 'The shape of your day, predicted and scored.', path: 'experiments.forecasting' },
  { id: 'gateFeatures', label: 'Gate features', what: 'Logs what the judge saw beside every notice decision.', path: 'experiments.gateFeatures' },
  { id: 'ownerState', label: 'Your state in the gate', what: 'How you feel prices an interruption.', path: 'experiments.ownerStateInGateCost', needs: 'Two weeks of self-report taps, scoring 0.15 or better.' },
  // Next to Private apps and sites on the card. None sends text from your record; docs/privacy.md lists every call.
  { sep: true, title: 'What may leave this Mac' },
  { id: 'embeddings', label: 'Search model download', what: 'Once, about 90 MB from huggingface.co. No text from your record is sent; Hugging Face sees your IP address. Off: search matches words only.', path: 'memory.embeddings', fallback: true, now: true, ask: 'Nothing downloads until you choose.' },
  { id: 'githubPrs', label: 'GitHub pull requests', what: 'Every 5 minutes, through your own gh login, GitHub is asked about the pull requests you opened. Off: no pull request facts.', path: 'sensors.githubPrs', fallback: true, now: false },
  { id: 'atlasLibraries', label: 'Atlas libraries', what: 'In Atlas mode, your search words go to four public 3D and image libraries: Wikimedia Commons, Poly Pizza, Smithsonian 3D and BodyParts3D. Off: Atlas uses only the files it already has.', path: 'atlas.libraries', fallback: true, now: true },
]

export const getPath = (obj, path) => path.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), obj)

/** A copy of `obj` with `path` set, creating the objects on the way. */
export function setPath(obj, path, value) {
  const out = structuredClone(obj ?? {})
  const keys = path.split('.')
  let at = out
  for (const k of keys.slice(0, -1)) at = at[k] = at[k] && typeof at[k] === 'object' ? at[k] : {}
  at[keys[keys.length - 1]] = value
  return out
}

const choices = (s) => s.values ?? [[false, 'Off'], [true, 'On']]

/** The value a service has in a config file, with the code default for an unset key. */
export function valueOf(service, config) {
  if (!service.path) return null
  const v = getPath(config, service.path)
  if (service.text) return typeof v === 'string' && v.trim() !== '' ? 'set' : 'unset'
  if (v === undefined || v === null) return service.fallback ?? choices(service)[0][0]
  // A role is an ordered list; the switch shows its head.
  return Array.isArray(v) ? (v[0] ?? choices(service)[0][0]) : v
}

/**
 * A text value the owner typed, cleaned, or null when this service does not
 * take it. An empty string clears the key. `push`: an http(s) ntfy URL.
 * `vault`: an absolute (or `~/`) folder path; whether it exists is the route's
 * to check.
 */
export function textValue(service, value) {
  if (!service?.text || typeof value !== 'string') return null
  const v = value.trim()
  if (v === '') return ''
  if (v.length > 500 || /[\u0000-\u001f]/.test(v)) return null
  if (service.id === 'push') return /^https?:\/\/[^\s]+$/.test(v) ? v : null
  if (service.id === 'vault') return /^(\/|~\/)/.test(v) ? v.replace(/\/+$/, '') : null
  return null
}

/** Whether a POSTed value is one this service's switch may write. */
export const allowed = (service, value) => Boolean(service?.path || service?.claude) && !service.text && choices(service).some(([v]) => v === value)

/** Whether a service is on, for the ones drawn `under` it. A set text value counts. */
const isOn = (v) => v !== false && v !== 'off' && v !== 'normal' && v !== 'unset' && v !== null && v !== ''

/**
 * The rows the card draws: each service with its value in the saved file, the
 * value this process booted with, its choices, and its last signal. `blocked`:
 * service id → why it cannot be turned on yet.
 */
export function describe(config, pendingRestart, freshness, claude = {}, blocked = {}) {
  const last = new Map(freshness.map((f) => [`${f.signalType}:${f.eventType}`, f.lastCapturedAt]))
  const value = (s) => (s.claude ? claude[s.claude] === true : valueOf(s, config))
  const byId = new Map(SERVICES.filter((s) => !s.sep).map((s) => [s.id, s]))
  return SERVICES.flatMap((s) => {
    if (s.sep) return [{ sep: true, title: s.title ?? null }]
    // A refinement of a service that is off has nothing to refine.
    if (s.under && !isOn(value(byId.get(s.under)))) return []
    return [
      {
        id: s.id,
        label: s.label,
        what: s.what,
        needs: s.needs ?? null,
        // Something missing on this Mac: said in the row, and the switch cannot go On.
        blocked: blocked[s.id] ?? null,
        value: value(s),
        // W3: waiting for a restart, by the log's own list (`state.config.pendingRestart`).
        changed: s.path ? pendingRestart.some((p) => s.path === p || s.path.startsWith(`${p}.`) || p.startsWith(`${s.path}.`)) : false,
        live: Boolean(s.claude),
        now: s.now ?? null,
        ask: s.ask && value(s) === 'ask' ? s.ask : null,
        under: s.under ?? null,
        choices: (s.path || s.claude) && !s.text ? choices(s) : null,
        placeholder: s.text ? (s.placeholder ?? '') : null,
        watched: (s.signal ?? []).length > 0,
        lastSignal: (s.signal ?? []).map((t) => last.get(t)).filter(Boolean).sort().pop() ?? null,
      },
    ]
  })
}
