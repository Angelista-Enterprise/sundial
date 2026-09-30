// The banner. Phasic notices only, and only when the owner has turned them on.
//
// This is the one file-drop in Gnomon that flows node → Swift. Every sidecar
// goes the other way (helper writes JSON, node reads it), and the reason this
// one inverts is that macOS will not let a node process post a notification at
// all: UNUserNotificationCenter authorizes against a bundle identity, and node
// has none. So the launcher — which owns `dev.sundial.daemon` — posts on our
// behalf, and we hand it a request the same way every other sidecar hands us a
// reading.
//
// The verdict comes back through `notice-verdict-<uuid>.json` and enters the
// kernel through EXACTLY the same signal `gnomon_notice_feedback` appends. A
// button on a banner and the owner saying "not now" in chat are the same fact
// arriving by different roads; making them two facts would mean two habituation
// paths that could disagree.
import { VERDICTS as VERDICT_LIST } from '@sundial/helpers/vocab.js'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs'

const RUNTIME_DIR = (home) => `${home}/.daemon`
const REQUEST_FILE = 'notice-request.json'
const VERDICT_PREFIX = 'notice-verdict-'
const VERDICTS = new Set(VERDICT_LIST)

/**
 * Writes the request the launcher polls for.
 *
 * @param enabled - `config.notifications.enabled`. When false this is a no-op
 *   that still returns a result, so the caller never branches on config.
 */
export function createNativeNotifier({ home, enabled = false, log = console.log, warn = console.warn } = {}) {
  const dir = RUNTIME_DIR(home)
  const file = `${dir}/${REQUEST_FILE}`

  return {
    post(payload) {
      if (!enabled) return { posted: false, reason: 'disabled' }
      if (payload === null || typeof payload !== 'object' || typeof payload.noticeKey !== 'string' || payload.noticeKey === '') {
        return { posted: false, reason: 'no-notice-key' }
      }

      try {
        mkdirSync(dir, { recursive: true })
        // Atomic replace. The launcher polls this path once a second and a
        // half-written JSON would be parsed as corrupt and deleted, losing the
        // notice — the same tmp+rename the Swift writers use, in reverse.
        const tmp = `${file}.tmp`
        writeFileSync(
          tmp,
          JSON.stringify({
            noticeKey: payload.noticeKey,
            kind: typeof payload.kind === 'string' ? payload.kind : 'notice',
            observation: typeof payload.observation === 'string' ? payload.observation : '',
            at: new Date().toISOString(),
          }),
          'utf8',
        )
        renameSync(tmp, file)
        log(`[sundial-proactive] requested a banner for ${payload.noticeKey}`)
        return { posted: true }
      } catch (error) {
        // A banner that cannot be written is a lost banner, not a broken fold.
        // The chat turn already happened; this was the second channel.
        warn(`[sundial-proactive] could not request a banner: ${error instanceof Error ? error.message : String(error)}`)
        return { posted: false, reason: 'error' }
      }
    },
  }
}

/**
 * Watch for verdict drops from the notification's action buttons.
 *
 * Same delete-before-emit ordering as `test-hook.js`: a handler that throws
 * must not leave the file behind to be replayed on every subsequent watch
 * event. `fs.watch` on a directory can miss or coalesce events, so an
 * unconditional sweep runs at startup too — a verdict pressed while the plugin
 * was reloading is still the owner's verdict.
 */
export function watchNoticeVerdicts(home, onVerdict, { warn = console.warn } = {}) {
  const dir = RUNTIME_DIR(home)
  mkdirSync(dir, { recursive: true })

  const consumeOne = (filename) => {
    const file = `${dir}/${filename}`
    if (!existsSync(file)) return
    let verdict
    try {
      verdict = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      warn(`[sundial-proactive] ${filename} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      rmSync(file, { force: true })
      return
    }
    rmSync(file, { force: true })

    const noticeKey = typeof verdict?.noticeKey === 'string' ? verdict.noticeKey.trim() : ''
    const value = typeof verdict?.verdict === 'string' ? verdict.verdict.trim() : ''
    if (noticeKey === '' || !VERDICTS.has(value)) {
      warn(`[sundial-proactive] ignoring a malformed verdict drop: ${JSON.stringify(verdict)}`)
      return
    }
    // Contained deliberately: this runs inside an `fs.watch` callback, where a
    // throw has no caller to catch it and takes the harness process down. The
    // drop is already deleted, so a failed fold loses one verdict rather than
    // replaying it on every subsequent directory event.
    try {
      onVerdict({ noticeKey, verdict: value })
    } catch (error) {
      warn(`[sundial-proactive] could not fold a banner verdict: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const sweep = () => {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.startsWith(VERDICT_PREFIX) && entry.endsWith('.json')) consumeOne(entry)
    }
  }

  const watcher = watch(dir, (_event, filename) => {
    if (typeof filename === 'string' && filename.startsWith(VERDICT_PREFIX) && filename.endsWith('.json')) consumeOne(filename)
  })
  sweep()

  return () => watcher.close()
}
