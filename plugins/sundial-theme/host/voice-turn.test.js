import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HOLD_MS, mountVoice, sentencesOf, speakable } from './voice-turn.js'
import { voiceKnock } from '../../../packages/rules/src/voice-knock.ts'
import { createInitialState } from '../../../packages/kernel/src/initial-state.ts'

/** A ctx with the two events the voice turn listens to, and the app channel it writes. Made-up values. */
function fakeCtx(state = { voice: { recentLines: [] } }) {
  const on = {}
  const sent = []
  const signals = []
  return {
    ctx: {
      on: (name, fn) => (on[name] = fn),
      gnomonKernel: { getState: () => state, appChannel: { send: (c) => sent.push(c) }, appendSignal: async (type, payload) => signals.push({ type, ...payload }) },
    },
    stream: (sessionId, text) => on['agent/assistant-stream']({ agent: { session: { id: sessionId } }, frame: { type: 'chunk', chunk: { type: 'text-delta', text } } }),
    event: (sessionId, type, data = {}) => on['session/event']({ id: sessionId }, { type, data }),
    step: (session, stepId, line) => on['gnomon/step-line']({ session, stepId, line }),
    raw: (payload) => on['gnomon/step-line'](payload),
    sent,
    signals,
    // The voice:line rows without the turn fields every row carries (Set 2 R3).
    lines: () => signals.filter((s) => s.type === 'voice:line').map(({ session: _s, turnAt: _t, seq: _q, ...row }) => row),
    state,
  }
}

describe('a spoken turn (plan 15 step 3)', () => {
  it('cuts the stream at sentence ends and keeps the rest', () => {
    expect(sentencesOf('Your next meeting is at 15:00. It is the **Jonas** interview! And')).toEqual({ done: ['Your next meeting is at 15:00.', 'It is the Jonas interview!'], rest: 'And' })
    expect(speakable('- [the PR](https://example.test/pr/212) is open, run `pnpm test`.')).toBe('the PR is open, run.')
  })

  it('says units, dashes, brackets and symbols the way a person does, in English and Dutch', () => {
    expect(speakable('Roast at 200°C — about 15 minutes per 500g (e.g. a small one), 3-5h, €12.50 & ~2 tbsp.', 'english')).toBe('Roast at 200 degrees, about 15 minutes per 500 grams, for example a small one, 3 to 5 hours, 12.50 euros and about 2 tbsp.')
    expect(speakable('Zet de oven op 180 °C, 25-30 min, met 1,5 kg aardappelen.', 'dutch')).toBe('Zet de oven op 180 graden, 25 tot 30 minuten, met 1,5 kilo aardappelen.')
    expect(speakable('It rose 12% in the 1990s on 5G.')).toBe('It rose 12 percent in the 1990s on 5G.')
  })

  it('splits two messages that streamed back to back without a space', () => {
    expect(sentencesOf('Checking now.Claude itself is up today. And')).toEqual({ done: ['Checking now.', 'Claude itself is up today.'], rest: 'And' })
  })

  it('says the sentences of the first paragraph as they come', () => {
    const f = fakeCtx()
    const voice = mountVoice(f.ctx)
    voice.begin('s1', 'en')
    f.stream('s1', 'You are in Xcode. Forty-two minutes ')
    f.stream('s1', 'into focus. Then the interview at three.')
    expect(f.sent.map((c) => [c.text, c.seq, c.last ?? false])).toEqual([['You are in Xcode.', 0, false], ['Forty-two minutes into focus.', 1, false]])
    expect(f.sent[0]).toMatchObject({ type: 'speak', mode: 'reply', lang: 'en', sound: null })
    f.stream('s2', 'Another thread. Not spoken.')
    expect(f.sent).toHaveLength(2)
  })

  // The shape the bench picked: the paragraph is what a colleague says, and what follows it is only shown.
  it('stops at the end of the first paragraph, and says its tail as the last line', () => {
    const f = fakeCtx()
    mountVoice(f.ctx).begin('s1', 'en')
    f.stream('s1', 'Ines left four comments. The reducer mutates state')
    f.stream('s1', '.\n\nHere they are:\n\n- line 88 mutates\n- breakpoint hard-coded')
    expect(f.sent.map((c) => [c.text, c.last ?? false])).toEqual([
      ['Ines left four comments.', false],
      ['The reducer mutates state.', true],
    ])
    f.event('s1', 'turn/end')
    expect(f.sent).toHaveLength(2)
  })

  it('does not say a list, a heading or code that follows the paragraph with no blank line', () => {
    const f = fakeCtx()
    mountVoice(f.ctx).begin('s1', 'en')
    f.stream('s1', 'Three are open.\n- PR 212\n- BOX-484\n- the tablet layout')
    f.event('s1', 'turn/end')
    expect(f.sent.map((c) => c.text)).toEqual(['Three are open.'])
  })

  it('says at most six sentences, however long the paragraph is', () => {
    const f = fakeCtx()
    mountVoice(f.ctx).begin('s1', 'en')
    f.stream('s1', 'One. Two. Three. Four. Five. Six. Seven. Eight. ')
    expect(f.sent).toHaveLength(6)
    expect(f.sent.at(-1)).toMatchObject({ text: 'Six.', last: true })
  })

  it('a reply of one sentence and an unfinished second: the second is said as the last line', () => {
    const f = fakeCtx()
    mountVoice(f.ctx).begin('s1', null)
    f.stream('s1', 'Yes. ')
    f.stream('s1', "It's done.")
    f.event('s1', 'turn/end')
    expect(f.sent.map((c) => [c.text, c.last ?? false])).toEqual([['Yes.', false], ["It's done.", true]])
  })

  it('a turn that said all it had still tells the app it ended', () => {
    const f = fakeCtx()
    mountVoice(f.ctx).begin('s1', null)
    f.stream('s1', 'Yes. ')
    f.event('s1', 'turn/end')
    expect(f.sent.map((c) => [c.text, c.last ?? false])).toEqual([['Yes.', false], ['', true]])
  })

  it('a reply with no end mark is said when the turn ends', () => {
    const f = fakeCtx()
    mountVoice(f.ctx).begin('s1', null)
    f.stream('s1', 'Fifteen hundred')
    f.event('s1', 'turn/end')
    expect(f.sent.map((c) => c.text)).toEqual(['Fifteen hundred'])
  })

  it('the owner stopped it: nothing more is said', () => {
    const f = fakeCtx({ voice: { recentLines: [], interruptedAt: '2999-01-01T00:00:00.000Z' } })
    mountVoice(f.ctx).begin('s1', null)
    f.stream('s1', 'One. Two.')
    expect(f.sent).toEqual([])
  })

  it('a tool still running 1.5 s after the nod gets one holding line, logged so it is not said twice in a row', async () => {
    vi.useFakeTimers()
    try {
      const f = fakeCtx({ voice: { recentLines: ['Let me look at the day.'] } })
      mountVoice(f.ctx, { now: () => Date.now() }).begin('s1', null)
      f.event('s1', 'tool/call', { name: 'gnomon_today_summary' })
      f.event('s1', 'tool/call', { name: 'gnomon_people' })
      await vi.advanceTimersByTimeAsync(HOLD_MS + 10)
      expect(f.sent.map((c) => [c.text, c.holding])).toEqual([['One moment, reading today.', true]])
      expect(f.lines()).toEqual([{ type: 'voice:line', line: 'One moment, reading today.', tool: 'gnomon_today_summary' }])
    } finally {
      vi.useRealTimers()
    }
  })
})

// Round 5 (NEXT 3.1): a screen step says its own line as it starts, in the reply's order, logged with its step id.
describe("a screen step's own line", () => {
  it('in a spoken turn: said in order with its step id, logged, and no holding line after it', async () => {
    vi.useFakeTimers()
    try {
      const f = fakeCtx()
      mountVoice(f.ctx, { now: () => Date.now() }).begin('s1', 'en')
      f.event('s1', 'tool/call', { name: 'screen_act' })
      f.step('s1', 'act-1', 'Open the "Sort By" menu')
      await vi.advanceTimersByTimeAsync(HOLD_MS + 10)
      expect(f.sent).toEqual([expect.objectContaining({ type: 'speak', mode: 'reply', text: 'Open the Sort By menu', seq: 0, holding: true, stepId: 'act-1' })])
      expect(f.lines()).toEqual([{ type: 'voice:line', line: 'Open the Sort By menu', tool: 'screen_act', stepId: 'act-1' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('never the same line twice in a row, in the turn or after the last line logged', () => {
    const f = fakeCtx({ voice: { recentLines: ['Open Finder'] } })
    mountVoice(f.ctx).begin('s1', 'en')
    f.step('s1', 'act-1', 'Open Finder')
    f.step('s1', 'act-2', 'Press New Folder')
    f.step('s1', 'act-3', 'Press New Folder')
    expect(f.sent.map((c) => c.stepId)).toEqual(['act-2'])
  })

  it('silent with no spoken turn (a typed turn, or read-back off), after the stop, and past the spoken part', () => {
    const f = fakeCtx({ voice: { recentLines: [] }, config: { experiments: { holdToTalk: false } } })
    mountVoice(f.ctx).begin('s1', 'en')
    f.step('s1', 'act-1', 'Open Finder')
    f.step('s2', 'act-2', 'Open Finder')
    const stopped = fakeCtx({ voice: { recentLines: [], interruptedAt: '2999-01-01T00:00:00.000Z' } })
    mountVoice(stopped.ctx).begin('s1', 'en')
    stopped.step('s1', 'act-3', 'Open Finder')
    const done = fakeCtx()
    mountVoice(done.ctx).begin('s1', 'en')
    done.stream('s1', 'Opening it.\n\nMore below.')
    done.step('s1', 'act-4', 'Open Finder')
    expect([f.sent, stopped.sent, done.sent.filter((c) => c.stepId)]).toEqual([[], [], []])
  })

  it("silent in the rig's sessions, unless config voice.rigLines asks for it", () => {
    const home = mkdtempSync(join(tmpdir(), 'sundial-voice-'))
    vi.stubEnv('SUNDIAL_HOME', home)
    try {
      const f = fakeCtx({ voice: { recentLines: [] }, rigSessions: { 'session-rig': '2026-11-15T09:00:00.000Z' } })
      const voice = mountVoice(f.ctx)
      voice.begin('session-rig', 'en')
      f.step('session-rig', 'act-1', 'Open Finder')
      expect(f.sent).toEqual([])
      writeFileSync(join(home, 'config.json'), JSON.stringify({ voice: { rigLines: true } }))
      voice.begin('session-rig', 'en')
      f.step('session-rig', 'act-2', 'Open Finder')
      expect(f.sent.filter((c) => c.stepId).map((c) => c.stepId)).toEqual(['act-2'])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

// Set 2 R1 item 5: a refused step is said with the next step's words, once, as one line.
describe('a refused step, said with the next', () => {
  const refuse = (f, session, stepId, reason = 'not-found', name = 'Sort By') => f.raw({ session, stepId, refused: { reason, name } })
  it('holds the refusal, then says one line built from both before the next act, logged with the refused step', () => {
    const f = fakeCtx()
    mountVoice(f.ctx).begin('s1', 'en')
    refuse(f, 's1', 'act-1')
    expect(f.sent).toEqual([])
    f.raw({ session: 's1', stepId: 'act-2', line: null, next: 'Open the View menu' })
    expect(f.sent.map((c) => [c.text, c.stepId])).toEqual([['Sort By not found. Open the View menu.', 'act-2']])
    expect(f.lines()).toEqual([{ type: 'voice:line', line: 'Sort By not found. Open the View menu.', tool: 'screen_act', stepId: 'act-2', refused: 'act-1' }])
    // Consumed: the step after it says only its own line.
    f.raw({ session: 's1', stepId: 'act-3', line: 'Press Size', next: 'Press Size' })
    expect(f.sent.at(-1).text).toBe('Press Size')
  })

  it('never the same refusal line twice in a turn: the second time the step says only its own line, or nothing', () => {
    const f = fakeCtx()
    mountVoice(f.ctx).begin('s1', 'en')
    refuse(f, 's1', 'act-1')
    f.raw({ session: 's1', stepId: 'act-2', line: null, next: 'Open the View menu' })
    refuse(f, 's1', 'act-3')
    f.raw({ session: 's1', stepId: 'act-4', line: null, next: 'Open the View menu' })
    expect(f.sent.map((c) => c.text)).toEqual(['Sort By not found. Open the View menu.'])
    expect(f.signals.filter((s) => s.refused)).toHaveLength(1)
  })

  it('waits for a step that has words: an escape (no next) leaves it held', () => {
    const f = fakeCtx()
    mountVoice(f.ctx).begin('s1', 'en')
    refuse(f, 's1', 'act-1', 'covered', 'View > Sort By')
    f.raw({ session: 's1', stepId: 'act-2' })
    f.raw({ session: 's1', stepId: 'act-3', line: null, next: 'Raise the Finder window' })
    expect(f.sent.map((c) => c.text)).toEqual(['Sort By is covered. Raise the Finder window.'])
  })

  it('silent outside a spoken turn, and in a rig session', () => {
    const typed = fakeCtx()
    mountVoice(typed.ctx)
    refuse(typed, 's1', 'act-1')
    typed.raw({ session: 's1', stepId: 'act-2', line: null, next: 'Open the View menu' })
    const rig = fakeCtx({ voice: { recentLines: [] }, rigSessions: { 'session-rig': '2026-11-15T09:00:00.000Z' } })
    mountVoice(rig.ctx).begin('session-rig', 'en')
    refuse(rig, 'session-rig', 'act-1')
    rig.raw({ session: 'session-rig', stepId: 'act-2', line: null, next: 'Open the View menu' })
    expect([typed.sent, typed.signals, rig.sent, rig.lines()]).toEqual([[], [], [], []])
  })
})

// Set 2 R3: what a spoken turn sent is folded (`voice:turn`, `voice:line`), so a restart mid-reply goes on past it.
describe('a restart in the middle of a spoken reply', () => {
  /** The host, wired to the real fold: every row it appends lands in `state.voice` at once. `restart()` keeps only the snapshot. */
  function host() {
    const base = createInitialState('test-device')
    let state = { ...base, config: { ...base.config, experiments: { ...base.config.experiments, holdToTalk: true } }, voice: { pendingKnock: null, recentLines: [], mutedUntil: null } }
    let n = 0
    const sent = []
    let on = {}
    const ctx = {
      on: (name, fn) => (on[name] = fn),
      gnomonKernel: { getState: () => state, appChannel: { send: (c) => sent.push(c) }, appendSignal: async (type, payload) => { state = voiceKnock(state, { id: `e-${n++}`, type, ts: new Date().toISOString(), payload }).state } },
    }
    const mount = () => { on = {}; return mountVoice(ctx) }
    return {
      voice: mount(),
      restart() { state = JSON.parse(JSON.stringify(state)); sent.length = 0; return mount() },
      stream: (id, text) => on['agent/assistant-stream']({ agent: { session: { id } }, frame: { type: 'chunk', chunk: { type: 'text-delta', text } } }),
      event: (id, type) => on['session/event']({ id }, { type, data: {} }),
      sent,
      state: () => state,
      setTask: (task) => { state = { ...state, task } },
    }
  }

  it('says only the part not yet said, in the same turn and seq order, even when the whole reply streams again', () => {
    const h = host()
    h.voice.begin('s1', 'en')
    h.stream('s1', 'You are in Xcode. Forty-two minutes into focus. Then')
    const turnAt = h.sent[0].turnAt
    expect(h.sent.map((c) => c.text)).toEqual(['You are in Xcode.', 'Forty-two minutes into focus.'])
    expect(h.state().voice.said).toMatchObject({ session: 's1', at: turnAt, lines: ['You are in Xcode.', 'Forty-two minutes into focus.'], seq: 2 })
    h.restart()
    h.stream('s1', 'You are in Xcode. Forty-two minutes into focus. Then the interview at three.')
    h.event('s1', 'turn/end')
    expect(h.sent.map((c) => [c.text, c.seq, c.turnAt, c.last ?? false])).toEqual([['Then the interview at three.', 2, turnAt, true]])
    expect(h.state().voice.said.ended).toBe(true)
    // The turn is over: a typed reply in that chat after another restart is not said.
    h.restart()
    h.stream('s1', 'A typed answer. Not spoken.')
    expect(h.sent).toEqual([])
  })

  it('a newer task in the chat, or a turn older than two minutes, is not taken up again', () => {
    const h = host()
    h.voice.begin('s1', 'en')
    h.stream('s1', 'One. ')
    h.restart()
    h.setTask({ id: 't2', at: new Date(Date.now() + 10_000).toISOString(), session: 's1', said: 'next' })
    h.stream('s1', 'Two. Three. ')
    expect(h.sent).toEqual([])
    const old = host()
    old.voice.begin('s2', 'en')
    old.stream('s2', 'One. ')
    vi.useFakeTimers({ now: Date.now() + 130_000 })
    try {
      old.restart()
      old.stream('s2', 'Two. Three. ')
      expect(old.sent).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
