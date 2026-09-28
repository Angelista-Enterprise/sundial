import { existsSync, mkdirSync, readFileSync, rmSync, watch } from 'node:fs'

/**
 * Watch `~/.sundial/.daemon/test-notice.json` and replay its contents as a
 * `gnomon/notice` event, then delete it.
 *
 * This exists because the delivery path and the gate are separately
 * verifiable, and conflating them makes both harder to trust: provoking a REAL
 * notice means manufacturing days of telemetry until some rule emits a
 * candidate that survives habituation and the daily budget. This seam proves
 * the wire — gate verdict → companion turn — in one second, and proves nothing
 * about the gate, which has its own 26 tests and an offline measurement
 * harness.
 *
 * It is inert unless the file appears.
 */
export function watchTestNotice(home, emit) {
  const dir = `${home}/.daemon`
  const file = `${dir}/test-notice.json`
  mkdirSync(dir, { recursive: true })

  const consume = () => {
    if (!existsSync(file)) return
    let notice
    try {
      notice = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      console.warn(`[sundial-proactive] test-notice.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      rmSync(file, { force: true })
      return
    }
    // Delete BEFORE emitting: a delivery that throws must not leave the file
    // behind to be replayed on every subsequent watch event.
    rmSync(file, { force: true })
    console.log(`[sundial-proactive] test hook: replaying ${notice?.channel ?? '<no channel>'}`)
    emit(notice)
  }

  const watcher = watch(dir, (_event, filename) => {
    if (filename === 'test-notice.json') consume()
  })
  consume()

  return () => watcher.close()
}
