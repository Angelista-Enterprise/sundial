// The installer's safety rules, run against throwaway folders only. Nothing here
// touches launchd, a real ~/.sundial, or any folder a person owns.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sundial')

let root
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sundial-cli-'))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function sundial(args, env) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, SUNDIAL_LABEL: 'dev.sundial.vitest', ...env } })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

const precious = (dir) => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'data.txt'), 'precious')
}

describe('sundial uninstall refuses what it did not install', () => {
  it('a folder with files and no marker', () => {
    const dir = path.join(root, 'notours')
    precious(dir)
    const r = sundial(['uninstall', '--yes'], { SUNDIAL_HOME: dir })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/no Sundial install marker/)
    expect(fs.readFileSync(path.join(dir, 'data.txt'), 'utf8')).toBe('precious')
  })

  it('a marker copied in from another install', () => {
    const dir = path.join(root, 'copied')
    precious(dir)
    fs.writeFileSync(path.join(dir, '.sundial-install.json'), JSON.stringify({ tool: 'sundial', home: '/somewhere/else', installId: 'x' }))
    expect(sundial(['uninstall', '--yes'], { SUNDIAL_HOME: dir }).code).toBe(1)
    expect(fs.existsSync(path.join(dir, 'data.txt'))).toBe(true)
  })

  it('the pre-rename folder, the home folder, and a relative path', () => {
    const home = path.join(root, 'home')
    precious(path.join(home, '.gnomon'))
    for (const target of [path.join(home, '.gnomon'), home, path.join(home, '.dsh')]) {
      const r = sundial(['uninstall', '--yes'], { HOME: home, SUNDIAL_HOME: target })
      expect(r.code, target).toBe(1)
    }
    expect(sundial(['uninstall', '--yes'], { SUNDIAL_HOME: 'relative/dir' }).out).toMatch(/absolute path/)
    expect(fs.existsSync(path.join(home, '.gnomon', 'data.txt'))).toBe(true)
  })
})

describe('sundial install', () => {
  it('refuses a non-empty folder it does not own', () => {
    const dir = path.join(root, 'notours')
    precious(dir)
    const r = sundial(['install', '--skip-build', '--no-launchagent'], { SUNDIAL_HOME: dir })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/not made by this installer/)
    expect(fs.readdirSync(dir)).toEqual(['data.txt'])
  })

  it('writes a private data folder, and uninstall removes exactly that folder', () => {
    if (process.platform !== 'darwin') return
    const dir = path.join(root, 'sundial')
    const sibling = path.join(root, 'keep-me')
    precious(sibling)
    const r = sundial(['install', '--skip-build', '--no-launchagent', '--no-sidecars'], { SUNDIAL_HOME: dir })
    expect(r.code, r.out).toBe(0)
    for (const f of ['.sundial-install.json', 'config.json', '.env', 'start.sh', 'shell-hook.zsh', 'dsh/profiles/web/package.json', 'dsh/profiles/web/cordis.patch.yml']) {
      expect(fs.existsSync(path.join(dir, f)), f).toBe(true)
    }
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(dir, '.env')).mode & 0o777).toBe(0o600)
    const start = fs.readFileSync(path.join(dir, 'start.sh'), 'utf8')
    expect(start).toContain('umask 077')
    expect(start).toContain('DSH_TELEMETRY_DISABLED=1')
    expect(start).toContain('SUNDIAL_NATIVE_HELPERS=0')
    expect(start).toContain('--host 127.0.0.1')
    // Every plugin the profile names resolves to a folder in this checkout.
    const profile = JSON.parse(fs.readFileSync(path.join(dir, 'dsh/profiles/web/package.json'), 'utf8'))
    for (const name of profile.dsh.profile.bundles.filter((b) => b.startsWith('@sundial/'))) {
      expect(fs.existsSync(path.join(dir, 'dsh/profiles/web/node_modules', name, 'package.json')), name).toBe(true)
    }

    expect(sundial(['uninstall'], { SUNDIAL_HOME: dir }).out).toMatch(/This would remove/)
    expect(fs.existsSync(dir)).toBe(true)
    const u = sundial(['uninstall', '--yes'], { SUNDIAL_HOME: dir })
    expect(u.code, u.out).toBe(0)
    expect(fs.existsSync(dir)).toBe(false)
    expect(fs.readFileSync(path.join(sibling, 'data.txt'), 'utf8')).toBe('precious')
  })
})

describe('sundial claude-hooks (report-only, U3-F8 / F50)', () => {
  const owner = {
    permissions: { defaultMode: 'auto' },
    hooks: { Notification: [{ matcher: 'permission_prompt', hooks: [{ type: 'command', command: 'say done' }] }] },
    statusLine: { type: 'command', command: '~/.claude/statusline.sh' },
  }
  const setup = () => {
    const home = path.join(root, 'home')
    const claude = path.join(home, '.claude')
    const data = path.join(root, 'sundial')
    fs.mkdirSync(claude, { recursive: true })
    fs.mkdirSync(path.join(data, '.daemon'), { recursive: true })
    const original = `${JSON.stringify(owner, null, 2)}\n`
    fs.writeFileSync(path.join(claude, 'settings.json'), original)
    const env = { HOME: home, CLAUDE_CONFIG_DIR: claude, SUNDIAL_HOME: data }
    return { claude, data, original, env, settings: () => fs.readFileSync(path.join(claude, 'settings.json'), 'utf8') }
  }

  it('adds its hooks idempotently, keeps the owner\'s, and removes exactly its own', () => {
    const t = setup()
    expect(sundial(['claude-hooks'], t.env).code).toBe(0)
    const once = t.settings()
    expect(sundial(['claude-hooks'], t.env).code).toBe(0)
    expect(t.settings()).toBe(once)
    const parsed = JSON.parse(once)
    expect(Object.keys(parsed)).toEqual(['permissions', 'hooks', 'statusLine'])
    expect(Object.keys(parsed.hooks).sort()).toEqual(['Notification', 'PostToolUse', 'PreCompact', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure', 'UserPromptSubmit'])
    expect(parsed.hooks.Notification[0]).toEqual(owner.hooks.Notification[0])
    const ours = parsed.hooks.Stop[0].hooks[0]
    expect(ours).toMatchObject({ type: 'command', async: true })
    expect(ours.command).toContain('claude-hook.mjs')
    expect(ours.command.endsWith(`'${t.data}'`)).toBe(true)
    expect(sundial(['claude-hooks', '--remove'], t.env).code).toBe(0)
    expect(t.settings()).toBe(t.original)
  })

  it('the hook writes one whitelisted line and prints nothing', () => {
    const t = setup()
    sundial(['claude-hooks'], t.env)
    const command = JSON.parse(t.settings()).hooks.Stop[0].hooks[0].command
    const payload = { session_id: 'abcdef12-3456', hook_event_name: 'Stop', cwd: '/Users/pat/Projects/acme', transcript_path: '/x.jsonl', last_assistant_message: 'the secret answer', stop_hook_active: false }
    const r = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify(payload), encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    const file = path.join(t.data, '.daemon', 'claude-hooks.jsonl')
    const line = JSON.parse(fs.readFileSync(file, 'utf8').trim())
    expect(line).toMatchObject({ event: 'Stop', session: 'abcdef12', cwd: '/Users/pat/Projects/acme' })
    expect(JSON.stringify(line)).not.toContain('secret')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    const edit = { session_id: 'abcdef12', hook_event_name: 'PostToolUse', cwd: '/Users/pat/Projects/acme', tool_name: 'Edit', tool_input: { file_path: '/Users/pat/Projects/acme/src/x.ts', old_string: 'secret', new_string: 'secret' } }
    spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify(edit), encoding: 'utf8' })
    const last = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').pop())
    expect(last).toMatchObject({ event: 'PostToolUse', tool: 'Edit', file: 'src/x.ts' })
    expect(JSON.stringify(last)).not.toContain('secret')
  })

  it('a test install leaves Claude alone; uninstall takes the hooks back out', () => {
    if (process.platform !== 'darwin') return
    const t = setup()
    const dir = path.join(root, 'sundial-install')
    const env = { ...t.env, SUNDIAL_HOME: dir }
    expect(sundial(['install', '--skip-build', '--no-launchagent', '--no-sidecars'], env).code).toBe(0)
    expect(t.settings()).toBe(t.original)
    sundial(['claude-hooks'], env)
    expect(t.settings()).not.toBe(t.original)
    expect(sundial(['uninstall'], env).out).toMatch(/Sundial's hooks in/)
    expect(sundial(['uninstall', '--yes'], env).code).toBe(0)
    expect(t.settings()).toBe(t.original)
  })

  it('refuses a settings file that is not JSON, and changes nothing', () => {
    const t = setup()
    fs.writeFileSync(path.join(t.claude, 'settings.json'), '{ not json')
    expect(sundial(['claude-hooks'], t.env).code).toBe(1)
    expect(t.settings()).toBe('{ not json')
  })
})

describe('sundial start opens the app without the caller\'s install variables (hardening S2)', () => {
  it("drops the caller's SUNDIAL_* and DSH_* from the env `open` gets, and passes this install's home", () => {
    const home = path.join(root, 'install')
    const bin = path.join(root, 'bin')
    const app = path.join(root, 'Sundial.app')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(home, '.sundial-install.json'), JSON.stringify({ tool: 'sundial', home, mode: 'app', app }))
    const seen = path.join(root, 'open.txt')
    fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh\necho "ARGS=$*" > '${seen}'\nenv >> '${seen}'\n`, { mode: 0o755 })
    for (const command of ['start', 'restart']) {
      fs.rmSync(seen, { force: true })
      const r = sundial([command], { SUNDIAL_HOME: home, PATH: `${bin}:${process.env.PATH}`, DSH_HOME: '/Users/mira/.sundial/dsh', SUNDIAL_WEB_PORT: '4567', SUNDIAL_CHROME_PORT: '9333' })
      expect(r.code, r.out).toBe(0)
      const lines = fs.readFileSync(seen, 'utf8').split('\n')
      expect(lines[0]).toBe(`ARGS=${app}`)
      expect(lines.filter((l) => /^(SUNDIAL|DSH)_/.test(l))).toEqual([`SUNDIAL_HOME=${home}`])
      expect(lines.some((l) => l.startsWith(`PATH=${bin}:`))).toBe(true)
    }
  })
})

describe('sundial restart waits for the old app to be gone', () => {
  it('polls the pid, not app.pid, and tries `open` once more when it fails', () => {
    const home = path.join(root, 'install')
    const bin = path.join(root, 'bin')
    const app = path.join(root, 'Sundial.app')
    fs.mkdirSync(path.join(home, '.daemon'), { recursive: true })
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(home, '.sundial-install.json'), JSON.stringify({ tool: 'sundial', home, mode: 'app', app }))
    // As Sundial.swift: app.pid goes in applicationWillTerminate, the process a moment later.
    const pidFile = path.join(home, '.daemon', 'app.pid')
    // Started through `sh … &` so launchd reaps it, as it does the app: a child
    // of this blocked test process would linger as a zombie that kill -0 still finds.
    const script = `const fs = require('fs'); process.on('SIGTERM', () => { fs.rmSync(process.argv[1]); setTimeout(() => process.exit(0), 1000) }); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)`
    spawnSync('/bin/sh', ['-c', `"$0" -e "$1" "$2" >/dev/null 2>&1 &`, process.execPath, script, pidFile])
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    const fake = { pid: Number(fs.readFileSync(pidFile, 'utf8')), kill: (sig) => { try { process.kill(fake.pid, sig) } catch {} } }
    const seen = path.join(root, 'open.txt')
    const count = path.join(root, 'count')
    fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh\nn=$(( $(cat '${count}' 2>/dev/null || echo 0) + 1 ))\necho $n > '${count}'\nkill -0 ${fake.pid} 2>/dev/null && echo alive >> '${seen}' || echo gone >> '${seen}'\n[ $n -ge 2 ]\n`, { mode: 0o755 })
    try {
      const r = sundial(['restart'], { SUNDIAL_HOME: home, PATH: `${bin}:${process.env.PATH}` })
      expect(r.code, r.out).toBe(0)
      expect(fs.readFileSync(seen, 'utf8')).toBe('gone\ngone\n')
    } finally {
      fake.kill('SIGKILL')
    }
  })
})

// lane H (H7)
describe('sundial status and doctor on an existing install', () => {
  it('doctor fails when the Node app.env names is gone', () => {
    const home = path.join(root, 'inst')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'app.env'), `SUNDIAL_NODE=${path.join(root, 'no-such-node')}\n`)
    const r = sundial(['doctor'], { SUNDIAL_HOME: home })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/app\.env's Node .* rewrites app\.env/s)
    fs.writeFileSync(path.join(home, 'app.env'), `SUNDIAL_NODE=${process.execPath}\n`)
    expect(sundial(['doctor'], { SUNDIAL_HOME: home }).out).toMatch(/ok\s+app\.env's Node/)
  })

  it('status warns about a stray bundle in the data folder of an app install', () => {
    const home = path.join(root, 'inst2')
    const app = path.join(root, 'Applications', 'Sundial.app')
    fs.mkdirSync(path.join(home, 'Sundial.app', 'Contents'), { recursive: true })
    fs.mkdirSync(app, { recursive: true })
    fs.writeFileSync(path.join(home, '.sundial-install.json'), JSON.stringify({ tool: 'sundial', home, mode: 'app', app }))
    const r = sundial(['status'], { SUNDIAL_HOME: home, SUNDIAL_WEB_PORT: '1' })
    expect(r.out).toMatch(/a second Sundial\.app is in/)
  })
})
