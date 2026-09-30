// @sundial/dsh-proactive — the delivery channel Gnomon never had.
//
// The notice gate (packages/rules/src/notice-gate.ts) has decided when Gnomon
// should speak for a long time; in the daemon its verdict reached a
// `console.log` and stopped. This plugin is the other end of that wire.
//
// What it does NOT do: decide. `decide()` stays a pure function inside the
// fold, with its habituation, its daily budget and its deferral ring. This
// plugin delivers what the gate admitted and carries the owner's verdict back.
// Any temptation to filter here — "not while the user is typing", "not twice in
// an hour" — belongs in the gate, where it is replayable and measurable.
//
// The two channels are deliberately different acts:
//   phasic → inject the notice, then followup() to open a turn. The assistant
//            speaks unprompted. This is an interruption and is priced as one.
//   tonic  → inject only. The observation is waiting in context the next time
//            the owner says anything; nobody is interrupted.
//
// SIGNALS ARE NOT SESSION LOGS, but the log learns what was said (W1). The
// crossings between the telemetry log and this conversation: every turn's
// brief (`gnomonKernel.brief`) is logged as `chat:shown`; the chat recorder
// (sundial-tools/route-log.js) logs the owner's words and Gnomon's reply as
// `chat:owner` / `chat:said`; this plugin injects admitted notices and logs
// `notice:delivered` / `notice:dropped`; verdicts and owner assertions re-enter
// through `appendSignal`. The companion never writes to the log directly.
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'
import { getSundialHome } from '@sundial/helpers/config.js'
import { getApiTokenPath } from '@sundial/helpers/sundial-paths.js'
import { verdictActions } from '@sundial/helpers/verdict-sign.js'
import { VERDICTS } from '@sundial/helpers/vocab.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync } from 'node:fs'
import { ensureCompanion } from './companion.js'
import { createDelivery } from './delivery.js'
import { createNativeNotifier, watchNoticeVerdicts } from './native-notify.js'
import { createPush, phoneVerdicts } from './push.js'
import { briefSubagent, installWorkLoop } from './work.js'
// lane E (#12)
import { installNightShift } from './night-shift.js'

export const name = 'sundial-proactive'
// `subagents` is deliberately NOT injected. Cordis reads an injected name as a
// service the plugin WAITS for, so listing it would stop this plugin loading at
// all on a profile without `@deepseek-ai/dsh-subagent`. The work loop reaches it
// with `ctx.get('subagents')` at call time instead — the same way dsh's own
// tool-subagent reaches its optional `jobs` service.
export const inject = ['agents', 'agentDefaultModel', 'tools', 'gnomonKernel']


export async function apply(ctx, config = {}) {
  const home = config.home ?? getSundialHome()
  const cwd = config.cwd ?? process.cwd()

  let companion = null
  let disposed = false

  // Owner opt-in, read once at load like every other config consumer here.
  // Off means the notifier is constructed anyway and no-ops — delivery should
  // not have to know whether banners exist.
  const notifications = { ...loadSundialConfig().notifications, ...(config.notifications ?? {}) }
  const notificationsEnabled = notifications.enabled
  const notifier = createNativeNotifier({ home, enabled: notificationsEnabled })
  // The phone. Same seam as the banner: a second channel, never a second decision.
  const push = createPush({ url: notifications.ntfy })
  // The way back from the phone (J0.8): three ntfy actions posting a signed
  // verdict to the :8767 listener. Signed with the ingest token the listener
  // already holds, so the token itself never rides the public topic. Read
  // lazily — the sensors plugin writes the file on its first boot.
  const taps = (artifactKind, artifactId, verdicts) => {
    if (notifications.verdictUrl === '') return []
    try {
      return verdictActions(notifications.verdictUrl, readFileSync(getApiTokenPath(), 'utf-8').trim(), artifactKind, artifactId, verdicts)
    } catch {
      return []
    }
  }

  ctx.effect(() => () => {
    disposed = true
  }, 'sundial-proactive shutdown')

  // lane H (H4): what became of a push. Recorded either way (Settings shows
  // the last one that reached the phone); a failed one falls back to the
  // banner when the route had skipped it, so the notice is not lost.
  const pushed = (sending, payload = null) =>
    sending.then((outcome) => {
      if (outcome.reason === 'disabled' || outcome.reason === 'empty') return
      ctx.gnomonKernel.appendSignal(outcome.pushed ? 'push:sent' : 'push:failed', outcome.pushed ? {} : { reason: outcome.reason }).catch(() => {})
      if (!outcome.pushed && payload?.route === 'phone') notifier.post(payload)
    })

  // The companion is built on the FIRST notice, not at boot. Creating an agent
  // eagerly would put an empty session in the owner's sidebar on every start,
  // including the many days the gate rightly says nothing at all.
  const delivery = createDelivery({
    isDisposed: () => disposed,
    getCompanion: async () => {
      if (companion === null) {
        const { agent, resumed } = await ensureCompanion(ctx, { home, cwd })
        companion = agent
        console.log(`[sundial-proactive] companion session ${agent.id} (${resumed ? 'resumed' : 'created'})`)
      }
      return companion
    },
    onDropCompanion: () => {
      companion = null
    },
    // W2: another chat's agent, from the theme (resolved at call time: no load-order dependency on it).
    getThread: (sessionId) => ctx.get?.('gnomonThreads')?.agentFor?.(sessionId) ?? null,
    record: (type, payload) => void ctx.gnomonKernel.appendSignal(type, payload).catch(() => {}),
    // W1: a notice that wakes a turn is briefed, the notice as its cause.
    brief: (input) => ctx.gnomonKernel.brief(input),
    announce: (notice) => ctx.emit('gnomon/noticed', notice),
    notifyNative: (payload) => notifier.post(payload),
    // lane D — #6: ntfy on every route; the route only drops the banner when away.
    // lane H (H4): titled by the notice's group; an agent wait offers only "Not now".
    notifyPhone: (payload) =>
      void pushed(push.post({ title: payload?.title ?? 'Gnomon', body: payload?.observation ?? '', actions: taps('notice', payload?.noticeKey ?? '', phoneVerdicts(payload?.kind)) }), payload),
    pushAtMac: notifications.pushAtMac !== false,
  })

  ctx.on('gnomon/notice', (notice) => delivery.enqueue(notice))
  // W5 (Phase 2B's risk): a helper the model starts is briefed once, as it starts.
  ctx.on('subagent/start', (info) => briefSubagent(ctx, info))

  // The work loop's hands (see work.js): jobs the `workbench` rule opens ride
  // the same `gnomon/notice` event on their own channel and wake a separate
  // worker session, so a job never lands in the companion's conversation.
  ctx.effect(
    () => installWorkLoop(ctx, { home, cwd, hands: loadSundialConfig().hands, isDisposed: () => disposed, onShelved: (title) => void pushed(push.post({ title: 'Left for you', body: title })) }),
    'sundial-proactive work loop',
  )
  // lane E (#12): the night shift. Off unless `jobs.enabled`; off, it registers and hears nothing.
  ctx.effect(() => installNightShift(ctx, { home, jobs: loadSundialConfig().jobs }), 'sundial-proactive night shift')

  // The banner's return path. A button press is the same fact as the owner
  // saying "not now" in chat, so it enters through the same signal the
  // `gnomon_notice_feedback` tool below appends — one habituation path, not two.
  if (notificationsEnabled) {
    ctx.effect(
      () =>
        watchNoticeVerdicts(home, ({ noticeKey, verdict }) => {
          ctx.gnomonKernel
            .appendSignal('feedback:verdict', { artifactKind: 'notice', artifactId: noticeKey, verdict, via: 'banner' })
            .then(() => console.log(`[sundial-proactive] banner verdict "${verdict}" on ${noticeKey}`))
            .catch((error) =>
              console.warn(`[sundial-proactive] could not record a banner verdict: ${error instanceof Error ? error.message : String(error)}`),
            )
        }),
      'sundial-proactive notice verdicts',
    )
  }

  // The return path. `feedback:verdict` is an ordinary signal that the
  // `feedbackTrack` rule folds — `not-now` on a `notice` bumps that key's
  // habituation, which is what makes the gate quieter about a badly-timed
  // observation next time.
  ctx.tools.register(
    defineTool({
      name: 'gnomon_notice_feedback',
      description: [
        "Record the owner's verdict on a notice Gnomon delivered. Call this when the owner reacts to a notice —",
        '"not now" / "bad timing" → not-now (quiets this notice key without disputing it),',
        '"that\'s wrong" / "not true" → wrong (lowers belief),',
        '"useful" / "good catch" → useful (records confirmation, changes nothing else).',
        'Use the notice key from the notice you delivered. Do not guess a key.',
      ].join(' '),
      parameters: {
        verdict: { type: 'string', required: true, description: 'One of: useful, wrong, not-now.' },
        noticeKey: { type: 'string', required: true, description: 'The key of the notice being rated, exactly as delivered.' },
        note: { type: 'string', description: "Optional: the owner's own words, if they said why." },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            recorded: { type: 'boolean' },
            verdict: { type: 'string' },
            noticeKey: { type: 'string' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: value.recorded ? `Recorded "${value.verdict}" on ${value.noticeKey}.` : 'Not recorded.' },
        ],
      },
      async execute(args) {
        const verdict = String(args.verdict).trim()
        if (!VERDICTS.includes(verdict)) {
          throw new Error(`verdict must be one of ${VERDICTS.join(', ')} — got "${verdict}"`)
        }
        const noticeKey = String(args.noticeKey).trim()
        if (noticeKey === '') throw new Error('noticeKey is required')

        await ctx.gnomonKernel.appendSignal('feedback:verdict', {
          artifactKind: 'notice',
          artifactId: noticeKey,
          verdict,
          ...(typeof args.note === 'string' && args.note.trim() !== '' ? { note: args.note.trim() } : {}),
        })

        return { recorded: true, verdict, noticeKey }
      },
    }),
  )

  // Dev seam. Simulates DELIVERY only — it does not run the gate, spend its
  // budget or habituate anything, so it proves the wire from `gnomon/notice`
  // to a visible turn and nothing more. Real notices arrive through the fold.
  if (config.testHook !== false) {
    const { watchTestNotice } = await import('./test-hook.js')
    ctx.effect(() => watchTestNotice(home, (notice) => ctx.emit('gnomon/notice', notice)), 'sundial-proactive test hook')
  }
}
