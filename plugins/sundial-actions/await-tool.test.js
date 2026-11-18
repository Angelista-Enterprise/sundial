import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { appIn, awaitTool, cameToFront, shellOf, waitFor, wakes } from './await-tool.js'
import { runShellTool } from './run-shell.js'
import { shellJobs } from '../../packages/rules/src/shell-jobs.ts'
import { createInitialState } from '../../packages/kernel/src/initial-state.ts'

const state = (over = {}) => ({ jobs: {}, window: { active: { processName: 'Notes', windowTitle: 'Lunch - Notes' } }, ...over })

describe('gnomon_await (runs 13 and 14: half the clock went on sleeping)', () => {
  it('names what to wait for, and refuses a wait with no subject', () => {
    expect(waitFor({ job: 'job-1' }).what).toMatch(/job-1 to finish/)
    expect(waitFor({ app: 'Notes' }).what).toMatch(/Notes to be the app in front/)
    expect(waitFor({ window: 'Lunch' }).what).toMatch(/title holds "Lunch"/)
    expect(waitFor({ app: 'Notes', window: 'Lunch' }).what).toMatch(/window of Notes/)
    // Nothing named: wait for the app in front to become a different one (run 15).
    expect(waitFor({}, { app: 'Finder', title: '' }).what).toMatch(/stop being Finder/)
  })

  it('comes back the moment the job is in the fold, and says plainly when the job failed', async () => {
    const good = awaitTool(() => state({ jobs: { 'job-1': { exitCode: 0, lastLine: 'line 6', ms: 24_000 } } }))
    const out = await good.execute({ job: 'job-1', seconds: 2 })
    expect(out).toMatchObject({ happened: true })
    expect(out.text).toMatch(/finished after 24s with exit code 0.*"line 6"/)
    const bad = awaitTool(() => state({ jobs: { 'job-2': { exitCode: 1, lastLine: '', ms: 1000 } } }))
    expect((await bad.execute({ job: 'job-2', seconds: 2 })).text).toMatch(/it FAILED: say so/)
  })

  it('waits for an app and for a title, and matches the title loosely', async () => {
    const tool = awaitTool(() => state())
    expect((await tool.execute({ app: 'Notes', seconds: 2 })).happened).toBe(true)
    expect((await tool.execute({ window: 'lunch', seconds: 2 })).happened).toBe(true)
    expect((await tool.execute({ app: 'Notes', window: 'Lunch', seconds: 2 })).happened).toBe(true)
  })

  // Runs 175-178 T14: the page title read "Order desk, loading"; a window wait for words it already held came back at
  // once, so every run fell back to timers. `gone` waits for the words to leave the title.
  it('waits for words to leave the front window title (a page still loading)', async () => {
    const live = state({ window: { active: { processName: 'Zen', windowTitle: 'Order desk, loading' } } })
    expect(waitFor({ gone: 'Loading' }).test(live)).toBeNull()
    const tool = awaitTool(() => live)
    const done = tool.execute({ gone: 'loading', seconds: 3 })
    setTimeout(() => { live.window.active.windowTitle = 'Order desk, ready' }, 300)
    const out = await done
    expect(out.happened).toBe(true)
    expect(out.text).toMatch(/Order desk, ready/)
  })

  // Runs 179-182 T14: Finder was in front in the fold while the page loaded in Zen behind it (an answer at once, wrong), and
  // a title changed under the slip never reached the fold. `gone` reads the window of the app last looked at, by a look.
  it('gone reads the app\'s own window title, never the fold\'s front window', async () => {
    const live = state({ window: { active: { processName: 'Finder', windowTitle: 'notes.txt Info' } }, marks: { lastLook: { id: 'look-1', app: 'Zen' } } })
    const titles = ['Order desk, loading', 'Order desk, loading', 'Order desk, ready']
    const asked = []
    const tool = awaitTool(() => live, undefined, undefined, undefined, undefined, undefined, async (app) => (asked.push(app), titles.shift()))
    const out = await tool.execute({ gone: 'loading', seconds: 5 })
    expect(out).toMatchObject({ happened: true })
    expect(out.text).toMatch(/^Zen's window is "Order desk, ready" now\..*Act at once/)
    expect(asked).toEqual(['Zen', 'Zen', 'Zen'])
    expect(tool.description).toMatch(/gone \(until the window title of app/)
  })

  // Runs 183, 186, 187 T14: look, wait, look again, act, answer: 5 steps where 4 are the bar. Run 189: a window wait came
  // back at once on "…, loading", then a look and a second wait (6). The wait brings the look; a loading window is not there yet.
  it('a wait for loading to go comes back with the look, and a window wait on a loading title waits for it too', async () => {
    const live = state({ marks: { lastLook: { id: 'look-1', app: 'Zen' } } })
    const looked = []
    const lookAt = async (app, exec) => (looked.push([app, exec?.callId]), 'Zen, window "Order desk, ready" (look-0000abcd): 26 things\ne7@abcd button "Start order" [press]')
    const make = (titles) => awaitTool(() => live, undefined, undefined, undefined, undefined, undefined, async () => titles.shift(), lookAt)
    const out = await make(['Order desk, loading', 'Order desk, ready']).execute({ app: 'Zen', gone: 'loading', seconds: 5 }, { callId: 'c1' })
    expect(out.text).toMatch(/^Zen's window is "Order desk, ready" now\. Waited \d+s\. Its look, taken now: act on a ref from it at once, with no new look\.\nZen, window "Order desk, ready"[\s\S]*e7@abcd button "Start order"/)
    expect(looked).toEqual([['Zen', 'c1']])
    const win = await make(['Order desk, loading', 'Order desk, loading', 'Order desk, ready']).execute({ app: 'Zen', window: 'Order desk', seconds: 5 })
    expect(win).toMatchObject({ happened: true })
    expect(win.text).toMatch(/"Order desk, ready" now\..*e7@abcd/s)
    // A window wait whose title is not loading is answered as before, with no look.
    const plain = await make(['Lunch - Notes']).execute({ app: 'Notes', window: 'Lunch', seconds: 2 })
    expect(plain.text).toMatch(/^Notes is in front, its window is "Lunch - Notes"\./)
    expect(looked).toHaveLength(2)
  })

  it('ends on the fact the moment it lands, not when the time runs out', async () => {
    const live = state()
    const tool = awaitTool(() => live)
    const at = Date.now()
    setTimeout(() => { live.jobs = { 'job-3': { exitCode: 0, lastLine: 'done', ms: 400 } } }, 400)
    const out = await tool.execute({ job: 'job-3', seconds: 30 })
    expect(out.happened).toBe(true)
    expect(Date.now() - at).toBeLessThan(3000)
  })

  it('with nothing named, waits for the app in front to change (run 15: it could not name the app)', async () => {
    const live = state()
    const tool = awaitTool(() => live)
    setTimeout(() => { live.window.active = { processName: 'Calculator', windowTitle: 'Calculator' } }, 300)
    const out = await tool.execute({ seconds: 20 })
    expect(out.happened).toBe(true)
    expect(out.text).toMatch(/^Calculator is in front/)
  })

  it('with nothing named right after this chat\'s shell call: its job is the wait, and a call that started none is said at once (run 36 T01)', async () => {
    const chat = { agent: { session: { id: 'chat-a' } } }
    const shells = new Map([['chat-a', { at: Date.now(), failed: true }]])
    const lastShell = (session) => shells.get(session)
    const at = Date.now()
    const none = await awaitTool(() => state(), undefined, lastShell).execute({}, chat)
    expect(Date.now() - at).toBeLessThan(500)
    expect(none).toMatchObject({ happened: false, waited: 0 })
    expect(none.text).toMatch(/^Nothing is running: the gnomon_run_shell call before this wait did not start a job/)
    // Another chat, or an old failure, still watches the app in front.
    expect((await awaitTool(() => state(), undefined, lastShell).execute({ seconds: 1 }, { agent: { session: { id: 'chat-b' } } })).text).toMatch(/stop being Notes/)
    shells.set('chat-a', { at: Date.now() - 60_000, failed: true })
    expect((await awaitTool(() => state(), undefined, lastShell).execute({ seconds: 1 }, chat)).text).toMatch(/stop being Notes/)
    // A job this chat just started is what an empty wait waits for.
    const live = state()
    shells.set('chat-a', { at: Date.now(), failed: false, job: 'job-7' })
    setTimeout(() => { live.jobs = { 'job-7': { exitCode: 0, lastLine: 'line 6', ms: 300 } } }, 300)
    expect((await awaitTool(() => live, undefined, lastShell).execute({ seconds: 5 }, chat)).text).toMatch(/^The job job-7 finished/)
    // Review: a job that already finished answers at once, never the front-app wait.
    const done = Date.now()
    expect((await awaitTool(() => live, undefined, lastShell).execute({ seconds: 20 }, chat)).text).toMatch(/^The job job-7 finished/)
    expect(Date.now() - done).toBeLessThan(500)
  })

  // Set 2 R3: the chat's last shell call was a Map in index.js, so a restart forgot a running job.
  it('a running job is in the fold, and an empty wait after a restart still waits for it; a failed start is still said', async () => {
    let live = { ...createInitialState('test-device'), window: { active: { processName: 'Notes', windowTitle: 'Lunch - Notes' } } }
    const append = async (type, payload) => { live = shellJobs(live, { id: `e-${type}`, type, ts: new Date().toISOString(), payload }).state }
    let finish
    const shell = { resolve: (spec) => spec, execute: async () => ({ result: () => new Promise((done) => { finish = done }) }) }
    const chat = { agent: { session: { id: 'chat-a' } } }
    const out = await runShellTool(append, '/tmp', shell, { recordCommand: () => {} }).execute({ command: 'make all', background: true }, chat)
    expect(shellOf(live, 'chat-a')).toMatchObject({ failed: false, job: out.jobId, running: true })
    // The restart: the process is gone, the snapshot is what is left.
    live = JSON.parse(JSON.stringify(live))
    const waiting = awaitTool(() => live, undefined, (s) => shellOf(live, s)).execute({ seconds: 5 }, chat)
    setTimeout(() => void append('shell:exited', { jobId: out.jobId, exitCode: 0, lastLine: 'built', ms: 300 }), 300)
    expect((await waiting).text).toMatch(new RegExp(`^The job ${out.jobId} finished.*"built"`))
    expect(shellOf(live, 'chat-a').running).toBe(false)
    finish({ exitCode: 0, stdout: { text: '' } })
    // A refused start, folded, then a restart: the empty wait says nothing runs, at once.
    await runShellTool(append, '/tmp', shell, { recordCommand: () => {} }).execute({ command: 'sleep 30' }, chat)
    live = JSON.parse(JSON.stringify(live))
    expect((await awaitTool(() => live, undefined, (s) => shellOf(live, s)).execute({}, chat)).text).toMatch(/^Nothing is running/)
  })

  it('a job started before this process booted is not running: a bare wait says so at once instead of waiting on it', async () => {
    const live = { ...state(), shells: { 'chat-a': { at: new Date().toISOString(), failed: false, job: 'job-9' } }, jobs: {} }
    const later = Date.now() + 1000
    expect(shellOf(live, 'chat-a')).toMatchObject({ job: 'job-9', running: true })
    expect(shellOf(live, 'chat-a', later)).toMatchObject({ job: 'job-9', running: false, lost: true })
    // An exit row that came is still an ended job, never lost.
    expect(shellOf({ ...live, jobs: { 'job-9': { exitCode: 0 } } }, 'chat-a', later)).toMatchObject({ running: false })
    expect(shellOf({ ...live, jobs: { 'job-9': { exitCode: 0 } } }, 'chat-a', later).lost).toBeUndefined()
    const at = Date.now()
    const out = await awaitTool(() => live, undefined, (s) => shellOf(live, s, later)).execute({}, { agent: { session: { id: 'chat-a' } } })
    expect(Date.now() - at).toBeLessThan(500)
    expect(out).toMatchObject({ happened: false, waited: 0 })
    expect(out.text).toMatch(/^Nothing is running: the job job-9 started before Sundial restarted/)
  })

  it('says what was there instead when it does not happen, and never claims it did', async () => {
    const out = await awaitTool(() => state()).execute({ app: 'Calculator', seconds: 1 })
    expect(out.happened).toBe(false)
    expect(out.text).toMatch(/did not happen in 1s.*What is there now: Notes.*do not say it did/)
  })

  it('an app running behind another after 3 s is said then, as not happened; one that comes forward in time still counts (run 76 T03)', async () => {
    const running = async () => true
    const live = state()
    setTimeout(() => { live.window.active = { processName: 'Zen', windowTitle: 'Clock' } }, 1500)
    expect((await awaitTool(() => live, undefined, undefined, running).execute({ app: 'Zen', seconds: 30 })).text).toMatch(/^Zen is in front/)
    const at = Date.now()
    const out = await awaitTool(() => state(), undefined, undefined, running).execute({ app: 'Zen', seconds: 30 })
    expect(Date.now() - at).toBeGreaterThanOrEqual(2900)
    expect(Date.now() - at).toBeLessThan(5000)
    expect(out).toMatchObject({ happened: false, text: 'Zen has been running the whole time, behind Notes: it did not just open.' })
    expect((await awaitTool(() => state(), undefined, undefined, async () => false).execute({ app: 'Calculator', seconds: 4 })).text).toMatch(/did not happen in 4s/)
  }, 15_000)

  it('ends on the fold\'s change event, long before the slow poll behind it (run 20)', async () => {
    const live = state()
    const { wake, changed } = wakes()
    const tool = awaitTool(() => live, changed)
    const at = Date.now()
    setTimeout(() => { live.jobs = { 'job-4': { exitCode: 0, lastLine: 'done', ms: 50 } }; wake() }, 50)
    expect((await tool.execute({ job: 'job-4', seconds: 30 })).happened).toBe(true)
    expect(Date.now() - at).toBeLessThan(600)
    // An event that is missed costs at most the slow poll, never the whole wait.
    setTimeout(() => { live.jobs['job-5'] = { exitCode: 0, lastLine: 'done', ms: 50 } }, 50)
    expect((await tool.execute({ job: 'job-5', seconds: 30 })).happened).toBe(true)
    expect(Date.now() - at).toBeLessThan(2500)
  })

  it('waits for a file to come to exist or to change, and for a number of seconds (run 20)', async () => {
    const tool = awaitTool(() => state())
    const path = join(mkdtempSync(join(tmpdir(), 'await-')), 'report.pdf')
    setTimeout(() => writeFileSync(path, 'box'), 100)
    expect(await tool.execute({ file: path, seconds: 10 })).toMatchObject({ happened: true, text: expect.stringMatching(/report\.pdf is there now \(3 bytes\)/) })
    setTimeout(() => appendFileSync(path, ' 484'), 100)
    expect(await tool.execute({ file: path, seconds: 10 })).toMatchObject({ happened: true, text: expect.stringMatching(/report\.pdf changed \(7 bytes\).*Read the file next.*do not wait on it again/) })
    expect(await tool.execute({ file: path, seconds: 1 })).toMatchObject({ happened: false, text: expect.stringMatching(/did not change in 1s.*do not say it did/) })
    await expect(tool.execute({ file: join(path, 'no-such-folder', 'a.txt') })).rejects.toThrow(/^invalid arguments: file is a whole path in a folder that exists/)
    await expect(tool.execute({ file: 'report.pdf' })).rejects.toThrow(/^invalid arguments: file is a whole path/)
    const at = Date.now()
    expect(await tool.execute({ after: 0.3 })).toMatchObject({ happened: true, text: expect.stringMatching(/went by\. Nothing was watched: look or read/) })
    expect(Date.now() - at).toBeGreaterThanOrEqual(290)
  })

  it('a first-call `after` counts from the owner\'s message, not from the call (run 84 T03)', async () => {
    vi.useFakeTimers({ now: 100_000 })
    try {
      const own = { type: 'user/message', time: 87_000, data: { source: { kind: 'user' } } }
      const turn = (rest = [], said = own) => ({ agent: { session: { snapshotEvents: () => [{ type: 'turn/start', time: 86_000 }, said, ...rest] } } })
      const tool = awaitTool(() => state())
      expect(tool.description).toMatch(/After a timed wait, act at once and read the clock after the act\./)
      expect(tool.description).toContain('or nothing at all (until the app in front changes: how to watch for something you cannot name, or an app opening by itself)')
      const first = tool.execute({ after: 35 }, turn())
      await vi.advanceTimersByTimeAsync(22_000)
      expect(await first).toMatchObject({ waited: 22, text: expect.stringMatching(/^Waited until 35s after your message \(13s of it went to thinking\)/) })
      // A tool already answered in this turn: the call is the start.
      const later = tool.execute({ after: 35 }, turn([{ type: 'tool/result', time: 90_000 }]))
      await vi.advanceTimersByTimeAsync(35_000)
      expect(await later).toMatchObject({ waited: 35, text: expect.stringMatching(/^35s went by/) })
      // A message steered in mid-turn counts from that message; a compaction checkpoint after it is read past.
      const compact = { type: 'user/message', time: 154_000, data: { source: { kind: 'compact-checkpoint' } } }
      const steered = tool.execute({ after: 10 }, turn([{ type: 'tool/result', time: 90_000 }, { ...own, time: 150_000 }, compact]))
      await vi.advanceTimersByTimeAsync(3_000)
      expect(await steered).toMatchObject({ waited: 3, text: expect.stringMatching(/^Waited until 10s after your message \(7s of it/) })
      // A turn a notice opened: no "your message".
      const notice = tool.execute({ after: 20 }, turn([], { type: 'user/message', time: 150_000, data: { source: { kind: 'notice' } } }))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await notice).toMatchObject({ waited: 10, text: expect.stringMatching(/^Waited until 20s after the turn began \(10s of it/) })
    } finally {
      vi.useRealTimers()
    }
  })

  it('with nothing named, an app that came to the front after the message is said at once, neutrally (run 97 T06)', async () => {
    const msg = Date.parse('2026-03-02T10:00:00Z')
    const chat = { agent: { session: { snapshotEvents: () => [{ type: 'turn/start', time: msg - 500 }, { type: 'user/message', time: msg, data: { source: { kind: 'user' } } }, { type: 'tool/result', time: msg + 32_000 }, { type: 'tool/result', time: msg + 43_000 }] } } }
    const row = (app, s) => ({ app, at: new Date(msg + s * 1000).toISOString() })
    const wait = (app, rows, started = msg + 30_000, seconds = 1) => awaitTool(() => state({ window: { active: { processName: app, windowTitle: app } } }), undefined, undefined, undefined, async () => rows, async (name) => (name === app ? started : null)).execute({ seconds }, chat)
    // Only an app whose process started after the message (it opened itself) answers at once.
    expect(await wait('Calculator', [row('Calculator', 33), row('Calculator', 31), row('Finder', -50)], msg + 30_000, 20)).toMatchObject({ happened: true, waited: 0, text: expect.stringMatching(/^Calculator has been in front since \d\d:\d\d:\d\d \(31s after your message\); at your message it was Finder\.$/) })
    expect(await wait('Calculator', [row('Calculator', 31), row('Zen', -50)])).toMatchObject({ happened: true, text: expect.stringMatching(/at your message it was Zen\.$/) })
    // The owner switching to an app already running, or a start time not known: wait as before.
    expect((await wait('Mail', [row('Mail', 31), row('Finder', -50)], msg - 600_000)).text).toMatch(/did not happen in 1s/)
    expect((await wait('Xcode', [row('Xcode', 31), row('Zen', -50)], null)).text).toMatch(/did not happen in 1s/)
    // In front since before the message, or the log does not reach back to it: wait as before.
    for (const rows of [[row('Calculator', 10), row('Calculator', -5)], [row('Calculator', 10), row('Finder', 5)], []]) expect((await wait('Calculator', rows)).text).toMatch(/did not happen in 1s/)
    // A hidden app is named as one.
    expect((await wait('[hidden]', [row('[hidden]', 31), row('Finder', -50)])).text).toMatch(/^A hidden app has been in front since .*; at your message it was Finder\.$/)
    // Finder at the message, Calculator, Finder, Calculator again: the last run counts.
    expect(cameToFront([row('Calculator', 40), row('Finder', 20), row('Calculator', 10), row('Finder', -1)], 'Calculator', msg)).toEqual({ at: msg + 40_000, before: 'Finder' })
    expect(cameToFront([row('Finder', 40), row('Calculator', 10), row('Finder', -1)], 'Calculator', msg)).toBe(null)
  }, 15_000)

  it('an app Gnomon fronted with screen_act is not "it already happened": it counts from the act (run 97 T06)', async () => {
    const msg = Date.parse('2026-03-02T10:00:00Z')
    const row = (app, s) => ({ app, at: new Date(msg + s * 1000).toISOString() })
    const call = (name, args = '{}') => ({ type: 'assistant/message', time: msg + 15_000, data: { message: { content: [{ type: 'tool-call', id: 'call-1', name, arguments: args }] } } })
    const chat = (said) => ({ agent: { session: { snapshotEvents: () => [{ type: 'user/message', time: msg, data: { source: { kind: 'user' } } }, said, { type: 'tool/result', time: msg + 20_000, data: { message: { toolCallId: 'call-1' } } }] } } })
    const live = state({ window: { active: { processName: 'TextEdit', windowTitle: 'Untitled' } } })
    const wait = (rows, said) => awaitTool(() => live, undefined, undefined, undefined, async () => rows, async () => msg + 18_000).execute({ seconds: 1 }, chat(said))
    for (const said of [call('screen_act'), call('gnomon_call', '{"name": "screen_act", "args": {}}')]) expect((await wait([row('TextEdit', 19), row('Finder', -50)], said)).text).toMatch(/did not happen in 1s/)
    // Another tool's answer moves nothing; an app that came after the act still counts.
    expect((await wait([row('TextEdit', 19), row('Finder', -50)], call('screen_look'))).text).toMatch(/^TextEdit has been in front since .* \(19s after your message\)/)
    expect((await wait([row('TextEdit', 30), row('Finder', 19), row('Finder', -50)], call('screen_act'))).text).toMatch(/^TextEdit has been in front since .* \(30s after your message\)/)
  })

  it('an app runs as Swift resolves its name: case-insensitive, exact or a part of it (round 23 review)', () => {
    const out = ' 1) "Finder" ASN:0x0-0x1001: \n    bundleID="com.apple.finder"\n 2) "Calculator" ASN:0x0-0x2002: \n 3) "Google Chrome" ASN:0x0-0x3003: \n    bundle path="/Applications/Notes.app"\n'
    for (const app of ['calculator', 'Chrome', 'Finder']) expect(appIn(out, app)).toBe(true)
    for (const app of ['Notes', 'Safari', ' ']) expect(appIn(out, app)).toBe(false)
  })
})

describe('Set 4 R2: a long job on the shelf', () => {
  const at = (shelve) => awaitTool(() => state(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, shelve)
  const exec = { agent: { session: { id: 'session-box' } } }

  it('a job wait past a minute goes on the shelf at once: one await:shelved row, and the one line the turn ends on', async () => {
    const rows = []
    const started = Date.now()
    const out = await at(async (row) => rows.push(row)).execute({ job: 'job-7', seconds: 120, about: 'the build' }, exec)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(rows).toEqual([{ sessionId: 'session-box', job: 'job-7', about: 'the build' }])
    expect(out).toMatchObject({ happened: false, waited: 0 })
    expect(out.text.split('\n')[0]).toBe('On the shelf: Waiting for the build, I will knock.')
  })

  it('a minute or less, a job already ended, or no shelf wired: the wait runs as before, nothing shelved', async () => {
    const rows = []
    const shelve = async (row) => rows.push(row)
    expect((await at(shelve).execute({ job: 'job-7', seconds: 1 }, exec)).text).toMatch(/did not happen in 1s/)
    const done = awaitTool(() => state({ jobs: { 'job-7': { exitCode: 0, lastLine: 'ok', ms: 5000 } } }), undefined, undefined, undefined, undefined, undefined, undefined, undefined, shelve)
    expect((await done.execute({ job: 'job-7', seconds: 120 }, exec)).text).toMatch(/finished after 5s/)
    expect(rows).toEqual([])
    expect((await at(null).execute({ job: 'job-7', seconds: 1 }, exec)).happened).toBe(false)
  })
})
