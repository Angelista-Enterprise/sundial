import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { ownerThread, runFrame } from './run-feed.js'

const server = readFileSync(new URL('./server.js', import.meta.url), 'utf8')
const sessions = readFileSync(new URL('./api-sessions.js', import.meta.url), 'utf8')

const ev = (type, data = {}) => ({ type, data })
const said = (text, kind) => ev('user/message', { role: 'user', content: [{ type: 'text', text }], ...(kind ? { source: { kind } } : {}) })

describe('the live turn feed (the strip that follows threads the owner is not in)', () => {
  it('opens a run on turn/start, names it from the owner\'s words, and follows each step', () => {
    const runs = new Map()
    expect(runFrame(runs, 'session-a', ev('turn/start'), 1000)).toEqual({ type: 'run', id: 'session-a', since: 1000, title: null, step: null, done: null })
    expect(runFrame(runs, 'session-a', said('Open puzzlebox-studio and file BOX-484'), 1100).title).toBe('Open puzzlebox-studio and file BOX-484')
    const tool = runFrame(runs, 'session-a', ev('tool/call', { name: 'web_search', callId: 'c1', arguments: '{"query":"Mira Bakker"}' }), 2000)
    expect(tool).toMatchObject({ since: 1000, title: 'Open puzzlebox-studio and file BOX-484', step: 'Searching the web · “Mira Bakker”' })
    expect(runFrame(runs, 'session-a', ev('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'Filed it.\n\nThe ticket is open.' }] } })).step).toBe('Filed it. The ticket is open.')
    expect(runs.size).toBe(1)
  })

  it('closes the run on turn/end with how it ended, and forgets it', () => {
    const runs = new Map()
    runFrame(runs, 'session-a', ev('turn/start'), 1000)
    expect(runFrame(runs, 'session-a', ev('turn/end', { reason: { kind: 'aborted', reason: { kind: 'user' } } }))).toMatchObject({ id: 'session-a', done: 'aborted' })
    expect(runs.size).toBe(0)
    expect(runFrame(runs, 'session-a', ev('turn/end', {}))).toBeNull()
  })

  it('keeps several threads apart', () => {
    const runs = new Map()
    runFrame(runs, 'session-a', ev('turn/start'), 1)
    runFrame(runs, 'session-b', ev('turn/start'), 2)
    runFrame(runs, 'session-b', ev('tool/call', { name: 'todo_write', arguments: {} }), 3)
    expect([...runs.values()].map((r) => [r.id, r.step])).toEqual([['session-a', null], ['session-b', 'Updating the plan']])
  })

  it('moves nothing on what is not a step: a plugin notice, a tool-only message, a result', () => {
    const runs = new Map()
    runFrame(runs, 'session-a', ev('turn/start'), 1)
    expect(runFrame(runs, 'session-a', said('the brief', 'sundial-shell'))).toBeNull()
    expect(runFrame(runs, 'session-a', ev('assistant/message', { message: { role: 'assistant', content: [{ type: 'tool-call' }] } }))).toBeNull()
    expect(runFrame(runs, 'session-a', ev('tool/result', {}))).toBeNull()
    expect(runs.get('session-a').title).toBeNull()
  })

  it('follows the owner\'s threads only, never a helper\'s own session', () => {
    expect(ownerThread('gnomon-companion', 'gnomon-companion')).toBe(true)
    expect(ownerThread('session-1234', 'gnomon-companion')).toBe(true)
    expect(ownerThread('3f0c2a9e-helper', 'gnomon-companion')).toBe(false)
    expect(ownerThread(undefined, 'gnomon-companion')).toBe(false)
  })

  it('rides the live channel, and a tab that connects mid-run gets every open run', () => {
    expect(server).toMatch(/ownerThread\(session\?\.id, COMPANION_SESSION_ID\)[\s\S]{0,120}runFrame\(runs, session\.id, event\)[\s\S]{0,60}broadcast\(frame\)/)
    expect(sessions).toMatch(/emit\(\{ type: 'runs', runs: \[\.\.\.runs\.values\(\)\] \}\)/)
  })
})
