import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { expandSecrets, mcpConfigFor, mountIntegrations } from './integrations.js'

const obsidian = {
  name: 'obsidian',
  enabled: true,
  transport: 'stdio',
  command: '/vault/.obsidian/plugins/mcp-tools/bin/mcp-server',
  args: [],
  env: { OBSIDIAN_API_KEY: '$OBSIDIAN_API_KEY' },
  cwd: null,
  url: '',
  headers: {},
  reads: ['search*'],
  toolCallTimeoutMs: 30_000,
}
const notion = { ...obsidian, name: 'notion', transport: 'streamable-http', command: '', env: {}, url: 'https://mcp.notion.com/mcp', headers: { Authorization: 'Bearer ${NOTION_TOKEN}' } }

describe('expandSecrets', () => {
  it('expands $NAME and ${NAME}, and passes literals through', () => {
    const { expanded, missing } = expandSecrets({ A: '$KEY', B: '${KEY}', C: 'literal' }, { KEY: 'v' })
    expect(expanded).toEqual({ A: 'v', B: 'v', C: 'literal' })
    expect(missing).toEqual([])
  })

  // The failure that matters: a server started with an empty token fails in a
  // way that looks like a bug rather than like a missing secret.
  it('reports a missing or empty secret rather than expanding it to nothing', () => {
    expect(expandSecrets({ A: '$KEY' }, {}).missing).toEqual(['KEY'])
    expect(expandSecrets({ A: '$KEY' }, { KEY: '' }).missing).toEqual(['KEY'])
  })
})

describe('mcpConfigFor', () => {
  it('builds a stdio config with the secret expanded', () => {
    const { config, reason } = mcpConfigFor(obsidian, { OBSIDIAN_API_KEY: 'k' })
    expect(reason).toBeNull()
    expect(config).toMatchObject({ serverName: 'obsidian', transport: 'stdio', command: obsidian.command, env: { OBSIDIAN_API_KEY: 'k' }, failOnStartupError: false })
  })

  it('builds a streamable-http config with the header expanded', () => {
    const { config } = mcpConfigFor(notion, { NOTION_TOKEN: 't' })
    expect(config).toMatchObject({ serverName: 'notion', transport: 'streamable-http', url: notion.url, headers: { Authorization: 'Bearer t' } })
  })

  it('refuses to build when a secret is missing, and says which', () => {
    const { config, reason } = mcpConfigFor(obsidian, {})
    expect(config).toBeNull()
    expect(reason).toContain('OBSIDIAN_API_KEY')
    expect(reason).toContain('~/.sundial/.env')
  })
})

describe('mountIntegrations', () => {
  const ctx = () => ({ plugin: vi.fn() })
  const McpClient = { name: 'mcp-client' }

  it('mounts each enabled integration once, and reports the names', () => {
    const c = ctx()
    const statuses = mountIntegrations(c, McpClient, [obsidian, notion], { env: { OBSIDIAN_API_KEY: 'k', NOTION_TOKEN: 't' }, log: () => {}, warn: () => {} })
    expect(statuses.map((s) => [s.name, s.mounted, s.reason])).toEqual([['obsidian', true, null], ['notion', true, null]])
    expect(c.plugin).toHaveBeenCalledTimes(2)
    expect(c.plugin.mock.calls[0][0]).toBe(McpClient)
    expect(c.plugin.mock.calls[0][1].serverName).toBe('obsidian')
  })

  it('skips a disabled integration silently, and a secretless one loudly', () => {
    const c = ctx()
    const warn = vi.fn()
    const statuses = mountIntegrations(c, McpClient, [{ ...obsidian, enabled: false }, notion], { env: {}, log: () => {}, warn })
    // Both are reported, with WHY — that is what the UI shows the owner.
    expect(statuses.map((s) => [s.name, s.mounted])).toEqual([['obsidian', false], ['notion', false]])
    expect(statuses[0].reason).toBe('disabled in config')
    expect(statuses[1].reason).toContain('NOTION_TOKEN')
    expect(c.plugin).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain('notion not mounted')
  })

  it('does not let one failing mount take the others down', () => {
    const c = { plugin: vi.fn((_p, config) => { if (config.serverName === 'obsidian') throw new Error('spawn failed') }) }
    const statuses = mountIntegrations(c, McpClient, [obsidian, notion], { env: { OBSIDIAN_API_KEY: 'k', NOTION_TOKEN: 't' }, log: () => {}, warn: () => {} })
    expect(statuses.map((s) => [s.name, s.mounted])).toEqual([['obsidian', false], ['notion', true]])
    expect(statuses[0].reason).toContain('spawn failed')
  })
})
