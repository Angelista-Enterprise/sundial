import { describe, expect, it, vi } from 'vitest'
import { COMPANION_SESSION_ID } from '@sundial/helpers/vocab.js'
import { createRouteLog, namesSet, stopLine } from './route-log.js'
import { SILENT_CODE, SILENT_LINE } from '../sundial-llm-openai/stall.js'

// The shapes a real dsh session log holds: `seq`/`time` on the event, the message id on `data`.
const T = Date.parse('2026-09-29T12:02:10.000Z')
const owner = (text, id = 'u1', time = T) => ({ type: 'user/message', seq: 1, time, data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const say = (text, turn = 1) => ({ type: 'assistant/message', seq: 2, time: T + 5_000, data: { turn, step: 0, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text }] } } })
const call = (name, args = '{}') => ({ type: 'tool/call', seq: 3, time: T + 1_000, data: { turn: 1, step: 0, callId: 'c', name, arguments: args } })
const end = (turn = 1) => ({ type: 'turn/end', seq: 4, time: T + 9_000, data: { turn, reason: { kind: 'completed' } } })
const flush = () => new Promise((r) => setTimeout(r, 0))
const setup = () => {
  const appendSignal = vi.fn(async () => {})
  return { appendSignal, on: createRouteLog({ appendSignal, log: () => {} }) }
}

describe('chat recorder (W1)', () => {
  it('records the owner and the reply, with the tools behind the dispatch door, at dsh\'s own times', async () => {
    const { appendSignal, on } = setup()
    const s = { id: 'session-7f', header: {} }
    on(s, owner('anything I forgot? token=sk-abc'))
    on(s, call('gnomon_current_context'))
    on(s, call('gnomon_call', JSON.stringify({ name: 'gnomon_code_activity', args: { days: 7 } })))
    on(s, say('263 commits not pushed yet.'))
    on(s, say('Push when ready.'))
    on(s, end())
    await flush()
    expect(appendSignal.mock.calls).toEqual([
      ['chat:owner', { sessionId: 'session-7f', turnId: 'u1', text: 'anything I forgot? token=sk-abc', chars: 31, images: 0 }, '2026-09-29T12:02:10.000Z'],
      ['chat:said', { sessionId: 'session-7f', turnId: 'u1', text: '263 commits not pushed yet.\n\nPush when ready.', chars: 45, tools: ['gnomon_current_context', 'gnomon_code_activity'] }, '2026-09-29T12:02:19.000Z'],
    ])
  })

  it('records the conversation too — a turn a notice woke has a reply and no owner — and never a subagent', async () => {
    const { appendSignal, on } = setup()
    on({ id: COMPANION_SESSION_ID, header: {} }, { type: 'user/message', time: T, data: { source: { kind: 'plugin', form: 'notice' }, content: 'Notice key: x' } })
    on({ id: COMPANION_SESSION_ID, header: {} }, say('Pushed: puzzlebox-studio is up to date.', 3))
    on({ id: COMPANION_SESSION_ID, header: {} }, end(3))
    on({ id: 'child', header: { origin: 'subagent' } }, owner('Count the commits in puzzlebox-studio'))
    on({ id: 'child', header: { origin: 'subagent' } }, say('48'))
    on({ id: 'child', header: { origin: 'subagent' } }, end())
    await flush()
    expect(appendSignal.mock.calls.map((c) => [c[0], c[1].sessionId, c[1].turnId])).toEqual([['chat:said', COMPANION_SESSION_ID, `${COMPANION_SESSION_ID}#3`]])
  })

  it('a turn the owner stopped answers where it stopped, once the step it caught has landed (runs 211, 212 T18)', async () => {
    const appendSignal = vi.fn(async () => {})
    const task = { did: ['rename "ember.txt" in Finder'], failed: [] }
    const shown = []
    // The step the Stop caught lands during the first wait; the second finds the lines still.
    const waits = []
    const wait = async () => { waits.push(1); if (waits.length === 1) task.did = [...task.did, 'rename "fennel.txt" in Finder'] }
    const on = createRouteLog({ appendSignal, log: () => {}, taskOf: (id) => (id === 's3' ? task : null), show: (x) => shown.push(x), wait })
    on({ id: 's3' }, owner('Rename the eight files so each starts with done-.'))
    on({ id: 's3' }, call('screen_act'))
    on({ id: 's3' }, { type: 'turn/end', seq: 4, time: T + 9_000, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    await flush()
    await flush()
    const line = 'Stopped, as you asked. Done before the stop (2 steps): rename "ember.txt" in Finder; rename "fennel.txt" in Finder. Nothing after that ran.'
    expect(waits).toHaveLength(2)
    expect(appendSignal.mock.calls.at(-1)).toEqual(['chat:said', { sessionId: 's3', turnId: 'u1', text: line, chars: line.length, tools: ['screen_act'], stopped: true }, '2026-09-29T12:02:19.000Z'])
    expect(shown).toEqual([{ sessionId: 's3', line }])
    // Stopped before any step, with words already said and a refusal: both in the answer.
    const quiet = vi.fn(async () => {})
    const none = createRouteLog({ appendSignal: quiet, log: () => {}, taskOf: () => ({ did: [], failed: ['press "Send" in Zen: refused, covered'] }), wait: async () => {} })
    none({ id: 's4' }, owner('Send it.'))
    none({ id: 's4' }, say('I will send it in Zen.'))
    none({ id: 's4' }, { type: 'turn/end', seq: 4, time: T + 9_000, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    await flush()
    expect(quiet.mock.calls.at(-1)[1].text).toBe('I will send it in Zen.\n\nStopped, as you asked, before any step was done. Refused before it: press "Send" in Zen: refused, covered. Nothing after that ran.')
    // A turn that ended any other way is recorded as before: nothing when it said nothing.
    const other = vi.fn(async () => {})
    const off = createRouteLog({ appendSignal: other, log: () => {}, taskOf: () => task, wait: async () => {} })
    off({ id: 's5' }, owner('ok'))
    off({ id: 's5' }, { type: 'turn/end', seq: 4, time: T + 9_000, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'error' } } } })
    await flush()
    expect(other.mock.calls.map((c) => c[0])).toEqual(['chat:owner'])
  })

  it('a turn that said nothing records only the owner', async () => {
    const { appendSignal, on } = setup()
    on({ id: 's2' }, owner('ok'))
    on({ id: 's2' }, call('gnomon_signals'))
    on({ id: 's2' }, end())
    await flush()
    expect(appendSignal.mock.calls.map((c) => c[0])).toEqual(['chat:owner'])
  })

  it('a turn the cap or the silent stall ended answers with that line (run 250 T04); another failure with no word stays unanswered', async () => {
    const { appendSignal, on } = setup()
    const failed = (code) => ({ type: 'turn/end', seq: 4, time: T + 9_000, data: { turn: 1, reason: { kind: 'error', error: { message: 'x', code } } } })
    on({ id: 's2' }, owner('ok'))
    on({ id: 's2' }, call('gnomon_skill'))
    on({ id: 's2' }, failed(SILENT_CODE))
    on({ id: 's3' }, owner('ok', 'u2'))
    on({ id: 's3' }, failed('TRANSPORT'))
    await flush()
    expect(appendSignal.mock.calls.filter((c) => c[0] === 'chat:said')).toEqual([
      ['chat:said', { sessionId: 's2', turnId: 'u1', text: SILENT_LINE, chars: SILENT_LINE.length, tools: ['gnomon_skill'] }, '2026-09-29T12:02:19.000Z'],
    ])
  })
})

describe('the answer row is the answer (run 250 T19, run 251 T19)', () => {
  const narrate = (text, name = 'screen_look') => ({ type: 'assistant/message', seq: 2, time: T + 2_000, data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool-call', id: 'c', name, arguments: '{}' }] } } })

  it('a line said with a tool call is narration: the row holds the lines said with none; a turn of narration only keeps it', async () => {
    const { appendSignal, on } = setup()
    on({ id: 's1' }, owner('put Kestrel in the notes'))
    on({ id: 's1' }, narrate('Now set the filename field and save.'))
    on({ id: 's1' }, call('screen_look'))
    on({ id: 's1' }, say('The copy is saved in Testbox.'))
    on({ id: 's1' }, end())
    on({ id: 's2' }, owner('look', 'u2'))
    on({ id: 's2' }, narrate('Looking at Finder.'))
    on({ id: 's2' }, end())
    await flush()
    expect(appendSignal.mock.calls.filter((c) => c[0] === 'chat:said').map((c) => c[1].text)).toEqual(['The copy is saved in Testbox.', 'Looking at Finder.'])
  })

  it('a lone cursor from a stopped stream is no word', async () => {
    const appendSignal = vi.fn(async () => {})
    const on = createRouteLog({ appendSignal, log: () => {}, taskOf: () => ({ did: [], failed: [] }), wait: async () => {} })
    on({ id: 's3' }, owner('add Kestrel'))
    on({ id: 's3' }, say('█'))
    on({ id: 's3' }, { type: 'turn/end', seq: 4, time: T + 9_000, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    await flush()
    await flush()
    expect(appendSignal.mock.calls.at(-1)[1].text).toBe('Stopped, as you asked, before any step was done. Nothing after that ran.')
  })
})

describe('the stop line counts a rename whose new name went in (run 253 T18)', () => {
  const row = (type, data) => ({ signalType: type.split(':')[0], eventType: type.split(':')[1], data })
  const asked = (id, session = 's3') => row('screen:asked', { id, session })
  const acted = (id, outcome, more = {}) => row('screen:acted', { id, outcome, ...more })
  const step = (name, ok, more = {}) => row('screen:step', { session: 's3', verb: 'rename', screenText: [name], ok, ...more })
  // fennel done; garnet: click, Return, set-value (replaced the name), then the Return the Stop's click refused, then Escape.
  const rename = (name, last, reason) => [asked(`${name}-1`), acted(`${name}-1`, 'performed'), asked(`${name}-2`), acted(`${name}-2`, 'performed'), asked(`${name}-3`), acted(`${name}-3`, 'performed', { replacedChars: 10 }), asked(`${name}-4`), acted(`${name}-4`, last, reason ? { reason } : {})]
  const rows = [
    ...rename('fennel', 'performed'), step('fennel.txt', true, { changed: true }),
    ...rename('garnet', 'refused', 'owner-moved'), asked('garnet-5'), acted('garnet-5', 'performed'), step('garnet.txt', false, { reason: 'owner-moved' }),
  ]
  const task = { did: ['rename "fennel.txt" in Finder'], failed: ['rename "garnet.txt" in Finder: refused, owner-moved'] }

  it('from the acts: performed set-value, then refused by the owner\'s hand, is done; refused before the name went in is not', async () => {
    const line = 'Stopped, as you asked. Done before the stop (2 steps): rename "fennel.txt" in Finder; rename "garnet.txt" in Finder (its new name went in as the stop came). Nothing after that ran.'
    const appendSignal = vi.fn(async () => {})
    const since = []
    const on = createRouteLog({ appendSignal, log: () => {}, taskOf: () => task, screenRows: async (at) => (since.push(at), rows), wait: async () => {} })
    on({ id: 's3' }, owner('Rename the eight files so each starts with done-.'))
    on({ id: 's3' }, { type: 'turn/end', seq: 4, time: T + 9_000, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    await flush()
    await flush()
    expect(since).toEqual(['2026-09-29T12:02:10.000Z'])
    expect(appendSignal.mock.calls.at(-1)[1].text).toBe(line)
    // Run 250: the Stop refused the Return that opens the box; no name went in. Another chat's acts never count.
    const early = [...rename('garnet', 'refused', 'owner-moved').slice(0, 4), asked('x', 's9'), acted('x', 'performed', { replacedChars: 9 }), step('garnet.txt', false, { reason: 'owner-moved' })]
    expect(stopLine(task, namesSet(early, 's3'))).toBe('Stopped, as you asked. Done before the stop (1 step): rename "fennel.txt" in Finder. Refused before it: rename "garnet.txt" in Finder: refused, owner-moved. Nothing after that ran.')
    // A rename refused for another reason (the folder read back) stays refused.
    expect(namesSet([...rename('garnet', 'performed'), step('garnet.txt', false, { reason: 'rename-not-seen' })], 's3')).toEqual([])
  })
})

describe('route prediction (J1.4b), retired (W5 step 8)', () => {
  it('an owner message makes no model call and records no prediction', async () => {
    const { appendSignal, on } = setup()
    on({ id: 's1' }, owner('what am I doing right now?'))
    await flush()
    expect(appendSignal.mock.calls.map((c) => c[0])).toEqual(['chat:owner'])
  })
})

describe('a claimed final with no act in its turn', () => {
  it('a reply claiming a final with no act in its turn goes on the record for self-review; one with its act, or a no, does not', async () => {
    const { appendSignal, on } = setup()
    const s = { id: 'session-7f', header: {} }
    on(s, owner('discard the draft to Mira', 'u2'))
    on(s, say('The draft was discarded.'))
    on(s, end())
    on(s, owner('and the other one', 'u3'))
    on(s, call('screen_act'))
    on(s, say('The draft was discarded.'))
    on(s, end())
    on(s, owner('send it', 'u4'))
    on(s, say('It was not sent: you said no.'))
    on(s, end())
    await flush()
    expect(appendSignal.mock.calls.filter((c) => c[0] === 'review:unbacked-claim')).toEqual([
      ['review:unbacked-claim', { sessionId: 'session-7f', turnId: 'u2', claim: 'discarded', tools: [] }, '2026-09-29T12:02:19.000Z'],
    ])
  })

  it('only a first-person claim of this turn counts, never a report about someone else or another day; a calendar act backs an invite', async () => {
    const { appendSignal, on } = setup()
    const s = { id: 'session-7f', header: {} }
    const turn = (id, text, tools = []) => {
      on(s, owner('and?', id))
      for (const t of tools) on(s, call(t))
      on(s, say(text))
      on(s, end())
    }
    turn('u1', 'Nothing was sent: the mail to Mira is still a draft.')
    turn('u2', 'The invite was sent by Mira Bakker this morning.')
    turn('u3', 'Your PR was submitted Monday and is waiting on review.')
    turn('u4', 'I sent the invite.', ['gnomon_calendar_create'])
    turn('u5', "I've deleted the old note.")
    turn('u6', 'Done. Sent to Mira.')
    await flush()
    expect(appendSignal.mock.calls.filter((c) => c[0] === 'review:unbacked-claim').map((c) => [c[1].turnId, c[1].claim])).toEqual([['u5', 'deleted'], ['u6', 'sent']])
  })
})
