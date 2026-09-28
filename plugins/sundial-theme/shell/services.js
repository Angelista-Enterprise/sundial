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
 * `signal`: `type:event` rows whose newest capture is the health.
 */
export const SERVICES = [
  { id: 'ocr', label: 'Screen text', what: 'Reads the text of the window in front, on this Mac, for moments and search.', path: 'ocr.enabled', signal: ['screen:ocr'] },
  { id: 'vision', label: 'Screen facts', what: 'A local vision model notes up to three facts per screen.', path: 'ocr.vision.enabled', signal: ['screen:fact'], needs: 'Ollama running with the configured vision model.' },
  { id: 'pageText', label: 'Page text', what: 'The visible text of the browser tab in front.', path: 'browser.pageText', signal: ['page:text'] },
  { id: 'clipboard', label: 'Clipboard', what: 'Only the kind and size of what you copy, never the content.', path: 'clipboardEnabled', signal: ['clipboard:activity'] },
  { id: 'mail', label: 'Mail and Messages', what: 'Senders and subjects from Mail.app and Messages. Never a body.', path: 'privacy.mail', signal: ['mail:received', 'message:received'], needs: 'Your accounts in Mail.app. Mail read only in a browser is not seen.' },
  { id: 'hearing', label: 'Hearing', what: 'Local transcripts of meetings and calls, both sides. Wakes for the calendar and for calls.', path: 'audio.enabled', signal: ['audio:transcript'] },
  { id: 'presence', label: 'Devices nearby', what: 'Hashed devices on a network you agreed to, as a sign of where you are.', path: 'experiments.presence', signal: ['presence:scan'] },
  { sep: true },
  { id: 'banners', label: 'Mac banners', what: 'A banner when Gnomon speaks first, with Useful, Not now and Wrong.', path: 'notifications.enabled' },
  { id: 'push', label: 'Phone push', what: 'Notices and shelved work to your phone through ntfy.', path: 'notifications.ntfy', text: true, needs: 'An ntfy topic URL in notifications.ntfy.' },
  { id: 'phone', label: 'Phone signals', what: 'Place, sleep and health from your phone.', signal: ['phone:place', 'phone:sleep', 'health:sleep'], needs: 'Tailscale running, a Serve route to port 8767, and the Shortcuts on the phone.' },
  { sep: true },
  { id: 'outward', label: 'Outward actions', what: 'Shell commands, calendar events and web actions Gnomon may take.', path: 'actions.outward.all', values: [['off', 'Off'], ['ask', 'Ask'], ['auto', 'Auto']] },
  { id: 'hands', label: 'Claude as hands', what: 'Background jobs run on your Claude Code, read-only, capped per job.', path: 'hands.claude', needs: 'Claude Code installed and signed in.' },
  { id: 'webSearch', label: 'Web search', what: 'Searches for jobs and answers, through your own SearXNG.', signal: ['web:search'], needs: 'The SearXNG container on 127.0.0.1:8888.' },
  { id: 'refutation', label: 'Nightly skeptic', what: 'Checks each night whether a fact still holds.', path: 'refutationEnabled', fallback: true },
  { sep: true },
  { id: 'forecasting', label: 'Forecasts', what: 'The shape of your day, predicted and scored.', path: 'experiments.forecasting' },
  { id: 'gateFeatures', label: 'Gate features', what: 'Logs what the judge saw beside every notice decision.', path: 'experiments.gateFeatures' },
  { id: 'learnedGate', label: 'Learned gate', what: 'A fitted model replaces the fixed notice bar. Only once it wins on held-out data.', path: 'experiments.learnedGate' },
  { id: 'ownerState', label: 'Your state in the gate', what: 'How you feel prices an interruption. Needs two weeks of self-report taps first.', path: 'experiments.ownerStateInGateCost' },
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
  return v
}

/** Whether a POSTed value is one this service's switch may write. */
export const allowed = (service, value) => Boolean(service?.path) && !service.text && choices(service).some(([v]) => v === value)

/**
 * The rows the card draws: each service with its value in the saved file, the
 * value this process booted with, its choices, and its last signal.
 */
export function describe(config, booted, freshness) {
  const last = new Map(freshness.map((f) => [`${f.signalType}:${f.eventType}`, f.lastCapturedAt]))
  return SERVICES.map((s) =>
    s.sep
      ? { sep: true }
      : {
          id: s.id,
          label: s.label,
          what: s.what,
          needs: s.needs ?? null,
          value: valueOf(s, config),
          changed: s.path ? valueOf(s, config) !== valueOf(s, booted) : false,
          choices: s.path && !s.text ? choices(s) : null,
          watched: (s.signal ?? []).length > 0,
          lastSignal: (s.signal ?? []).map((t) => last.get(t)).filter(Boolean).sort().pop() ?? null,
        },
  )
}
