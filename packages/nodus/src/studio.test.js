// @vitest-environment jsdom
// Studio: the prompt, the reply read, the repair rounds, the critic, the
// message protocol against a stub frame, and (NODUS_BROWSER=1) the runtime
// page itself in Chromium with the rainbow: draws, labels, a door, a
// snapshot, and a runaway program cut off and the frame booted fresh.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { build, MAX_CODE, openRuntime, parseProgram, repairNote, studioMessages, SYSTEM, trialIn } from './modes/studio.js'
import { FRAME_ASSET, FRAME_SET } from './storyboard.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The lab's rainbow, as a model would send it. */
const RAINBOW = "TITLE: How a rainbow forms\nSTEP [sun, light]: Sunlight leaves the sun as white light, every colour travelling together.\nSTEP [drop]: Inside each droplet the light bends, reflects off the back, and bends again on the way out.\nSTEP [rain]: Millions of droplets in the rain shower each send one colour toward you.\nSTEP [bow, you]: You see the rainbow with the sun at your back, red on the outside and violet within.\n```js\nfunction scene(api) {\n  const { THREE, V, ink } = api\n  api.add('sun', api.part('sun', { at: [-5, 3.4, 0], r: 0.7 }), { label: 'Sun' })\n  api.add('rain', api.part('rain', { at: [2.6, 1.2, 0], r: 2.2 }), { label: 'Rain shower' })\n  api.add('drop', api.part('droplet', { at: [1.2, 2.4, 0.4], r: 0.55 }), { label: 'Droplet' })\n  api.add('bow', api.part('rainbow', { at: [2.6, -1.2, -2], r: 3.4 }), { label: 'Rainbow' })\n  api.add('you', api.part('observer', { at: [-2.6, -1.6, 1.2], r: 1.3 }), { label: 'Observer' })\n  api.add('light', ink.arrow([-4.2, 3.1, 0.1], [0.7, 2.45, 0.4], api.colors.ochre), { label: 'Sunlight' })\n  const back = new THREE.Group()\n  back.add(ink.hidden([[1.2, 2.4, 0.4], [-2.5, -0.4, 1.2]], api.colors.ochre))\n  back.add(ink.hatch([[-6, -2.4], [6, -2.4], [6, -2.6], [-6, -2.6]], api.colors.muted, 0.4))\n  api.add('ground', back)\n  api.door('drop', 'search:rainbow')\n  api.onFrame((t) => { api.THREE && t })\n}\n```\n"
const BROKEN = RAINBOW.replace('api.add(\'sun\'', 'api.add(\'sun\',,')

describe('the prompt', () => {
  it('is under 120 lines, names the kit, the ink helpers and only the palette tokens', () => {
    expect(SYSTEM.split('\n').length).toBeLessThan(120)
    for (const word of ['function scene(api)', 'api.part', 'gear', 'tank', 'api.ink.hidden', 'api.ink.hatch', 'hatch(', 'hidden(', 'api.door', 'search:', 'ochre', 'navy', 'TITLE:', 'STEP [']) expect(SYSTEM).toContain(word)
    expect(SYSTEM).toMatch(/close to the real thing/)
    expect(SYSTEM).not.toMatch(/[\u2013\u2014]/)
    expect(SYSTEM).not.toMatch(/#[0-9a-f]{6}/i)
  })
  it('carries the ask, the screen line and walks of like asks', () => {
    const m = studioMessages('How does a heat pump work', { screen: 'On screen as they asked: app Terminal', like: [{ ask: 'how does a fridge work', steps: [{ say: 'The compressor squeezes the gas.' }] }] })
    expect(m.map((x) => x.role)).toEqual(['system', 'user'])
    expect(m[1].content).toMatch(/Ask: How does a heat pump work/)
    expect(m[1].content).toMatch(/app Terminal/)
    expect(m[1].content).toMatch(/compressor squeezes/)
  })
})

describe('reading a reply', () => {
  it('reads the title, the walk and the program, and runs nothing', () => {
    const p = parseProgram(RAINBOW)
    expect(p.problems).toEqual([])
    expect(p.title).toBe('How a rainbow forms')
    expect(p.steps.map((s) => s.focus)).toEqual([['sun', 'light'], ['drop'], ['rain'], ['bow', 'you']])
    expect(p.code).toMatch(/^function scene\(api\)/)
  })
  it('names what keeps a reply from being drawn', () => {
    expect(parseProgram('TITLE: x').problems).toContain('there is no function scene(api)')
    expect(parseProgram(BROKEN).problems.join()).toMatch(/syntax error/)
    expect(parseProgram(RAINBOW.replace("api.onFrame((t) => { api.THREE && t })", "fetch('/gnomon/api/board')")).problems.join()).toMatch(/uses fetch/)
    expect(parseProgram(RAINBOW.replace('function scene(api) {', `function scene(api) {\n${'// pad\n'.repeat(MAX_CODE / 6)}`)).problems.join()).toMatch(/characters/)
    expect(parseProgram(RAINBOW.replace(/^STEP.*\n/gm, '')).problems).toContain('fewer than two STEP lines')
  })
  it('drops a focus the program never adds and an em dash from a sentence', () => {
    const p = parseProgram(RAINBOW.replace('STEP [drop]: Inside', 'STEP [drop, ghost]: Inside \u2014 so'))
    expect(p.steps[1].focus).toEqual(['drop'])
    expect(p.steps[1].say).not.toMatch(/\u2014/)
  })
})

describe('the repair rounds', () => {
  it('a syntax error goes back once with its words, and the fixed program stands', async () => {
    const complete = vi.fn().mockResolvedValueOnce(BROKEN).mockResolvedValueOnce(RAINBOW)
    const out = await build('How does a rainbow form', { complete })
    expect(complete).toHaveBeenCalledTimes(2)
    const [messages, opts] = complete.mock.calls[1]
    expect(opts).toEqual({ maxTokens: 2200, temperature: 0.4 })
    expect(messages.at(-2)).toEqual({ role: 'assistant', content: BROKEN })
    expect(messages.at(-1).content).toMatch(/syntax error/)
    expect(out).toMatchObject({ kind: 'program', title: 'How a rainbow forms', by: { repairs: 1 } })
    expect(out.steps).toHaveLength(4)
  })
  it('a runtime error goes back with the runtime\'s words; a second failure draws nothing', async () => {
    const complete = vi.fn().mockResolvedValue(RAINBOW)
    const trial = vi.fn().mockResolvedValueOnce({ error: 'unknown part nope' }).mockResolvedValueOnce({ jpeg: 'x'.repeat(300), labels: ['Sun'] })
    const out = await build('rainbow', { complete, trial })
    expect(complete.mock.calls[1][0].at(-1).content).toMatch(/failed in the runtime: unknown part nope/)
    expect(out.by.repairs).toBe(1)
    const never = await build('rainbow', { complete, trial: vi.fn().mockResolvedValue({ error: 'boom' }) })
    expect(never).toBeNull()
  })
  it('the frame critic sees the JPEG as an asset, and a frame that does not read gets one repair', async () => {
    const complete = vi.fn().mockResolvedValue(RAINBOW)
    const trial = vi.fn().mockResolvedValue({ jpeg: `data:image/jpeg;base64,${'A'.repeat(400)}`, labels: ['Sun', 'Droplet'] })
    const verdicts = [{ shows_intent: { score: 0.6 }, legible: { noul: 0.3 } }, { shows_intent: { score: 2.4 }, legible: { noul: 0.9 } }]
    const judge = vi.fn(async ({ questions }) => (questions.shows_intent ? verdicts.shift() : { fits: { score: 2.5 }, s0: { noul: 0.9 }, s1: { noul: 0.1 }, s2: { noul: 0.8 }, s3: { noul: 0.9 } }))
    const out = await build('How does a rainbow form', { complete, judge, trial })
    const [framed] = judge.mock.calls.find(([a]) => a.questions.shows_intent)
    expect(framed.set).toBe(FRAME_SET)
    expect(framed.state).toMatchObject({ frame: FRAME_ASSET, ask: 'How does a rainbow form', parts: ['Sun', 'Droplet'] })
    expect(framed.assets[FRAME_ASSET]).toMatchObject({ type: 'image', format: 'jpeg' })
    expect(framed.assets[FRAME_ASSET].data_base64).not.toMatch(/^data:/)
    expect(complete.mock.calls[1][0].at(-1).content).toMatch(/labels do not read/)
    expect(complete.mock.calls[1][0].at(-1).content).toMatch(/does not show what was asked/)
    expect(out.by.critic.frame).toMatchObject({ shows_intent: 2.4, legible: 0.9, before: { shows_intent: 0.6 } })
    // Tailored with Jev, as a sketch is: the step it let through no further is gone.
    expect(out.steps).toHaveLength(3)
    expect(out.by.critic.fits).toBe(2.5)
  })
  it('a repair the critic likes less is not kept', async () => {
    const complete = vi.fn().mockResolvedValue(RAINBOW)
    const trial = vi.fn().mockResolvedValue({ jpeg: 'A'.repeat(400), labels: [] })
    const verdicts = [{ shows_intent: { score: 0.8 }, legible: { noul: 0.9 } }, { shows_intent: { score: 0.4 }, legible: { noul: 0.9 } }]
    const out = await build('rainbow', { complete, trial, judge: async ({ questions }) => (questions.shows_intent ? verdicts.shift() : null) })
    expect(out.by.critic.frame).toMatchObject({ shows_intent: 0.8 })
    expect(out.by.repairs).toBe(1)
  })
  it('without a model there is no program', async () => {
    expect(await build('x', {})).toBeNull()
  })
  it('repairNote says what the critic saw', () => {
    expect(repairNote({ verdict: { shows_intent: 2, legible: 0.2 } })).toMatch(/legible 0.2 of 1.*labels do not read/s)
  })
})

describe('the message protocol, against a stub frame', () => {
  /** A frame whose window answers as the runtime does; `hang` makes it never answer a run. */
  function stub({ hang = false } = {}) {
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const seen = []
    const win = {
      postMessage(m) {
        seen.push(m)
        const answer = (data) => setTimeout(() => dispatchEvent(new MessageEvent('message', { data: { nodus: 'studio', ...data }, source: win })))
        if (m.type === 'init') answer({ type: 'ready' })
        else if (m.type === 'run' && !hang) answer(/throw/.test(m.code) ? { type: 'error', id: m.id, message: 'scene() added no parts' } : { type: 'ran', id: m.id, parts: ['sun'], labels: ['Sun'], steps: 2 })
        else if (m.type === 'snapshot') answer({ type: 'snapshot', id: m.id, data: 'data:image/jpeg;base64,AAAA' })
      },
    }
    Object.defineProperty(frame, 'contentWindow', { get: () => win })
    // The frame boots when its src is set: it says boot.
    Object.defineProperty(frame, 'src', { set: () => setTimeout(() => dispatchEvent(new MessageEvent('message', { data: { nodus: 'studio', type: 'boot' }, source: win }))), get: () => '' })
    return { frame, seen }
  }
  const load = async () => ({ three: 'three', kit: 'kit', labels: 'labels', camera: 'camera', font: null })

  it('boot answers init with the sources and the palette; run, step and snapshot go by id', async () => {
    const { frame, seen } = stub()
    const rt = openRuntime(frame, { load, palette: { ink: '#000000' } })
    const ran = await rt.run({ code: 'function scene(api) {}', steps: [] })
    expect(seen[0]).toMatchObject({ nodus: 'studio', type: 'init', three: 'three', kit: 'kit', labels: 'labels', camera: 'camera', palette: { ink: '#000000' } })
    expect(ran).toMatchObject({ type: 'ran', parts: ['sun'], labels: ['Sun'] })
    rt.step(1, ['sun'], 'The sun.')
    expect(seen.at(-1)).toMatchObject({ type: 'step', index: 1, ids: ['sun'], sentence: 'The sun.' })
    expect(await rt.snapshot()).toBe('data:image/jpeg;base64,AAAA')
    await expect(rt.run({ code: 'throw', steps: [] })).rejects.toThrow('scene() added no parts')
    expect(await trialIn(rt)({ code: 'function scene(api) {}', steps: [] })).toEqual({ jpeg: 'data:image/jpeg;base64,AAAA', labels: ['Sun'] })
    rt.dispose()
  })
  it('a message from another window is not heard', async () => {
    const { frame } = stub()
    const rt = openRuntime(frame, { load })
    const door = vi.fn()
    rt.onDoor = door
    dispatchEvent(new MessageEvent('message', { data: { nodus: 'studio', type: 'door', ref: 'search:x' }, source: window }))
    expect(door).not.toHaveBeenCalled()
    rt.dispose()
  })
  it('a run that does not answer throws the frame away, element and all, with words a repair can use', async () => {
    const { frame } = stub({ hang: true })
    const rt = openRuntime(frame, { load, timeoutMs: 50 })
    await expect(rt.run({ code: 'function scene(api) { for (;;) {} }', steps: [] })).rejects.toThrow(/did not finish in 0.05 s: an endless loop/)
    expect(frame.isConnected).toBe(false)
    expect(rt.frame).not.toBe(frame)
    expect(rt.frame.isConnected).toBe(true)
    expect(rt.frame.getAttribute('src')).toBeNull()
    rt.dispose()
  })
})

// The runtime page in Chromium (Playwright from uv), the rainbow drawn for real. Slow (about 45 s): NODUS_BROWSER=1 runs it.
const PYTHON = join(homedir(), '.local/share/uv/tools/playwright/bin/python')
const BROWSER = String.raw`import http.server, json, os, pathlib, socketserver, sys, tempfile, threading, time
from playwright.sync_api import sync_playwright

SRC = pathlib.Path(sys.argv[1])
OUT = pathlib.Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)
FIXTURE = json.loads(sys.argv[3])
root = pathlib.Path(tempfile.mkdtemp())
nodus = root / 'gnomon/app/nodus'; nodus.mkdir(parents=True)
for f in SRC.iterdir(): (nodus / f.name).symlink_to(f)
(nodus / 'vendor').symlink_to(SRC.parent / 'vendor')
(root / 'index.html').write_text('''<!doctype html><meta charset=utf-8><style>:root{--page:#f0e9e3;--ink:#000;--ink-muted:#4a4743;--ink-faint:#635f5b;--ochre:#d98a2b;--ochre-text:#86551b;--navy:#002643;--green:#056423}
body{margin:0;background:var(--page)} #host{width:960px;height:540px} .nd-stage{position:relative;width:100%;aspect-ratio:16/9}</style><div id=host></div>
<script>window.doors=[];document.addEventListener('click',(e)=>{const d=e.target.closest&&e.target.closest('[data-explore]');if(d)window.doors.push(d.dataset.explore)},true)</script>''')
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(s, *a, **k): super().__init__(*a, directory=str(root), **k)
    def log_message(s, *a): pass
    def guess_type(s, p): return 'text/javascript' if str(p).endswith('.js') else super().guess_type(p)
srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), H); srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f'http://localhost:{srv.server_address[1]}/'
results = {}
def check(name, ok, detail=''):
    results[name] = bool(ok)
    print(('ok   ' if ok else 'FAIL ') + name + (f': {detail}' if detail else ''), flush=True)

with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--site-per-process'])
    page = b.new_page(viewport={'width': 1000, 'height': 600})
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(base)
    t0 = time.time()
    page.evaluate('''async (item) => {
      const m = await import('/gnomon/app/nodus/modes/studio.js'); window.M = m
      window.settled = []
      window.d = m.draw(document.getElementById('host'), item, { onSettled: (e) => window.settled.push(e.error ?? 'settled') })
      await window.d.ready
    }''', FIXTURE)
    page.wait_for_function('window.settled.length > 0', timeout=20000)
    check('the program runs and the frame settles', page.evaluate('window.settled[0]') == 'settled', f'{time.time() - t0:.1f} s, {page.evaluate("window.settled")}')
    frame = next(f for f in page.frames if f.url.endswith('studio-runtime.html'))
    check('the runtime frame is sandboxed to an opaque origin', frame.evaluate('origin') == 'null', frame.evaluate('origin'))
    check('the page cannot reach into the frame', page.evaluate('(() => { try { return !document.querySelector("iframe").contentDocument } catch { return true } })()'))
    jpeg = page.evaluate('d.snapshot()')
    ink = page.evaluate('''async (src) => { const i = new Image(); i.src = src; await i.decode(); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let k = 0; k < d.length; k += 4) if (Math.abs(d[k] - 240) + Math.abs(d[k + 1] - 233) + Math.abs(d[k + 2] - 227) > 60) n++; return { w: c.width, h: c.height, share: n / (d.length / 4) } }''', jpeg)
    check('it draws: ink on the snapshot', ink['share'] > 0.01, f"{ink['w']}x{ink['h']}, {ink['share'] * 100:.1f}% ink")
    import base64
    (OUT / 'studio-runtime-snapshot.jpg').write_bytes(base64.b64decode(jpeg.split(',')[1]))
    labels = frame.eval_on_selector_all('.nd-label3d', 'els => els.map((e) => { const r = e.getBoundingClientRect(); return { t: e.textContent, x: r.x, y: r.y, w: r.width, h: r.height, o: getComputedStyle(e).opacity, door: e.dataset.explore ?? null } })')
    check('every named part has a label', sorted(l['t'] for l in labels) == sorted(FIXTURE['labels']), [l['t'] for l in labels])
    over = [(a['t'], c['t']) for i, a in enumerate(labels) for c in labels[i + 1:] if a['x'] < c['x'] + c['w'] and c['x'] < a['x'] + a['w'] and a['y'] < c['y'] + c['h'] and c['y'] < a['y'] + a['h']]
    check('labels do not overlap', not over, over)
    check('labels are shown', all(float(l['o']) > 0.3 for l in labels), [l['o'] for l in labels])
    leaders = frame.eval_on_selector_all('.nd-leader', 'els => els.map((e) => e.getAttribute("d"))')
    check('each label has a leader', len(leaders) == len(labels) and all(leaders), len(leaders))
    page.evaluate("d.focus(['drop'], 'The droplet bends the light.')")
    page.wait_for_timeout(1200)
    hot = frame.eval_on_selector_all('.nd-label3d.nd-hot', 'els => els.map((e) => e.textContent)')
    check('a step lights its part', hot == ['Droplet'], hot)
    page.screenshot(path=str(OUT / 'studio-runtime.png'), clip={'x': 0, 'y': 0, 'width': 960, 'height': 540})
    door = next(l for l in labels if l['door'])
    frame.click(f'.nd-label3d[data-explore="{door["door"]}"]')
    page.wait_for_timeout(300)
    check('a door label opens through the page\'s door listener', page.evaluate('window.doors') == [door['door']], page.evaluate('window.doors'))
    # A runaway program: the frame is thrown away after the timeout, the page stays responsive, and the next run draws.
    t1 = time.time()
    page.evaluate('''() => { window.ticks = 0; window.tick = setInterval(() => window.ticks++, 100); window.t0 = performance.now(); window.d.update({ ...window.d_item, code: 'function scene(api) { for (;;) {} }', steps: [] }); window.d_err = null }''')
    page.wait_for_function('window.settled.some((s) => /did not finish/.test(s))', timeout=40000)
    took = time.time() - t1
    ticks = page.evaluate('(clearInterval(window.tick), window.ticks)')
    check('a runaway program is cut off at 15 s with an error the repair can read', 14 < took < 25, f'{took:.1f} s, {[s for s in page.evaluate("window.settled") if s != "settled"]}')
    check('the page kept running while the frame looped', ticks > 100, f'{ticks} ticks of 100 ms')
    page.evaluate('window.settled = []')
    page.evaluate('(item) => window.d.update(item)', FIXTURE)
    page.wait_for_function('window.settled.length > 0', timeout=25000)
    check('a fresh frame draws again after the reload', page.evaluate('window.settled[0]') == 'settled', page.evaluate('window.settled'))
    # A program that throws: the error comes back with its message.
    page.evaluate('window.settled = []')
    page.evaluate('(item) => window.d.update({ ...item, code: "function scene(api) { api.add(\\"x\\", api.part(\\"nope\\")) }" })', FIXTURE)
    page.wait_for_function('window.settled.length > 0', timeout=10000)
    check('a throwing program reports its error', 'unknown part nope' in page.evaluate('window.settled[0]'), page.evaluate('window.settled[0]')[:80])
    # The trial build uses: a frame and an error-free settle hands back a JPEG.
    tr = page.evaluate('''async (item) => { const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.style.cssText = 'width:960px;height:540px;position:absolute;left:-2000px'; document.body.append(f); const rt = M.openRuntime(f); const r = await M.trialIn(rt)(item); rt.dispose(); return { jpeg: (r.jpeg ?? '').length, labels: r.labels, error: r.error ?? null } }''', FIXTURE)
    check('trialIn hands back a frame and the labels', tr['jpeg'] > 5000 and len(tr['labels']) == len(FIXTURE['labels']), tr)
    check('no page errors', not errs, errs)
    b.close()
print(json.dumps({'passed': sum(results.values()), 'failed': [k for k, v in results.items() if not v]}))
sys.exit(0 if all(results.values()) else 1)
`

describe('the runtime page in a browser', () => {
  it.skipIf(!process.env.NODUS_BROWSER || !existsSync(PYTHON))('draws the rainbow, labels it, opens a door, snapshots, and survives a runaway program', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-browser-'))
    writeFileSync(join(dir, 'browser.py'), BROWSER)
    const p = parseProgram(RAINBOW)
    const fixture = { kind: 'program', title: p.title, code: p.code, steps: p.steps, labels: ['Sun', 'Rain shower', 'Droplet', 'Rainbow', 'Observer', 'Sunlight'] }
    const run = spawnSync(PYTHON, [join(dir, 'browser.py'), HERE, process.env.NODUS_SHOTS ?? dir, JSON.stringify(fixture)], { encoding: 'utf8', timeout: 170_000 })
    console.log(run.stdout, run.stderr.slice(-2000))
    expect(run.status).toBe(0)
  }, 180_000)
})
