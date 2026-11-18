// Set 2 Round 2: a plain shell read asks nothing under workspace-write, and only for a file or folder under /tmp/gnomon*;
// every other command asks as before, and the destructive, private-data, own-secret and sleep guards still come first.
// gate-reads.probes.jsonl is the review's probe list (2026-11-15): every one read something with no ask, none may now.
// Every path and name is made up.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { callFacts, decideAction, decisionRecord, PLAIN_READ, plainRead } from './gate.js'
import { runShellTool } from './run-shell.js'
import { resolveActionPolicy } from '@sundial/helpers/sundial-config.js'

const actions = (runShell = 'auto') => ({ internal: { default: 'auto', byTool: {} }, outward: { default: 'auto', byTool: { run_shell: runShell } } })
const decide = (command, over = {}) => decideAction({ toolName: 'gnomon_run_shell', args: { command }, preset: 'workspace-write', actions: actions(), resolveActionPolicy, ...over })

const READS = [
  'cat /tmp/gnomon-run1/job.log',
  'tail -n 1 /tmp/gnomon-run1/job.log',
  'wc -l /tmp/gnomon-run1/job.log',
  'ls /tmp/gnomon-run1',
  'ls -la /private/tmp/gnomon-run1/',
  'head -n 20 /tmp/gnomon-run1/notes.md',
  'head -5 /tmp/gnomon-run1/notes.md',
  'tail -n +2 /tmp/gnomon-run1/rows.csv',
  'cat /tmp/gnomon-count-run160.txt',
  'cat "/tmp/gnomon-run1/Gnomon job run160.md"',
  'cat /TMP/Gnomon-Run1/job.log',
  'cat /System/Volumes/Data/private/tmp/gnomon-run1/job.log',
  'cat /tmp/./gnomon-run1//job.log',
  'find /tmp/gnomon-run1 -name x',
  'find /tmp/gnomon-run1 -type f -name "*.log" -maxdepth 2',
  'find /tmp/gnomon-run1 -newer /tmp/gnomon-run1/start -print',
  'grep -rn "BOX-484" /tmp/gnomon-run1/src',
  'grep -c todo /tmp/gnomon-run1/notes.md',
  'grep -e foo -A 2 /tmp/gnomon-run1/notes.md',
  'cat /tmp/gnomon-run1/a.txt; wc -l /tmp/gnomon-run1/a.txt',
  'ls -a /tmp/gnomon-run1 | head -30',
  'grep -c todo /tmp/gnomon-run1/notes.md && tail -n 3 /tmp/gnomon-run1/notes.md',
  'find /tmp/gnomon-run1 -name "*.log" 2>/dev/null | wc -l',
  'cat /tmp/gnomon-run1/notes.md 2>&1 | head -5',
]

const ASKS = {
  'a file outside /tmp/gnomon*': 'cat ~/Documents/Q42/note.md',
  'a relative path': 'cat notes.md',
  'the rest of /tmp': 'cat /tmp/other-tool/session.json',
  'another session folder under /private/tmp': 'ls /private/tmp/claude-1/tasks',
  '/tmp itself': 'ls /tmp',
  'a variable': 'cat "$HOME/Documents/Q42/note.md"',
  'a dot-dot segment': 'cat /tmp/gnomon-run1/../../Users/mira/.zshrc',
  '~user': 'cat ~mira/.ssh/config',
  'a glob': 'cat /tmp/gnomon-run1/*.log',
  'a quoted glob': 'cat "/tmp/gnomon-run1/*.log"',
  'a brace': 'cat /tmp/gnomon-run1/{a,b}.log',
  'a database': 'cat /tmp/gnomon-run1/copy.db',
  'a sqlite file': 'head -c 100 /tmp/gnomon-run1/x.sqlite3',
  'the backups folder': 'ls /tmp/gnomon-run1/sundial-backups',
  "Sundial's data folder in another spelling": 'ls /tmp/gnomon-run1/.Sundial',
  'find following links': 'find -L /tmp/gnomon-run1 -name x',
  'find -follow': 'find /tmp/gnomon-run1 -follow -name x',
  'find -H': 'find -H /tmp/gnomon-run1',
  'find with no folder': 'find -name x',
  'find of the current folder': 'find . -name x',
  'find -newer outside': 'find /tmp/gnomon-run1 -newer /Users/mira/.zshrc',
  'find -delete': 'find /tmp/gnomon-run1 -name "*.log" -delete',
  'find -exec': 'find /tmp/gnomon-run1 -name "*.md" -exec cat {} \\;',
  'grep -R (follows links)': 'grep -R foo /tmp/gnomon-run1',
  'grep -r with no folder': 'grep -rn foo',
  'grep -f': 'grep -f /tmp/gnomon-run1/p /tmp/gnomon-run1/x',
  'grep --file': 'grep --file=/dev/stdin x /tmp/gnomon-run1/x',
  'ls with no folder': 'ls -la',
  'ls -L': 'ls -L /tmp/gnomon-run1',
  'du -L': 'du -L /tmp/gnomon-run1',
  'wc --files0-from': 'wc --files0-from=/tmp/gnomon-run1/list',
  'tail -f': 'tail -f /tmp/gnomon-job-run160.log',
  'a dropped verb: rg': 'rg foo /tmp/gnomon-run1',
  'a dropped verb: sed': "sed -n '1p' /tmp/gnomon-run1/x",
  'a dropped verb: awk': "awk '{print}' /tmp/gnomon-run1/x",
  'a dropped verb: jq': 'jq . /tmp/gnomon-run1/x.json',
  'a dropped verb: file': 'file /tmp/gnomon-run1/x',
  'a dropped verb: stat': 'stat /tmp/gnomon-run1/x',
  'date setting the clock': 'date 0101000026',
  'a redirect into a file': 'cat /tmp/gnomon-run1/a > /tmp/gnomon-run1/b',
  'a pipe into tee': 'cat /tmp/gnomon-run1/a | tee /tmp/gnomon-run1/b',
  'a pipe into a shell': 'cat /tmp/gnomon-run1/a | sh',
  'a chained write': 'cat /tmp/gnomon-run1/a && touch /tmp/gnomon-run1/done',
  'command substitution': 'echo $(cat /tmp/gnomon-run1/a)',
  'backticks': 'echo "`whoami`"',
  'an input redirect': 'wc -l < /tmp/gnomon-run1/a',
  'a background job': 'cat /tmp/gnomon-run1/a &',
  'a subshell': '(cat /tmp/gnomon-run1/a)',
  'an unknown option': 'cat --show-all /tmp/gnomon-run1/a',
  'an unclosed quote': 'cat "/tmp/gnomon-run1/a',
  'cat with nothing named': 'cat',
  'a pipe from nothing named': 'cat | head -5',
  'echo (reads no file, not on the list)': 'echo hi',
  'pwd': 'pwd',
  'date': 'date +%s',
}

describe('a plain read asks nothing under workspace-write', () => {
  it.each(READS)('allows %s with the reason', (command) => {
    expect(plainRead(command)).toBe(true)
    for (const over of [{ preset: 'workspace-write' }, { preset: 'danger-full-access' }, { autonomy: 'notice' }]) {
      expect(decide(command, over), JSON.stringify(over)).toEqual({ kind: 'allow', reason: PLAIN_READ })
      expect(decideAction({ toolName: 'bash', args: { command }, resolveActionPolicy, actions: actions(), preset: 'workspace-write', ...over })).toEqual({ kind: 'allow', reason: PLAIN_READ })
    }
  })

  it('under read-only, a custom preset and a job nobody can answer it decides as before', () => {
    const command = 'cat /tmp/gnomon-run1/job.log'
    expect(decide(command, { preset: 'read-only' }).kind).toBe('deny')
    expect(decide(command, { preset: 'custom', approvalOverride: 'ask' }).kind).toBe('ask')
    expect(decide(command, { preset: undefined, approvalOverride: 'never' }).kind).toBe('deny')
    expect(decide(command, { preset: 'workspace-write', approvalOverride: 'never' }).kind).not.toBe('allow')
    expect(decideAction({ toolName: 'bash', args: { command }, resolveActionPolicy, actions: actions(), preset: 'read-only' }).kind).toBe('deny')
  })

  it('the record counts it: the call facts say so and the decided row carries the reason', () => {
    const command = 'cat /tmp/gnomon-run1/job.log'
    const facts = callFacts({ toolName: 'gnomon_run_shell', args: { command } })
    expect(facts.plainRead).toBe(true)
    const row = decisionRecord({ name: 'gnomon_run_shell', args: { command } }, { preset: 'workspace-write', facts }, decide(command))
    expect(row).toMatchObject({ verdict: 'allow', reason: 'a plain read' })
    // Refolded from the row alone, the same verdict.
    expect(decideAction({ toolName: row.tool, resolveActionPolicy, actions: actions(), ...row.inputs })).toEqual({ kind: 'allow', reason: PLAIN_READ })
  })

  it("the owner's own ask (or off) for run_shell in config.actions still stands", () => {
    expect(decide('cat /tmp/gnomon-run1/job.log', { actions: actions('ask') }).kind).toBe('ask')
    expect(decide('cat /tmp/gnomon-run1/job.log', { actions: actions('off'), preset: 'danger-full-access' }).kind).toBe('deny')
  })
})

describe('everything else asks as before', () => {
  it.each(Object.entries(ASKS))('%s asks', (_, command) => {
    expect(plainRead(command)).toBe(false)
    const d = decide(command)
    expect(d.kind).not.toBe('allow')
    expect(d.reason).not.toBe(PLAIN_READ)
  })

  it("none of the review's probes is a plain read", () => {
    const probes = fs.readFileSync(new URL('./gate-reads.probes.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    expect(probes.length).toBeGreaterThan(300)
    expect(probes.filter((command) => plainRead(command))).toEqual([])
  })
})

describe('the guards come first', () => {
  it("a private app's data stays refused", () => {
    for (const command of ['cat ~/Library/Messages/chat.db', 'ls ~/Library/Mail/V10', 'head ~/Library/Containers/com.apple.mail/Data/x']) {
      expect(plainRead(command)).toBe(false)
      expect(decide(command, { preset: 'danger-full-access' }).kind).toBe('deny')
    }
  })

  it('a destructive or credential read is refused', () => {
    for (const command of ['cat ~/.ssh/id_ed25519', 'grep -r puzzlebox ~', 'head .env']) {
      expect(plainRead(command)).toBe(false)
      expect(decide(command).kind).toBe('deny')
    }
  })

  it("Sundial's own secrets and port are never a plain read, and run_shell still refuses them", async () => {
    const env = { SUNDIAL_HOME: '/Users/mira/.sundial-test', SUNDIAL_WEB_PORT: '3180' }
    for (const command of ['cat ~/.sundial/.daemon/api-token', 'cat /Users/mira/.sundial-test/.env', 'ls ~/.sundial/logs', 'cat ~/.sundial/dsh/session-index.sqlite']) {
      expect(plainRead(command, env)).toBe(false)
      expect(decide(command).kind).not.toBe('allow')
    }
    const tool = runShellTool(async () => {}, '/ws', { resolve: (r) => r, execute: async () => ({ result: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }) }) }, { recordCommand: () => true })
    expect(await tool.execute({ command: 'cat ~/.sundial/.daemon/api-token' })).toMatchObject({ ran: false })
  })

  it('a wait by sleeping is not a plain read', () => {
    expect(plainRead('tail -F /tmp/gnomon-job-run160.log')).toBe(false)
    expect(plainRead('timeout 30 tail --follow=name x.log')).toBe(false)
  })
})

describe('gnomon_run_shell answers when the command exits', () => {
  it("a short command's result does not wait for the record's append (the kernel lane may be busy folding)", async () => {
    const stuck = () => new Promise(() => {})
    const runs = []
    const shell = { resolve: (r) => r, execute: async (spec) => (runs.push(spec), { result: async () => ({ exitCode: 0, stdout: { text: 'hi\n' }, stderr: { text: '' } }) }) }
    const tool = runShellTool(stuck, '/ws', shell, { recordCommand: () => true })
    const out = await Promise.race([tool.execute({ command: 'echo hi' }), new Promise((done) => setTimeout(() => done('waited'), 200))])
    expect(out).toMatchObject({ ran: true, exitCode: 0, stdout: 'hi\n' })
    expect(runs).toHaveLength(1)
  })

  it('the record still gets the row, before the command runs', async () => {
    const order = []
    const shell = { resolve: (r) => r, execute: async () => (order.push('ran'), { result: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }) }) }
    const tool = runShellTool(async (type, payload) => order.push(`${type} ${payload.command}`), '/ws', shell, { recordCommand: () => true })
    await tool.execute({ command: 'pwd' })
    // Set 2 R3: the chat's `shell:started` row goes before the run too.
    expect(order).toEqual(['action:performed pwd', 'shell:started undefined', 'ran'])
  })
})
