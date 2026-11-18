// A rig test chat writes nothing to the owner's record (2026-11-15: 99 made-up facts filed by gnomon_assert), and a
// final refused in a turn stays refused (run 175: it asked again to send, and the task hung). Every value is made up.
import { describe, expect, it } from 'vitest'
import { callFacts, decideAction, refusedFinal } from './gate.js'
import { resolveActionPolicy } from '@sundial/helpers/sundial-config.js'

const actions = { internal: { default: 'auto', byTool: {} }, outward: { default: 'auto', byTool: {} } }
const decide = (toolName, args, more = {}) => decideAction({ toolName, args, preset: 'danger-full-access', actions, resolveActionPolicy, facts: callFacts({ toolName, args }), ...more })
const ASSERT = { entityKind: 'topic', canonicalName: 'kestrel', predicate: 'is', object: 'a test word', saidBy: 'owner' }

describe('a rig session writes nothing to the owner\'s record', () => {
  it('gnomon_assert in a rig chat is refused with one honest line; in the owner\'s chat it runs', () => {
    expect(decide('gnomon_assert', ASSERT, { rig: true })).toEqual({ kind: 'deny', reason: "This is a test chat; nothing is saved to the owner's record. Carry on without it." })
    expect(decide('gnomon_assert', ASSERT, { rig: false }).kind).toBe('allow')
  })

  it('every write that outlives the chat is fenced the same way; reads and screen acts are not', () => {
    for (const tool of ['gnomon_claim', 'gnomon_track_promise', 'gnomon_owner_answer', 'gnomon_ask_owner', 'gnomon_record_outcome', 'gnomon_propose', 'gnomon_draft', 'gnomon_start_job', 'gnomon_schedule_wakeup', 'gnomon_adopt_rule', 'gnomon_notice_feedback', 'gnomon_shelve'])
      expect(decide(tool, {}, { rig: true }).kind, tool).toBe('deny')
    for (const tool of ['gnomon_today', 'gnomon_await', 'web_page', 'todo_write']) expect(decide(tool, {}, { rig: true }).kind, tool).toBe('allow')
  })

  it('the board is fenced, and a question for the owner gets its own reason, not "nothing is saved"', () => {
    expect(decide('gnomon_board', { action: 'place', kind: 'note', text: 'kestrel' }, { rig: true })).toEqual({ kind: 'deny', reason: "This is a test chat; nothing is saved to the owner's record. Carry on without it." })
    expect(decide('gnomon_ask_owner', { question: 'Which project is box-484?' }, { rig: true })).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/a question is not put on the owner's record/) })
    expect(decide('gnomon_ask_owner', { question: 'Which project is box-484?' }, { rig: false }).kind).toBe('allow')
  })

  it('a lens placed on the board is fenced in a rig chat; its preview, and a place in the owner\'s chat, are not', () => {
    const lens = { source: { tool: 'gnomon_tickets' }, title: 'BOX tickets' }
    expect(decide('gnomon_lens', { ...lens, action: 'place' }, { rig: true })).toEqual({ kind: 'deny', reason: "This is a test chat; nothing is saved to the owner's record. Carry on without it." })
    expect(decide('gnomon_lens', { ...lens, action: 'preview' }, { rig: true }).kind).toBe('allow')
    expect(decide('gnomon_lens', { ...lens, action: 'place' }, { rig: false }).kind).toBe('allow')
  })

  it('a shell command that names the data folder, the database, the MCP server or the token is refused in a rig chat', () => {
    const rigWays = [
      'sqlite3 ~/.sundial/sundial.db "insert into signals (signal_type) values (\'entity\')"',
      'sqlite3 -readonly "$SUNDIAL_HOME/sundial.db" "select count(*) from entity_facts"',
      'echo \'{"method":"tools/call","params":{"name":"gnomon_assert"}}\' | node bin/sundial mcp',
      'sundial mcp < /tmp/gnomon-call.json',
      'node packages/mcp/dist/index.js < /tmp/gnomon-call.json',
      'cat ~/.sundial/config.json',
    ]
    for (const tool of ['bash', 'gnomon_run_shell'])
      for (const command of rigWays) expect(decide(tool, { command }, { rig: true }), `${tool}: ${command}`).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/^This is a test chat; a shell command that names Sundial's data folder/) })
    expect(decide('bash', { command: 'ls /tmp/gnomon-fixture' }, { rig: true }).kind).toBe('allow')
  })

  it('a shell write to the database is refused in every chat; a read-only open, a listing and the rest of the folder are not', () => {
    const writes = [
      'sqlite3 ~/.sundial/sundial.db "insert into signals (signal_type) values (\'entity\')"',
      'cd ~/.sundial && sqlite3 sundial.db < /tmp/gnomon-x.sql',
      'sqlite3 /tmp/gnomon-a.db "attach \'/Users/mira/.sundial/sundial.db\' as s; delete from s.signals"',
      'sqlite3 -readonly /tmp/gnomon-a.db "select 1"; sqlite3 ~/.sundial/sundial.db "delete from signals"',
      "python3 - <<'EOF'\nimport sqlite3; sqlite3.connect('/Users/mira/.sundial/sundial.db').execute('delete from signals')\nEOF",
      'echo x > ~/.sundial/sundial.db-wal',
    ]
    for (const command of writes) expect(decide('gnomon_run_shell', { command }, { rig: false }), command).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/opens Sundial's own database other than read-only/) })
    for (const command of ['sqlite3 -readonly ~/.sundial/sundial.db "select count(*) from signals"', 'ls -la ~/.sundial/sundial.db', 'echo \'{}\' > ~/.sundial/config.json', 'node bin/sundial status'])
      expect(decide('gnomon_run_shell', { command }, { rig: false }).kind, command).toBe('allow')
  })
})

describe('a no to a final is final for the rest of that turn', () => {
  const at = Date.parse('2026-11-15T09:00:00Z')
  const answer = (over = {}) => ({ id: 'approval-1', sessionId: 'session-mira', tool: 'screen_act', callId: 'c1', kind: 'send', line: null, at: '2026-11-15T09:00:10Z', answer: 'rejected', by: 'rig', answeredAt: '2026-11-15T09:00:12Z', ...over })
  const state = (...recent) => ({ approvals: { open: [], recent, decided: [] } })

  it('refusedFinal: a final refused in this session since the turn began, by the owner or the rig; not a yes, a timeout, a plain ask or an earlier turn', () => {
    expect(refusedFinal(state(answer()), 'session-mira', at)).toBe('send')
    expect(refusedFinal(state(answer({ by: 'owner', kind: 'discard' })), 'session-mira', at)).toBe('discard')
    for (const over of [{ answer: 'allowed-once' }, { by: 'timeout' }, { kind: 'plain' }, { sessionId: 'session-bob' }, { answeredAt: '2026-11-15T08:59:00Z' }])
      expect(refusedFinal(state(answer(over)), 'session-mira', at), JSON.stringify(over)).toBeNull()
    expect(refusedFinal(state(answer()), 'session-mira', null)).toBeNull()
  })

  it('after the no, the same final is refused; a question (save it as a draft instead?) and another kind of act still go to the gate', () => {
    const send = { app: 'Zen', role: 'button', label: 'Send' }
    expect(decide('ask_user_question', { questions: [{ question: 'Save it as a draft instead?' }] }, { refused: 'send' }).kind).toBe('allow')
    expect(decide('gnomon_ask_owner', { question: 'Save it as a draft instead?' }, { refused: 'send' }).kind).toBe('allow')
    expect(decide('screen_act', send, { refused: 'send' })).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/The send was refused in this turn, and a no is final/) })
    expect(decide('screen_act', send).kind).toBe('ask')
    expect(decide('screen_act', { app: 'TextEdit', role: 'button', label: "Don't Save" }, { refused: 'send' }).kind).toBe('ask')
  })
  it('the same act under another kind: a refused final-unknown matches any final, and discard and delete are one', () => {
    const send = { app: 'Zen', role: 'button', label: 'Send' }
    const trash = { app: 'Finder', role: 'button', label: 'Move to Trash' }
    const dontSave = { app: 'TextEdit', role: 'button', label: "Don't Save" }
    expect(decide('screen_act', send, { refused: 'final-unknown' }).kind).toBe('deny')
    expect(decide('screen_act', trash, { refused: 'discard' }).kind).toBe('deny')
    expect(decide('screen_act', dontSave, { refused: 'delete' }).kind).toBe('deny')
    expect(decide('screen_act', trash, { refused: 'send' }).kind).toBe('ask')
  })
})
