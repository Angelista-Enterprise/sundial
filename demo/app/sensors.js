// Every sensor Gnomon has, and what would make it speak.
//
// **This exists because ranking sensors by silence measures the owner's week,
// not the machine's health.** The card shipped a list called "Sensors,
// quietest first" whose top rows were `presence:consent` at 54 days and
// `ask:answered` at 38 — one a single consent grant, the other the surface I7
// deleted. 69 of its 96 rows were not sensors at all but internal events
// (`board:step`, `llm:dispatched`, `judgement:result`, `clock:tick`), because
// the route derived the list from every event type in the log.
//
// The audit's brief asked for a health summary — "64 live / 18 quiet / 8
// dead". **That summary is not computable, and the reason is worth writing
// down once.** Emission in Gnomon has three shapes, and only one of them makes
// silence a fault:
//
//   * **A heartbeat** emits on its cadence whether or not anything happened.
//     Exactly ONE sensor does this — `input:activity`, which the Swift helper
//     drives on a fixed 10-second window regardless of activity. Its silence
//     is a fault, and it is also why every coverage figure in Gnomon is
//     measured from it.
//   * **A state sensor** polls but emits only when its value CHANGES, and the
//     dedupe lives durably in `state.observed` (`STATE_SCOPES` in
//     `state-signature.ts`) so it survives a restart. `location:network` quiet
//     for 23 hours means the owner did not change network. It looks exactly
//     like a dead poller in the log and is not one.
//   * **An occurrence sensor** fires when the world does something.
//     `git:push` quiet for eight days means the owner has not pushed.
//
// So a traffic light over the roster would be green, amber and red for the
// same underlying fact — nothing happened — and would cry wolf about
// seventeen of the twenty. What the card does instead is say, per sensor, what
// would make it speak, and when it last did. The owner learns the machine
// rather than reading a light that cannot mean anything.
//
// The table is transcribed from `almanac/reference/sensor-event-catalog.md`,
// which is the maintained record of what each sensor emits and how — and
// every row carries the `package` it came from, so `sensors.test.js` can hold
// the list against `packages/sensors/src` itself. That check earned its keep
// on the first run: the almanac says twenty sensors and the codebase has
// twenty-one, because `browser` was added after that page was written. A
// sensor that reads the owner's open tabs had no row on the trust card, which
// is the single worst omission this surface can have. It earned its keep a
// second time within the hour: `mail`, `vault` and `screen-vision` landed in
// the codebase the same afternoon, and the first of those reads the subjects
// and senders of the owner's email.

/** Why a sensor speaks — and therefore what its silence does and does not mean. */
export const SPEECH = {
  heartbeat: {
    word: 'on a clock',
    means: 'Emits every cycle whether or not anything happened, so silence here is the one silence that is a fault — and the one this whole card is measured from.',
  },
  state: {
    word: 'when it changes',
    means: 'Polls, but only speaks when its value is different from last time. Quiet means the value held, not that the sensor stopped; the dedupe lives in durable state so it survives a restart.',
  },
  event: {
    word: 'when it happens',
    means: 'Fires when the world does something. Quiet means nothing happened.',
  },
}

/**
 * The twenty sensors, their event types, and what makes each one speak.
 *
 * `optIn` marks a sensor that does nothing unless the owner turned it on — the
 * card says which of those are ON, because a clipboard poller and a screen
 * reader running are exactly the facts a trust surface owes the owner.
 * `pushed` marks the phone family, which is not a sensor at all: those arrive
 * already formed at `POST /ingest/phone` from a paired iOS app.
 */
export const SENSORS = [
  { name: 'input activity', package: 'input-activity', events: ['input:activity'], speech: 'heartbeat', does: 'counts keys and clicks, never what was typed' },
  { name: 'window', package: 'window', events: ['window:changed'], speech: 'state', does: 'which app and window is in front' },
  { name: 'project', package: 'project', events: ['project:detected', 'project:switched'], speech: 'state', does: 'which repository the work is in' },
  { name: 'agent session', package: 'agent-session', events: ['agent:session', 'agent:fleet', 'agent:hook', 'agent:turn'], speech: 'state', does: 'where each coding agent works, what it waits on, and what you asked it' },
  { name: 'focus mode', package: 'focus-mode', events: ['focus-mode:changed'], speech: 'state', does: 'whether Do Not Disturb is on' },
  { name: 'audio and camera', package: 'audio-context', events: ['media:state'], speech: 'state', does: 'whether the mic or camera is live' },
  { name: 'network', package: 'location-network', events: ['location:network'], speech: 'state', does: 'which network you are on, as a fingerprint' },
  { name: 'power', package: 'system-power', events: ['system:power'], speech: 'state', does: 'battery and whether it is charging' },
  { name: 'bluetooth audio', package: 'bluetooth-audio', events: ['audio:device-changed'], speech: 'state', does: 'which headphones are connected' },
  { name: 'notifications', package: 'notification', events: ['event:notification'], speech: 'state', does: 'how many Dock badges are waiting' },
  // `page:text` was missing until the Trace card asked this roster which of
  // its trigger events came from the world: the browser sensor emits three
  // types (`browser/index.ts` pushes it beside the tab and the status) and the
  // roster claimed two, so 24 journal rows provoked by a real page read were
  // filed as Gnomon talking to itself. The roster is held against the sensor
  // DIRECTORY, which cannot catch a missing event type — this one was caught
  // by a second surface reading it.
  { name: 'browser', package: 'browser', events: ['browser:tab', 'browser:status', 'page:text'], speech: 'state', does: 'the host and path of the tab in front — and the visible text of the page, never the query string' },
  { name: 'transcription', package: 'audio-transcript', events: ['audio:transcript'], speech: 'event', does: 'speech turned to text, on this machine' },
  { name: 'git', package: 'git', events: ['git:status', 'git:commit', 'git:push'], speech: 'event', does: 'commits, pushes and a dirty tree' },
  { name: 'shell', package: 'shell', events: ['shell:command'], speech: 'event', does: 'commands you ran in a focused terminal' },
  { name: 'files', package: 'file-watcher', events: ['file:changed', 'file-watcher:capacity'], speech: 'event', does: 'which files changed under a watched root' },
  { name: 'symbols', package: 'symbol-edit', events: ['symbol:edited'], speech: 'event', does: 'which functions a change touched' },
  { name: 'pull requests', package: 'github-pr', events: ['git:pr-status'], speech: 'event', does: 'the state of a PR on a branch you are on' },
  { name: 'calendar', package: 'calendar', events: ['calendar:upcoming', 'calendar:active', 'calendar:context-event', 'reminders:snapshot'], speech: 'event', does: 'meetings, and your reminders (title, due, done), from EventKit' },
  { name: 'sleep and wake', package: 'sleep-wake', events: ['system:sleep-wake'], speech: 'event', does: 'when the machine slept and woke' },
  { name: 'presence', package: 'presence', events: ['presence:scan'], speech: 'event', does: 'other devices on a network you consented to', consent: true },
  { name: 'clipboard', package: 'clipboard-meta', events: ['clipboard:activity'], speech: 'event', does: 'that you copied something, and how big — never what', optIn: 'clipboardEnabled' },
  { name: 'screen text', package: 'screen-ocr', events: ['screen:ocr'], speech: 'state', does: 'text read off the screen', optIn: 'ocr' },
  { name: 'screen reading', package: 'screen-vision', events: ['screen:fact'], speech: 'state', does: 'what a local vision model makes of the screen, as a few short facts', optIn: 'vision' },
  { name: 'arc', package: 'arc', events: ['browser:arc-space'], speech: 'state', does: "the tabs of the Arc space you are in, origin and path only, so a return can offer them again" },
  { name: 'vault', package: 'vault', events: ['vault:changed'], speech: 'event', does: 'which notes you edited in the vault you named — paths only, never contents', optIn: 'vault' },
  // The one row on this card that most needs to exist. It reads subjects and
  // senders from Mail and Messages, behind Full Disk Access, and no body text
  // — which is exactly the claim a trust surface is for. It arrived in the
  // codebase on 2026-09-22 and `sensors.test.js` failed the same hour.
  { name: 'mail', package: 'mail', events: ['mail:received', 'mail:sent', 'mail:status'], speech: 'event', does: 'who wrote to you, who you wrote to, and the subject — never the body', optIn: 'mail' },
  { name: 'messages', package: 'mail', events: ['message:received'], speech: 'event', does: 'who wrote in Messages, and in which chat — never the text', optIn: 'messages' },
  { name: 'phone', package: null, events: ['phone:sleep', 'phone:place', 'phone:workout', 'phone:motion', 'phone:steps'], speech: 'event', does: 'sleep, places and workouts, pushed from your phone', pushed: true },
]

/**
 * The roster, joined to when each sensor's streams were last heard.
 *
 * `quietMin` is the FRESHEST of a sensor's streams: `git` has three and a
 * commit eight days ago says nothing about `git:status` polling a minute ago.
 * A sensor no stream has ever carried gets `null`, which the card draws as
 * "never" — different from quiet, and on the phone family the difference is
 * the whole story.
 */
export function sensorRoster(streams, config = {}) {
  const heard = new Map((streams ?? []).map((row) => [row.stream, row.quietMin]))
  return SENSORS.map((sensor) => {
    const seen = sensor.events.map((event) => heard.get(event)).filter((min) => typeof min === 'number')
    return {
      ...sensor,
      quietMin: seen.length ? Math.min(...seen) : null,
      // Which of its streams have never been heard at all. On `phone` that is
      // four of five, which is the card's own finding about the phone path.
      silentEvents: sensor.events.filter((event) => !heard.has(event)),
      on: sensor.optIn ? Boolean(config[sensor.optIn]) : true,
    }
  })
}

/** The opt-in sensors the owner has actually switched on. */
export const switchedOn = (roster) => roster.filter((sensor) => sensor.optIn && sensor.on)
