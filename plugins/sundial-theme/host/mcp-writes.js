// The MCP server's writes, applied here: that server is a separate process and the log has one
// writer, so each of its write tools drops one request file into `$SUNDIAL_HOME/.daemon/mcp-writes/`
// and this hands the body to the same handler the web route uses. A file left by a call made
// while Sundial was down is applied at the next boot. Each file is deleted before it is applied,
// so a handler that throws never replays it.
import { mkdirSync, readFileSync, readdirSync, rmSync, watch } from 'node:fs'
import { join } from 'node:path'

/** @param {Record<string, (body: Record<string, unknown>) => Promise<unknown>>} handlers by write name */
export function consumeMcpWrites(dir, handlers, warn = console.warn) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const queue = { tail: Promise.resolve() } // one write at a time, in file order

  const consume = () => {
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort()) {
      const file = join(dir, name)
      let request
      try {
        request = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        request = null
      }
      rmSync(file, { force: true })
      const handler = handlers[request?.write]
      if (typeof handler !== 'function' || request.body === null || typeof request.body !== 'object') {
        warn(`[sundial-shell] mcp write ${name} ignored: not a known write`)
        continue
      }
      queue.tail = queue.tail
        .then(() => handler(request.body))
        .then((out) => typeof out === 'string' && warn(`[sundial-shell] mcp ${request.write} refused: ${out}`))
        .catch((error) => warn(`[sundial-shell] mcp ${request.write} failed: ${error instanceof Error ? error.message : String(error)}`))
    }
  }

  // A request is written to a dot-file and renamed, so only whole files ever end in `.json`.
  const watcher = watch(dir, (_event, filename) => typeof filename === 'string' && filename.endsWith('.json') && !filename.startsWith('.') && consume())
  consume()
  return () => watcher.close()
}
