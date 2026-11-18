// `sundial mcp-hosts`: Sundial's MCP entry in every other host's own config file, on a throwaway
// HOME. Nothing here reads or writes the owner's files.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOSTS, serverBin } from '../bin/mcp-hosts.js'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(REPO, 'bin', 'sundial')
const BIN = serverBin(REPO)

let home, env
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sundial-hosts-'))
  env = { HOME: home, SUNDIAL_HOME: path.join(home, 'sundial'), SUNDIAL_LABEL: 'dev.sundial.vitest' }
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

const sundial = (...args) => {
  const r = spawnSync(process.execPath, [CLI, 'mcp-hosts', ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}
const file = (name) => path.join(home, HOSTS[name].file)
const read = (name) => fs.readFileSync(file(name), 'utf8')
const json = (name) => JSON.parse(read(name))
const present = (name) => fs.mkdirSync(path.join(home, HOSTS[name].installed), { recursive: true })

describe('sundial mcp-hosts', () => {
  it('finds the hosts on this Mac and writes each one its own entry, the stdio form, idempotently', () => {
    expect(sundial().out).toContain('No MCP host found')
    for (const name of Object.keys(HOSTS)) present(name)
    const first = sundial()
    expect(first.code).toBe(0)
    for (const name of Object.keys(HOSTS)) expect(first.out).toContain(`${HOSTS[name].title}: added to ${file(name)}`)

    expect(json('vscode').servers.sundial).toEqual({ type: 'stdio', command: process.execPath, args: [BIN], env: { SUNDIAL_HOME: env.SUNDIAL_HOME } })
    expect(json('cursor').mcpServers.sundial).toEqual({ command: process.execPath, args: [BIN], env: { SUNDIAL_HOME: env.SUNDIAL_HOME } })
    expect(json('gemini').mcpServers.sundial.args).toEqual([BIN])
    expect(json('claude-desktop').mcpServers.sundial.args).toEqual([BIN])
    expect(read('codex')).toBe(`# sundial-mcp:begin (written by \`sundial mcp-hosts\`; \`sundial mcp-hosts --remove\` takes it out)\n[mcp_servers.sundial]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(BIN)}]\nenv = { SUNDIAL_HOME = ${JSON.stringify(env.SUNDIAL_HOME)} }\n# sundial-mcp:end\n`)
    expect(read('goose')).toMatch(/^extensions:\n  # sundial-mcp:begin.*\n  sundial:\n    enabled: true\n    type: stdio\n    name: sundial\n    cmd: /)
    expect(read('goose')).toContain(`    envs:\n      SUNDIAL_HOME: ${JSON.stringify(env.SUNDIAL_HOME)}\n    timeout: 300\n  # sundial-mcp:end\n`)

    const second = sundial()
    for (const name of Object.keys(HOSTS)) expect(second.out).toContain(`${HOSTS[name].title}: already in`)
    expect(read('codex').split('sundial-mcp:begin')).toHaveLength(2)
  })

  it('keeps what the owner already had around the entry, and takes out exactly its own', () => {
    for (const name of ['cursor', 'codex', 'goose']) present(name)
    fs.mkdirSync(path.dirname(file('cursor')), { recursive: true })
    fs.writeFileSync(file('cursor'), JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } }, other: 1 }))
    fs.writeFileSync(file('codex'), 'model = "o3"\n\n[mcp_servers.github]\ncommand = "gh-mcp"\n')
    fs.mkdirSync(path.dirname(file('goose')), { recursive: true })
    fs.writeFileSync(file('goose'), 'GOOSE_MODEL: gpt-4o\nextensions:\n  developer:\n    enabled: true\n    type: builtin\n')
    expect(sundial().code).toBe(0)
    expect(Object.keys(json('cursor').mcpServers)).toEqual(['github', 'sundial'])
    expect(json('cursor').other).toBe(1)
    expect(read('codex')).toMatch(/^model = "o3"\n\n\[mcp_servers\.github\]\ncommand = "gh-mcp"\n\n# sundial-mcp:begin/)
    expect(read('goose')).toMatch(/^GOOSE_MODEL: gpt-4o\nextensions:\n  # sundial-mcp:begin.*\n  sundial:\n[\s\S]*  # sundial-mcp:end\n  developer:\n    enabled: true\n    type: builtin\n$/)

    const removed = sundial('--remove')
    expect(removed.code).toBe(0)
    expect(json('cursor')).toEqual({ mcpServers: { github: { command: 'gh-mcp' } }, other: 1 })
    expect(read('codex')).toBe('model = "o3"\n\n[mcp_servers.github]\ncommand = "gh-mcp"\n')
    expect(read('goose')).toBe('GOOSE_MODEL: gpt-4o\nextensions:\n  developer:\n    enabled: true\n    type: builtin\n')
    expect(sundial('--remove').out).toContain('Cursor: not in')
  })

  it("never touches a sundial entry that is not this checkout's, and names hosts on request", () => {
    present('vscode')
    present('codex')
    fs.mkdirSync(path.dirname(file('vscode')), { recursive: true })
    const foreign = { servers: { sundial: { type: 'stdio', command: 'node', args: ['/somewhere/else/sundial-mcp.js'] } } }
    fs.writeFileSync(file('vscode'), JSON.stringify(foreign))
    fs.writeFileSync(file('codex'), '[mcp_servers.sundial]\ncommand = "other"\n')
    const r = sundial()
    expect(r.out).toContain('VS Code: left alone in')
    expect(r.out).toContain('Codex: left alone in')
    expect(json('vscode')).toEqual(foreign)
    expect(sundial('--remove').out).toContain('VS Code: left alone in')
    expect(json('vscode')).toEqual(foreign)

    const named = sundial('--host', 'gemini,goose')
    expect(named.out).toContain('Gemini CLI: added to')
    expect(named.out).toContain('Goose: added to')
    expect(named.out).not.toContain('Cursor')
    expect(sundial('--host', 'emacs').code).toBe(1)
  })
})
