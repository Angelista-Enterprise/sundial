// Set 3 R3: what Gnomon read in private does not leave the Mac in a web query without asking. Every value here is made up.
import { describe, expect, it } from 'vitest'
import { callFacts, decideAction, decisionRecord, egressAsk, egressOf, KNOWN_HOSTS, knownHostsOf, privateWords, readsOf, chatRead } from './gate.js'
import { resolveActionPolicy } from '@sundial/helpers/sundial-config.js'

const actions = { internal: { default: 'auto', byTool: {} }, outward: { default: 'auto', byTool: {} } }
const decide = (toolName, args, readPrivate, { preset = 'workspace-write', approvalOverride } = {}) =>
  decideAction({ toolName, args, preset, approvalOverride, actions, resolveActionPolicy, readPrivate, facts: callFacts({ toolName, args, cwd: '/work/apps/harness' }) })

const search = (q) => ['web_search', { queries: [q] }]
const fetch = (url) => ['web_fetch', { url }]
/** A data shape in the query or the address, per kind. */
const SHAPED = {
  email: search('who is mira@example.org'),
  phone: search('whose number is +31 6 1234 5678'),
  digits: search('reference 481572936'),
  grouped: search('account 4821 5532 1190'),
  alias: search('person-3fa9c2e1 profile'),
  iban: search('NL91ABNA0417164300 bank'),
  home: fetch('https://example.com/upload?f=/Users/mira/notes.txt'),
  token: fetch('https://example.com/check?key=EXAMPLE_TOKEN_PLACEHOLDER'),
}
const PLAIN = [search('capital of Peru'), search('events on 2026-11-15 in Utrecht'), fetch('https://en.wikipedia.org/wiki/Lima'), fetch('https://github.com/example/repo/issues/12')]

describe('the egress cells: private read yes or no, query shape yes or no, host known or not', () => {
  it('with no private read in the turn, nothing asks: shaped, plain, known host or not', () => {
    for (const [tool, args] of [...Object.values(SHAPED), ...PLAIN, fetch('https://unknown.example/page')]) expect(decide(tool, args, null), JSON.stringify(args)).toEqual({ kind: 'allow' })
  })

  it('after a private read, a data shape asks, in a search and a fetch, whatever the host', () => {
    for (const kind of ['file', 'screen']) {
      for (const [name, [tool, args]] of Object.entries(SHAPED)) {
        const d = decide(tool, args, kind)
        expect(d.kind, `${kind} ${name}`).toBe('ask')
        expect(d.reason).toMatch(/^Gnomon: this web (search|fetch) carries text shaped like private data \(.+\) after a private read in this chat \(.+\)\. It asks you first\.$/)
      }
      expect(decide(...fetch('https://en.wikipedia.org/wiki/481572936'), kind).kind, 'a known host with a shape').toBe('ask')
    }
  })

  it('after a private read, an unknown host asks, a known host or a plain search does not', () => {
    expect(decide(...fetch('https://unknown.example/page'), 'file')).toMatchObject({ kind: 'ask', reason: expect.stringContaining('goes to a site Gnomon does not know') })
    expect(decide(...fetch('not a url'), 'file').kind).toBe('ask')
    for (const [tool, args] of PLAIN) expect(decide(tool, args, 'file'), JSON.stringify(args)).toEqual({ kind: 'allow' })
  })

  it('never allows a data shape after a private read: in a job nobody can answer it is refused, a deny stays a deny', () => {
    expect(decide(...SHAPED.digits, 'file', { approvalOverride: 'never' })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('nobody can be asked here') })
    expect(decide(...SHAPED.digits, 'file', { preset: 'danger-full-access' }).kind).toBe('ask')
  })

  it('touches no other tool: a read, a shell command and a screen act decide as before', () => {
    expect(decide('read', { file_path: '/tmp/gnomon-1/a.txt' }, 'file')).toEqual({ kind: 'allow' })
    expect(decide('bash', { command: 'cat /tmp/gnomon-1/a.txt' }, 'file')).toEqual(decide('bash', { command: 'cat /tmp/gnomon-1/a.txt' }, null))
    expect(egressOf('bash', { command: 'cat /tmp/gnomon-1/a.txt' })).toBeNull()
  })
})

describe('the facts and the ask', () => {
  it('the record holds the shapes and whether the host is known, never the query or the address', () => {
    expect(egressOf(...SHAPED.digits)).toEqual({ via: 'search', shapes: ['digits'], known: true })
    expect(egressOf(...fetch('https://unknown.example/a?q=mira@example.org'))).toEqual({ via: 'fetch', shapes: ['email'], known: false })
    expect(egressOf('web_search', { query: 'reference 481572936' }).shapes).toEqual(['digits'])
    const row = decisionRecord({ name: 'web_search' }, { readPrivate: 'file', facts: callFacts({ toolName: 'web_search', args: { queries: ['reference 481572936'] } }) }, decide(...SHAPED.digits, 'file'))
    expect(JSON.stringify(row)).not.toContain('481572936')
  })

  it('a read outside the workspace is a private read; inside it, or no path, is not', () => {
    const cwd = '/work/apps/harness'
    expect(readsOf('read', { file_path: '/tmp/gnomon-7/private/ledger.txt' }, cwd)).toBe('outside')
    expect(readsOf('read', { file_path: '~/notes.txt' }, cwd)).toBe('outside')
    expect(readsOf('read', { file_path: '../../secrets.txt' }, cwd)).toBe('outside')
    expect(readsOf('grep', { pattern: 'x', path: '/Users/mira/Documents' }, cwd)).toBe('outside')
    expect(readsOf('bash', { command: 'cat /tmp/gnomon-7/private/ledger.txt' }, cwd)).toBe('outside')
    expect(readsOf('gnomon_run_shell', { command: 'head -5 ~/Documents/plan.md' }, cwd)).toBe('outside')
    for (const [tool, args] of [['read', { file_path: 'src/index.js' }], ['read', { file_path: '/work/apps/harness/package.json' }], ['grep', { pattern: 'x' }], ['bash', { command: 'git log -3' }], ['bash', { command: 'ls src' }], ['web_search', { queries: ['/tmp/x'] }]]) expect(readsOf(tool, args, cwd), JSON.stringify(args)).toBeNull()
    expect(callFacts({ toolName: 'read', args: { file_path: '/tmp/gnomon-7/a.txt' }, cwd }).reads).toBe('outside')
    expect(callFacts({ toolName: 'read', args: { file_path: 'a.txt' }, cwd })).not.toHaveProperty('reads')
  })

  it('run 202: a chat holds its private read across turns until it compacts past it; a look no chat asked for only in its turn; never another chat\'s', () => {
    const t = (s) => Date.parse(`2026-11-15T10:${s}.000Z`)
    const state = { privateReads: { chats: { 'chat-a': { at: '2026-11-15T10:00:05.000Z', kind: 'file' } }, asked: {} } }
    expect(chatRead(state, 'chat-a', { contextAt: 0, turnAt: t('01:00') }), 'the next turn of the same chat').toBe('file')
    expect(chatRead(state, 'chat-a', { contextAt: t('00:00'), turnAt: t('09:00') }), 'compacted before the read').toBe('file')
    expect(chatRead(state, 'chat-a', { contextAt: t('02:00'), turnAt: t('09:00') }), 'compacted past the read').toBeNull()
    expect(chatRead(state, 'chat-b', {}), "another chat's read").toBeNull()
    const look = { privateReads: { chats: { '': { at: '2026-11-15T10:00:05.000Z', kind: 'screen' } }, asked: {} } }
    expect(chatRead(look, 'chat-b', { turnAt: t('00:00') }), 'a look no chat asked for, in its turn').toBe('screen')
    expect(chatRead(look, 'chat-b', { turnAt: t('01:00') }), 'not in a later turn').toBeNull()
    expect(chatRead({}, 'chat-a', {})).toBeNull()
  })

  it('the owner reads one sentence: what is sent, the shape, to where, after what read', () => {
    expect(egressAsk(...SHAPED.digits, 'file')).toBe('Gnomon: this sends "481572936" (a long run of digits) to the search engines in a web search, after a private read in this chat (a file outside the workspace). It asks you first.')
    expect(egressAsk(...fetch('https://lookup.example/find?n=%2B31%206%201234%205678'), 'screen')).toBe('Gnomon: this sends "+31 6 1234 5678" (a phone number) to lookup.example in a web fetch (a site Gnomon does not know), after a private read in this chat (the screen\'s text). It asks you first.')
    expect(egressAsk(...fetch('https://unknown.example/page'), 'file')).toBe('Gnomon: this sends "/page" to unknown.example in a web fetch (a site Gnomon does not know), after a private read in this chat (a file outside the workspace). It asks you first.')
    expect(egressAsk('read', { file_path: '/tmp/a' }, 'file')).toBeNull()
  })

  it('the slip (Round 1 askOf) reads it as one line naming what is sent and where, never "Gnomon wants to use"', async () => {
    const { askOf } = await import('../sundial-theme/shell/slip-read.js')
    const [tool, args] = SHAPED.digits
    const read = askOf(args, tool, egressAsk(tool, args, 'file'))
    expect(read.line).toBe('This sends "481572936" (a long run of digits) to the search engines in a web search, after a private read in this chat (a file outside the workspace). It asks you first.')
    expect(read.kind).toBe('Asks first')
  })
})

describe('Set 3 R3 gaps', () => {
  // A made-up dictionary: the common words of these tests, as the system one holds them.
  const DICT = new Set(['supplier', 'reference', 'ledger', 'crate', 'marlin', 'monday', 'order', 'samples', 'the', 'and', 'page', 'capital', 'peru', 'weather', 'tomorrow', 'notes', 'meeting', 'contact', 'studio', 'about', 'from'])

  it('the distinctive words of a private read: names and long rare words, never a common word', () => {
    expect(privateWords(['Supplier: Marlin Crates', 'Reference: 481572936', 'Contact Mira Bakker of puzzlebox studio about the ledger.'], DICT)).toEqual(['mira', 'bakker', 'puzzlebox'])
    expect(privateWords(['Monday: order the samples. Notes from the meeting.'], DICT)).toEqual([])
    expect(privateWords([Array.from({ length: 60 }, (_, i) => `Zorb${'abcdefghij'[i % 10]}${'klmnopqrst'[Math.floor(i / 10)]}`).join(' ')], DICT)).toHaveLength(40)
    expect(privateWords(['Mira Bakker'], new Set()), 'no dictionary: no words').toEqual([])
  })

  it('after a private file read, a query that carries a word from it asks; one that does not stays plain', () => {
    const words = privateWords(['Contact Mira Bakker of puzzlebox studio.'], DICT)
    const decideWith = (args) => decideAction({ toolName: 'web_search', args, preset: 'workspace-write', actions, resolveActionPolicy, readPrivate: 'file', facts: callFacts({ toolName: 'web_search', args, words }) })
    expect(egressOf('web_search', { queries: ['who is Bakker'] }, { words }).shapes).toEqual(['read'])
    expect(decideWith({ queries: ['puzzlebox studio reviews'] })).toMatchObject({ kind: 'ask', reason: expect.stringContaining('a word from the private read') })
    expect(decideWith({ queries: ['weather in Peru tomorrow'] })).toEqual({ kind: 'allow' })
    expect(decideWith({ queries: ['bakkerij near me'] }), 'a whole word only').toEqual({ kind: 'allow' })
    expect(egressAsk('web_search', { queries: ['who is Mira Bakker'] }, 'file', { words })).toBe('Gnomon: this sends "mira" (a word from the private read) to the search engines in a web search, after a private read in this chat (a file outside the workspace). It asks you first.')
    // The record keeps the shape id, never the word.
    expect(JSON.stringify(callFacts({ toolName: 'web_search', args: { queries: ['who is Bakker'] }, words }).egress)).not.toMatch(/bakker/i)
  })

  it('known hosts come from config.json web.knownHosts when it names them; the default list is unchanged', () => {
    expect(knownHostsOf({})).toEqual(KNOWN_HOSTS)
    expect(knownHostsOf({ web: { knownHosts: 'x' } })).toEqual(KNOWN_HOSTS)
    expect(knownHostsOf({ web: { knownHosts: ['docs.example.org'] } })).toEqual(['docs.example.org'])
    const hosts = knownHostsOf({ web: { knownHosts: ['docs.example.org'] } })
    expect(egressOf('web_fetch', { url: 'https://api.docs.example.org/x' }, { hosts }).known).toBe(true)
    expect(egressOf('web_fetch', { url: 'https://en.wikipedia.org/wiki/Lima' }, { hosts }).known, 'replaced, not added to').toBe(false)
    expect(KNOWN_HOSTS).toContain('wikipedia.org')
  })

  it('an action:decided row names the chat it was decided in, so a private read is filed under that chat', () => {
    expect(decisionRecord({ name: 'read', agent: { session: { id: 'chat-a' } } }, { facts: {} }, { kind: 'allow' })).toMatchObject({ sessionId: 'chat-a' })
    expect(decisionRecord({ name: 'read' }, { facts: {} }, { kind: 'allow' })).not.toHaveProperty('sessionId')
  })
})
