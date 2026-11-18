// gnomon_run_shell runs through dsh's sandboxed ShellExecutor, never raw
// child_process — so an approved command obeys the active preset's sandbox.
import { describe, it, expect, vi } from 'vitest'
import { confirmSent, runShellTool, waitsBySleeping, SLEEP_REFUSAL, touchesOwnSecrets, OWN_SECRETS_REFUSAL } from './run-shell.js'

// A fake ShellExecutor: resolve() echoes the request as a spec, run() returns a
// canned ShellRunResult. Records the specs it was asked to run.
function fakeShell(runResult) {
  const runs = []
  return {
    runs,
    resolve: (req) => ({ ...req, workdir: req.workdir, timeoutMs: req.timeoutMs ?? 60000, stdoutMaxBytes: req.stdoutMaxBytes ?? 100000 }),
    execute: async (spec) => {
      runs.push(spec)
      return { result: async () => runResult }
    },
  }
}

const OK = { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 60000, stdout: { text: 'hello\n', truncated: false }, stderr: { text: '', truncated: false } }

/** Never the owner's real shell hook file (see run-shell.js). */
const NO_HOOK = { recordCommand: () => true }

describe('gnomon_run_shell', () => {
  it('runs a benign command through the sandboxed executor and returns its output', async () => {
    const appended = []
    const shell = fakeShell(OK)
    const tool = runShellTool(async (t, p) => appended.push({ t, p }), '/Users/x/Projects/sundial', shell, NO_HOOK)

    const out = await tool.execute({ command: 'echo hello' })
    expect(out).toMatchObject({ ran: true, exitCode: 0, stdout: 'hello\n', timedOut: false })
    // It went through resolve()+run(), in the workspace, NOT child_process.
    expect(shell.runs).toHaveLength(1)
    expect(shell.runs[0]).toMatchObject({ command: 'echo hello', workdir: '/Users/x/Projects/sundial' })
    // `action:performed`, NOT `assistant:proposal`. A command that ran is not a
    // suggestion awaiting the owner's yes: recorded on the proposal channel it
    // sat in the assistant's ledger as a permanently-open proposal and skewed
    // the acceptance rate the model is shown about its own track record.
    expect(appended[0].t).toBe('action:performed')
    expect(appended[0].p).toMatchObject({ tool: 'run_shell', command: 'echo hello' })
  })

  it('refuses a destructive command before touching the executor', async () => {
    const appended = []
    const shell = fakeShell(OK)
    const tool = runShellTool(async (t, p) => appended.push({ t, p }), '/ws', shell, NO_HOOK)

    const out = await tool.execute({ command: 'rm -rf ~' })
    expect(out.ran).toBe(false)
    expect(out.refused).toMatch(/destructive|delete/i)
    expect(shell.runs).toHaveLength(0) // never reached the executor
    // Still recorded — an attempted destructive command is exactly what the
    // owner should be able to find later — and on the same action channel.
    expect(appended[0].t).toBe('action:performed')
    expect(appended[0].p).toMatchObject({ tool: 'run_shell' })
    expect(appended[0].p.refused).toMatch(/destructive|delete/i)
  })

  it('Set 4 R1: a refusal carries its reason on shell:started, and a command it waited for carries its chat to the hook file', async () => {
    const signals = []
    const hooked = []
    const exec = { agent: { session: { id: 'chat-1' } } }
    const append = async (type, payload) => signals.push({ type, ...payload })
    await runShellTool(append, '/ws', fakeShell(OK), NO_HOOK).execute({ command: 'rm -rf ~' }, exec)
    expect(signals.find((s) => s.type === 'shell:started')).toMatchObject({ session: 'chat-1', failed: true, reason: expect.stringMatching(/destructive|delete/i) })
    await runShellTool(append, '/ws', fakeShell({ ...OK, exitCode: 2 }), { recordCommand: (e) => hooked.push(e) }).execute({ command: 'cat notes.txt' }, exec)
    expect(hooked).toEqual([expect.objectContaining({ command: 'cat notes.txt', exitCode: 2, session: 'chat-1' })])
    await runShellTool(append, '/ws', fakeShell(OK), { recordCommand: (e) => hooked.push(e) }).execute({ command: 'ls' }, {})
    expect(hooked[1]).not.toHaveProperty('session')
  })

  it('steers away from an osascript that waits on a consent prompt', () => {
    expect(runShellTool(async () => {}, '/ws', undefined, NO_HOOK).description).toContain('An osascript that tells another app (TextEdit, Finder, Mail) can hang a minute on a macOS consent prompt only the owner can answer: read the file or use screen_look instead.')
    // Run 54 T01: an Obsidian note is written as a file, never through an obsidian:// URL.
    expect(runShellTool(async () => {}, '/ws', undefined, NO_HOOK).description).toContain(`An Obsidian note is a .md file in the vault: create it with a quoted heredoc (cat > "<vault>/<name>.md" <<'EOF' ... EOF), append with >>; obsidian:// URLs mangle quotes and $ and only show a note.`)
    // Runs 167, 186, 194, 204 T01: a python heredoc built the obsidian:// URL; the rig (and an owner) could not read it whole.
    expect(runShellTool(async () => {}, '/ws', undefined, NO_HOOK).description).toContain('Never build a note or an app URL in an inline python or node script: the owner approves what they can read, so open a plain URL.')
  })

  it('surfaces a sandbox denial rather than pretending it ran', async () => {
    const denied = { ...OK, exitCode: null, sandbox: { mode: 'workspace-write', denied: true } }
    const tool = runShellTool(async () => {}, '/ws', fakeShell(denied), NO_HOOK)
    const out = await tool.execute({ command: 'touch /etc/nope' })
    expect(out.ran).toBe(true)
    expect(out.sandboxDenied).toBe(true)
  })

  it('refuses (does not run wide open) when no sandboxed executor is available', async () => {
    const tool = runShellTool(async () => {}, '/ws', undefined, NO_HOOK)
    const out = await tool.execute({ command: 'echo hi' })
    expect(out.ran).toBe(false)
    expect(out.refused).toMatch(/sandbox/i)
  })
})

describe('proof before a claim: a Mail send is checked in the Sent mailbox', () => {
  const MAIL = `osascript -e 'tell application "Mail"' -e 'set m to make new outgoing message with properties {subject:"Lunch", content:"See you"}' -e 'tell m to make new to recipient at end of to recipients with properties {address:"mira@example.com"}' -e 'send m' -e 'end tell'`
  // The send, then the check: the second run answers with what Sent holds.
  function twoRuns(sent) {
    const shell = fakeShell(OK)
    const execute = shell.execute
    shell.execute = async (spec) => (shell.runs.length === 0 ? execute(spec) : (shell.runs.push(spec), { result: async () => ({ ...OK, stdout: { text: sent, truncated: false } }) }))
    return shell
  }
  const send = (shell) => runShellTool(async () => {}, '/ws', shell, NO_HOOK).execute({ command: MAIL })

  it('confirms when Sent has the subject to the same recipient', async () => {
    const shell = twoRuns('found\nmira@example.com\n')
    const out = await send(shell)
    expect(shell.runs).toHaveLength(2)
    expect(shell.runs[1].command).toMatch(/sent mailbox whose subject is "Lunch"/)
    expect(out.sendCheck).toBe(`Confirmed: Mail's Sent mailbox has "Lunch" to mira@example.com.`)
  })

  it('says it could not confirm when Sent has nothing, or another recipient', async () => {
    expect((await send(twoRuns(''))).sendCheck).toMatch(/^Not confirmed: no mail with subject "Lunch"/)
    expect((await send(twoRuns('found\njon@example.com'))).sendCheck).toMatch(/^Not confirmed: .*not to mira@example.com/)
  })

  it('checks nothing for a command that sends no mail, and calls a path it cannot read unconfirmed', async () => {
    const shell = fakeShell(OK)
    expect((await runShellTool(async () => {}, '/ws', shell, NO_HOOK).execute({ command: 'echo hello' })).sendCheck).toBeUndefined()
    expect(shell.runs).toHaveLength(1)
    expect(await confirmSent({ app: null, to: ['mira@example.com'], subject: 'Hi' }, shell, '/ws')).toMatch(/^Not confirmed/)
  })
})

describe('a mail send keeps its content off the record, and is checked only against mail sent since the call', () => {
  const MAIL = `osascript -e 'tell application "Mail"' -e 'set m to make new outgoing message with properties {subject:"Lunch", content:"See you"}' -e 'tell m to make new to recipient at end of to recipients with properties {address:"mira@example.com"}' -e 'send m' -e 'end tell'`

  it('records a placeholder in the hook file and action:performed, never the recipients or body', async () => {
    const appended = []
    const hooked = []
    const shell = fakeShell(OK)
    await runShellTool(async (t, p) => appended.push(p), '/ws', shell, { recordCommand: (e) => hooked.push(e) }).execute({ command: MAIL })
    expect(appended[0].command).toBe('a mail send, content not recorded')
    expect(hooked[0].command).toBe('a mail send, content not recorded')
    expect(JSON.stringify([appended, hooked])).not.toMatch(/mira@example\.com|See you/)
  })

  it('the Sent check looks only at mail sent since the call started', async () => {
    const shell = fakeShell(OK)
    await confirmSent({ app: 'Mail', to: ['mira@example.com'], subject: 'Lunch' }, shell, '/ws', Date.now() - 4_000)
    expect(shell.runs[0].command).toMatch(/set cutoff to \(current date\) - [56]'/)
    expect(shell.runs[0].command).toMatch(/date sent >= cutoff/)
  })
})

describe('a job in the background (runs 13 and 14: half the clock went on sleeping)', () => {
  it('answers at once with a job id, and puts how it ended on the record', async () => {
    const { runShellTool } = await import('./run-shell.js')
    const signals = []
    let finish
    const shell = {
      resolve: (spec) => spec,
      execute: async () => ({ result: () => new Promise((done) => { finish = done }) }),
    }
    const tool = runShellTool(async (type, payload) => signals.push({ type, ...payload }), '/tmp', shell, { recordCommand: () => {} })
    const out = await tool.execute({ command: 'echo hello', background: true }, {})
    // It came back without waiting for the command: nothing has ended yet.
    expect(out).toMatchObject({ ran: true, started: true })
    expect(out.jobId).toMatch(/^job-[0-9a-f]{8}$/)
    // Run 219 T11: "a watcher will report the end line" was said, and nothing ever reports a job's end.
    expect(out.note).toMatch(new RegExp(`^Started\\. Nothing tells you or the owner when it ends, so before you answer about it, wait for it with gnomon_await \\{job: "${out.jobId}"\\}`))
    expect(signals.filter((s) => s.type === 'shell:exited')).toHaveLength(0)
    finish({ exitCode: 0, stdout: { text: 'line 5\nline 6\n' } })
    await new Promise((done) => setTimeout(done, 10))
    expect(signals.find((s) => s.type === 'shell:exited')).toMatchObject({ jobId: out.jobId, exitCode: 0, lastLine: 'line 6' })
  })

  it('runs 227 and 228: a background job is not cut at the foreground minute (a 90 s build was killed at 60 s, its code lost)', async () => {
    const shell = fakeShell(OK)
    const tool = runShellTool(async () => {}, '/tmp', shell, NO_HOOK)
    await tool.execute({ command: 'make build', background: true }, {})
    await tool.execute({ command: 'make build' }, {})
    await tool.execute({ command: 'make build', background: true, timeoutMs: 120_000 }, {})
    expect(shell.runs.map((s) => s.timeoutMs)).toEqual([600_000, 60_000, 120_000])
  })
})

describe('waiting by sleeping is refused (rig run161: a shell sleep instead of gnomon_await)', () => {
  it.each([
    'sleep 30',
    'sleep 1',
    'sleep 2m',
    'sleep $DELAY',
    'sleep infinity',
    'sleep 30 && tail -n 20 build.log',
    'cd /ws; sleep 5; cat out.txt',
    'while ! test -f done.txt; do sleep 2; done',
    'while true; do sleep 0.5; done',
    'until curl -s localhost:8080; do sleep 1; done',
    'until grep -q ready log.txt; sleep 0.3; done',
    "bash -c 'sleep 10; ls'",
    'echo $(sleep 5)',
    'timeout 30 tail -f build.log',
    'tail -f build.log',
    'tail -F build.log',
    'tail -n 50 -f build.log',
    'tail --follow=name build.log',
    'watch -n 2 ls',
    'watch ls',
  ])('refuses %s with the gnomon_await hint, before the executor', async (command) => {
    expect(waitsBySleeping(command)).toBe(true)
    const appended = []
    const shell = fakeShell(OK)
    const out = await runShellTool(async (t, p) => appended.push(p), '/ws', shell, NO_HOOK).execute({ command })
    expect(out).toEqual({ ran: false, refused: SLEEP_REFUSAL })
    expect(out.refused).toBe("Waiting by sleeping is refused: use gnomon_await (it waits for the job's end, a file, or a number of seconds) and then read the result.")
    expect(shell.runs).toHaveLength(0)
    expect(appended[0]).toMatchObject({ tool: 'run_shell', refused: SLEEP_REFUSAL })
  })

  it.each([
    'sleep 0.2',
    'sleep .5 && echo done',
    'for f in a b; do convert $f; sleep 0.1; done',
    'echo hello',
    'tail -n 20 build.log',
    'git log --grep sleep',
    'grep -rn sleep src',
    'npm run watch-docs',
    'ls ~/watch',
    'fswatch --help',
    'cat sleep.txt | head',
  ])('runs %s', async (command) => {
    expect(waitsBySleeping(command)).toBe(false)
    const shell = fakeShell(OK)
    const out = await runShellTool(async () => {}, '/ws', shell, NO_HOOK).execute({ command })
    expect(out.ran).toBe(true)
    expect(shell.runs).toHaveLength(1)
  })

  // The rig's slow-job anchor and an owner's job sleep inside themselves: the turn does not wait on them.
  it.each([
    ['for i in 1 2 3 4 5 6; do echo "line $i"; sleep 4; done > /tmp/gnomon-job-run9.log', true],
    ['for i in 1 2 3; do echo "line $i"; sleep 4; done > /tmp/job.log &', false],
    ['( sleep 30; echo done > /tmp/flag ) &', false],
    ['nohup sh -c "sleep 60; make" &', false],
    ["bash -c 'while true; do date; sleep 5; done' &", false],
  ])('runs a job that sleeps inside itself when it is started in the background: %s', async (command, flag) => {
    const shell = fakeShell(OK)
    const out = await runShellTool(async () => {}, '/ws', shell, NO_HOOK).execute({ command, ...(flag ? { background: true } : {}) })
    expect(out.ran).toBe(true)
    expect(out.refused).toBeUndefined()
  })

  it('still refuses the same job in the foreground, and a sleep chained after &&', async () => {
    for (const command of ['for i in 1 2 3; do echo "line $i"; sleep 4; done > /tmp/job.log', 'make && sleep 30', 'tail -f build.log', 'watch ls']) {
      const out = await runShellTool(async () => {}, '/ws', fakeShell(OK), NO_HOOK).execute({ command })
      expect(out).toEqual({ ran: false, refused: SLEEP_REFUSAL })
    }
  })
})

describe('the assistant never reads its own secrets or calls its own web API', () => {
  const ENV = { SUNDIAL_HOME: '/Users/mira/.sundial', SUNDIAL_WEB_PORT: '3180' }
  it.each([
    'cat ~/.sundial/.daemon/api-token',
    'ls ~/.sundial/.daemon',
    'cat $SUNDIAL_HOME/.daemon/sidecars.pid',
    'cd ~/.sundial && cat .daemon/app.pid',
    'grep -o "token=[^ ]*" ~/.sundial/logs/sundial.log',
    'tail -n 50 /Users/mira/.sundial/logs/sundial.log',
    'grep KEY ~/.sundial/.env',
    'sed -n 1p "$SUNDIAL_HOME/.env"',
    'cd ~/.sundial; source .env',
    'awk 1 ${SUNDIAL_HOME}/.env',
    'cat ~/.sundial/dsh/.credentials.yaml',
    'ls ~/.sundial/dsh/sessions',
    'sqlite3 ~/.sundial/dsh/session-index.sqlite .tables',
    'cat $DSH_HOME/settings.yaml.imported',
    'grep -r token ~/.sundial',
    'cat ~/.sundial/*',
    'curl -s http://127.0.0.1:3080/gnomon/api/read',
    'curl localhost:3080',
    'wget -qO- http://[::1]:3080/',
    'nc localhost 3080',
    'exec 3<>/dev/tcp/127.0.0.1/3080',
    `python3 -c "import urllib.request; print(urllib.request.urlopen('http://localhost:3080').read())"`,
    `node -e "require('http').get('http://127.0.0.1:3080/', r => r.pipe(process.stdout))"`,
    'curl http://localhost:$SUNDIAL_WEB_PORT/',
  ])('refuses %s, before the executor and in the background too', async (command) => {
    expect(touchesOwnSecrets(command, ENV)).toBe(true)
    for (const background of [false, true]) {
      const shell = fakeShell(OK)
      const out = await runShellTool(async () => {}, '/ws', shell, NO_HOOK).execute({ command, background })
      expect(out).toEqual({ ran: false, refused: OWN_SECRETS_REFUSAL })
      expect(shell.runs).toHaveLength(0)
    }
  })

  it('refuses the configured web port, and leaves it alone where nothing is configured', () => {
    expect(touchesOwnSecrets('curl http://127.0.0.1:3180/', ENV)).toBe(true)
    expect(touchesOwnSecrets('curl http://127.0.0.1:3180/', {})).toBe(false)
  })

  it.each([
    'cat ~/.sundial/config.json',
    'jq .llm ~/.sundial/config.json',
    'ls ~/.sundial',
    'curl -s https://example.com',
    'curl localhost:8080/health',
    'grep -rn logs src',
  ])('allows %s', (command) => {
    expect(touchesOwnSecrets(command, ENV)).toBe(false)
  })
})
