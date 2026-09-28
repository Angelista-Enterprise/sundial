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
