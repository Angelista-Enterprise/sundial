// The browser pane: a live view of a page and the owner's input to it (sundial-web-browser).
import { post } from './http.js'
import { inputPage, watchPage } from '../../sundial-web-browser/page-session.js'

export function mountWeb(ctx, shell) {
  const { api } = shell

  // A page in Gnomon's browser, live: every repaint as a frame on one stream,
  // for as long as its card is open. The card draws the newest frame; nothing
  // is stored.
  api('/gnomon/api/webview', async (req, res, url) => {
    const id = url.searchParams.get('page') ?? ''
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    const write = (frame) => {
      try {
        res.write(`data: ${JSON.stringify(frame)}\n\n`)
      } catch {
        // Gone mid-frame: the close handler stops the stream.
      }
    }
    let stop = null
    req.on('close', () => stop?.())
    try {
      stop = await watchPage(id, write)
      if (req.destroyed) stop()
    } catch (error) {
      write({ type: 'gone', reason: error instanceof Error ? error.message : String(error) })
      res.end()
    }
  })

  // The owner's own click, key or scroll on that page. Never logged: a
  // password typed into the card goes to the page and nowhere else.
  post(ctx, '/gnomon/api/webinput', { limit: 65_536, method: 'Input takes a POST.' }, (body) =>
    inputPage(String(body.page ?? ''), body).then(
      () => ({ ok: true }),
      (error) => [409, { unavailable: error instanceof Error ? error.message : String(error) }],
    ),
  )
}
