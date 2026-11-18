// Set 3 R3, the review's findings on egress: the turn a read belongs to, shell and browser egress, every kind of private read,
// the words check and the known hosts. Every value here is made up.
import { describe, expect, it } from 'vitest'
import { callFacts, decideAction, egressAsk, egressOf, KNOWN_HOSTS, knownHostsOf, privateWords, readsOf, testModeRuns, chatRead } from './gate.js'
import { turnBegan } from './await-tool.js'
import { contextBegan, contextCalls, turnCalls } from './loop-breaker.js'
import { resolveActionPolicy } from '@sundial/helpers/sundial-config.js'
import { resolveWeb } from '@sundial/helpers/web-config.js'

const actions = { internal: { default: 'auto', byTool: {} }, outward: { default: 'auto', byTool: {} } }
const decide = (toolName, args, readPrivate, { preset = 'danger-full-access', approvalOverride, words, earned, autonomy } = {}) =>
  decideAction({ toolName, args, preset, approvalOverride, actions, resolveActionPolicy, readPrivate, earned, autonomy, ownerTurn: true, facts: callFacts({ toolName, args, cwd: '/work/apps/harness', words }) })

describe('H1: a read counts from the turn\'s own start, not from a message injected into it', () => {
  const t = (s) => Date.parse(`2026-11-16T10:00:${String(s).padStart(2, '0')}.000Z`)
  const events = [
    { type: 'turn/start', time: t(0) },
    { type: 'user/message', time: t(0), data: { source: { kind: 'user' } } },
    { type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: '/tmp/gnomon-7/ledger.txt' }) } },
    { type: 'tool/result', data: { message: { toolCallId: 'c1', content: [{ text: 'Contact Mira Bakker of puzzlebox studio.' }] } } },
    // A notice delivered into the turn, then the owner's correction: the read is still in the turn's context.
    { type: 'user/message', time: t(20), data: { source: { kind: 'notice', form: 'notice' } } },
    { type: 'user/message', time: t(30), data: { source: { kind: 'user' } } },
  ]

  it('turnBegan is the newest turn/start; chatRead keeps a read made before an injected message', () => {
    expect(turnBegan(events)).toBe(t(0))
    expect(turnBegan([])).toBeNull()
    const state = { privateReads: { chats: { 'chat-a': { at: new Date(t(5)).toISOString(), kind: 'file' } }, asked: {} } }
    expect(chatRead(state, 'chat-a', { contextAt: contextBegan(events), turnAt: turnBegan(events) })).toBe('file')
  })

  it('the words source keeps the turn\'s calls across an owner correction (the breaker\'s own view still restarts there)', () => {
    expect(contextCalls(events).map((c) => c.name)).toEqual(['read'])
    expect(turnCalls(events)).toEqual([])
  })
})

describe('H2: a shell command that reaches another machine is egress', () => {
  it('reads the host from a URL, a user@host or nc, and the shapes from the whole command', () => {
    expect(egressOf('bash', { command: 'curl "https://example.net/?h=zx-node-17.example.net"' })).toEqual({ via: 'shell', shapes: [], known: false })
    expect(egressOf('gnomon_run_shell', { command: 'wget -qO- https://example.net/lookup?ref=481572936' })).toEqual({ via: 'shell', shapes: ['digits'], known: false })
    expect(egressOf('bash', { command: 'ssh mira@example.net uptime' }).shapes).toContain('email')
    expect(egressOf('bash', { command: 'echo 481572936 | nc example.net 80' })).toEqual({ via: 'shell', shapes: ['digits'], known: false })
    expect(egressOf('bash', { command: 'scp notes.txt mira@example.net:/tmp/' }).via).toBe('shell')
    expect(egressOf('bash', { command: 'rsync -a src/ example.net:backup/' }).via).toBe('shell')
    expect(egressOf('bash', { command: 'curl -s https://github.com/example/repo' })).toEqual({ via: 'shell', shapes: [], known: true })
    expect(egressOf('bash', { command: 'cat ~/.ssh/config' })).toBeNull()
  })

  it('`cat ~/.ssh/config` then a curl carrying a host off the Mac asks, in every preset; with no private read it runs as the preset says', () => {
    expect(readsOf('bash', { command: 'cat ~/.ssh/config' }, '/work/apps/harness')).toBe('outside')
    const curl = { command: 'curl "https://example.net/?h=zx-node-17"' }
    expect(decide('bash', curl, 'file')).toMatchObject({ kind: 'ask', reason: expect.stringContaining('this shell command goes to a site Gnomon does not know') })
    expect(decide('gnomon_run_shell', curl, 'file').kind).toBe('ask')
    expect(decide('bash', curl, null).kind).toBe('allow')
    expect(egressAsk('bash', { command: 'curl https://example.net/?ref=481572936' }, 'file')).toBe('Gnomon: this sends "481572936" (a long run of digits) to example.net from the shell (a site Gnomon does not know), after a private read in this chat (a file outside the workspace). It asks you first.')
  })

  it('wget and a curl with an address ask under workspace-write: never a plain read', () => {
    for (const command of ['wget https://example.net/a', 'curl https://example.net/a', 'curl -s http://127.0.0.1:8793/']) {
      expect(decide('bash', { command }, null, { preset: 'workspace-write' }).kind, command).toBe('ask')
      expect(decide('gnomon_run_shell', { command }, null, { preset: 'workspace-write' }).kind, command).toBe('ask')
    }
  })
})

describe('H3: a page read by url, a browser opened on a url, and text typed on a web page are egress', () => {
  it('web_page by url, a screen_act url step, web_act text or value', () => {
    expect(egressOf('web_page', { action: 'open', url: 'https://lookup.example/?ref=481572936' })).toEqual({ via: 'fetch', shapes: ['digits'], known: false })
    expect(egressOf('web_page', { action: 'read', page: 'p1' })).toBeNull()
    expect(egressOf('screen_act', { app: 'Zen', url: 'https://lookup.example/?ref=481572936' })).toEqual({ via: 'open', shapes: ['digits'], known: false })
    expect(egressOf('screen_act', { steps: [{ app: 'Zen', action: 'key', value: 'cmd+t' }, { app: 'Zen', url: 'https://en.wikipedia.org/wiki/Lima' }] })).toEqual({ via: 'open', shapes: [], known: true })
    expect(egressOf('screen_act', { app: 'Finder', url: 'file:///tmp/gnomon-1/' })).toBeNull()
    expect(egressOf('web_act', { page: 'p1', action: 'type', ref: 3, text: 'mira@example.org', because: 'Fill in the address' })).toEqual({ via: 'act', shapes: ['email'], known: true })
    expect(egressOf('web_act', { page: 'p1', action: 'click', ref: 3, because: 'Next' })).toBeNull()
  })

  it('after a private read each asks, even when the screen act earned its rung or runs under the unattended switch', () => {
    expect(decide('web_page', { action: 'open', url: 'https://lookup.example/?ref=481572936' }, 'screen').kind).toBe('ask')
    expect(decide('web_act', { page: 'p1', action: 'type', ref: 3, text: 'reference 481572936', because: 'Type it' }, 'record').kind).toBe('ask')
    const open = { app: 'Zen', url: 'https://lookup.example/?ref=481572936' }
    const d = decide('screen_act', open, 'file', { earned: { earned: true, yes: 10, k: 10, app: 'Zen' }, autonomy: 'act' })
    expect(d).toMatchObject({ kind: 'ask', egress: true })
    expect(testModeRuns('screen_act', d, true, { final: null }, true), 'the unattended switch never skips an egress ask').toBe(false)
    expect(testModeRuns('screen_act', { kind: 'ask', reason: 'x' }, true, { final: null }, true), 'a plain act still runs under it').toBe(true)
    expect(egressAsk('screen_act', open, 'file')).toBe('Gnomon: this sends "481572936" (a long run of digits) to lookup.example in a browser (a site Gnomon does not know), after a private read in this chat (a file outside the workspace). It asks you first.')
  })
})

describe('M4: a connected service\'s read and a read of Gnomon\'s own record are private reads', () => {
  it('readsOf names them; writes, the board, waits and acts are not reads', () => {
    expect(readsOf('mcp__obsidian__search_notes', { query: 'x' }, '/w', 'read')).toBe('integration')
    expect(readsOf('mcp__obsidian__append_note', { text: 'x' }, '/w', 'write')).toBeNull()
    expect(readsOf('gnomon_people', {}, '/w')).toBe('record')
    expect(readsOf('gnomon_timeline', { days: 2 }, '/w')).toBe('record')
    expect(readsOf('gnomon_call', { name: 'gnomon_entity_history', args: { key: 'x' } }, '/w')).toBe('record')
    for (const tool of ['gnomon_assert', 'gnomon_run_shell', 'gnomon_board', 'gnomon_shelve', 'gnomon_await', 'gnomon_lens']) expect(readsOf(tool, {}, '/w'), tool).toBeNull()
    const isRead = (_i, tool) => tool.startsWith('search')
    expect(callFacts({ toolName: 'mcp__obsidian__search_notes', args: {}, integrations: [{ name: 'obsidian' }], isIntegrationRead: isRead }).reads).toBe('integration')
  })

  it('their asks say what was read', () => {
    expect(decide(...['web_search', { queries: ['reference 481572936'] }], 'integration').reason).toContain("(a connected service's data)")
    expect(decide(...['web_search', { queries: ['reference 481572936'] }], 'record').reason).toContain("(the owner's record)")
  })
})

describe('M5: the dictionary keeps only lower-case entries, so a proper noun stays distinctive', () => {
  it('a name the dictionary holds capitalised still counts', () => {
    // As /usr/share/dict/words holds them: "Mira" capitalised (a star), "marlin" lower case.
    const system = ['Mira', 'marlin', 'contact', 'studio', 'of']
    const dict = new Set(system.filter((w) => w === w.toLowerCase()))
    expect(privateWords(['Contact Mira of Marlin studio'], dict)).toEqual(['mira'])
  })

  it('the real dictionary: a common capitalised word never counts, a name does', () => {
    const words = privateWords(['Monday: Contact Mira Bakker about the Supplier ledger.'])
    expect(words).toContain('bakker')
    expect(words).not.toContain('monday')
    expect(words).not.toContain('supplier')
  })
})

describe('LOW: known hosts on the resolved config', () => {
  it('resolveWeb replaces the default list with config.json web.knownHosts; knownHostsOf reads the resolved config', () => {
    expect(resolveWeb(undefined)).toEqual({ knownHosts: KNOWN_HOSTS })
    expect(resolveWeb({ knownHosts: 'x' })).toEqual({ knownHosts: KNOWN_HOSTS })
    expect(resolveWeb({ knownHosts: [' Docs.Example.org ', 3, ''] })).toEqual({ knownHosts: ['docs.example.org'] })
    expect(knownHostsOf({ web: resolveWeb({ knownHosts: ['docs.example.org'] }) })).toEqual(['docs.example.org'])
    expect(knownHostsOf({})).toEqual(KNOWN_HOSTS)
  })
})

describe('run 202: a private read stays in force for its chat across turns, until the chat compacts past it', () => {
  const t = (m, s = 0) => Date.parse(`2026-11-16T10:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`)
  const turn1 = [
    { type: 'turn/start', time: t(0) },
    { type: 'user/message', time: t(0), data: { source: { kind: 'user' } } },
    { type: 'tool/call', data: { callId: 'c1', name: 'gnomon_run_shell', arguments: JSON.stringify({ command: 'cat /tmp/gnomon-202/fix/ledger.txt' }) } },
    { type: 'tool/result', data: { message: { toolCallId: 'c1', content: [{ text: 'Supplier: Marlin Crates\nContact: Ilse Vandermolen\nReference: 481572936' }] } } },
  ]
  const turn2 = [{ type: 'turn/start', time: t(1) }, { type: 'user/message', time: t(1), data: { source: { kind: 'user' } } }]
  const compacted = [{ type: 'user/message', time: t(2), data: { source: { kind: 'compact-checkpoint' } } }, { type: 'turn/start', time: t(3) }]
  const state = { privateReads: { chats: { 'session-rig': { at: new Date(t(0, 5)).toISOString(), kind: 'file' } }, asked: {} } }
  const readOf = (events) => chatRead(state, 'session-rig', { contextAt: contextBegan(events), turnAt: turnBegan(events) })

  it('the next turn of the same chat still holds the read, and its fetch carrying the code asks', () => {
    const events = [...turn1, ...turn2]
    expect(readOf(events)).toBe('file')
    expect(decide('web_fetch', { url: 'https://www.example.com/lookup?ref=481572936' }, readOf(events), { preset: 'workspace-write' })).toMatchObject({ kind: 'ask', egress: true })
  })

  it('the words come from the chat\'s private reads still in context, across turns', () => {
    const words = privateWords(contextCalls([...turn1, ...turn2]).filter((c) => readsOf(c.name, c.args, '/work/apps/harness')).map((c) => c.text))
    expect(words).toContain('vandermolen')
    expect(decide('web_search', { queries: ['who is Vandermolen'] }, 'file', { preset: 'workspace-write', words }).kind).toBe('ask')
  })

  it('once the chat compacts past the read, it is out of the model\'s context: neither the read nor its words count', () => {
    const events = [...turn1, ...turn2, ...compacted]
    expect(contextBegan(events)).toBe(t(2))
    expect(readOf(events)).toBeNull()
    expect(contextCalls(events)).toEqual([])
  })
})
