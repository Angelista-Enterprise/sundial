// Gnomon's reach: the owner's own services, mounted as MCP clients.
//
// dsh ships an MCP client plugin and expects one row per server in the machine-
// level profile. Gnomon mounts them ITSELF instead — `ctx.plugin(McpClient,
// config)`, the same way dsh's own web-app mounts its static server — so that
// reach is declared where Gnomon's other choices are (`~/.sundial/config.json`),
// sits behind Gnomon's gate, and never requires editing a file outside the
// repository's reach.
//
// This file decides nothing about permission. It reads the config, expands the
// secrets, and mounts. The gate (gate.js) decides what each tool may do.
import { readSundialEnvFile } from '@sundial/helpers/sundial-env.js'

/** `$NAME` or `${NAME}`, anywhere in a value — `Bearer ${TOKEN}` is the common case. */
const REF = /\$\{([A-Z][A-Z0-9_]*)\}|\$([A-Z][A-Z0-9_]*)/g

/**
 * Expand `$NAME` references in a string map. Returns the expanded map and the
 * names that could not be resolved — the caller refuses to mount on any missing
 * one, because an MCP server started with an empty token is a server that fails
 * in a way that looks like a bug rather than like a missing secret.
 */
export function expandSecrets(values, env) {
  const expanded = {}
  const missing = []
  for (const [key, value] of Object.entries(values)) {
    let unresolved = false
    const result = value.replace(REF, (_whole, braced, bare) => {
      const name = braced ?? bare
      const resolved = env[name]
      if (resolved === undefined || resolved === '') {
        unresolved = true
        if (!missing.includes(name)) missing.push(name)
        return ''
      }
      return resolved
    })
    if (!unresolved) expanded[key] = result
  }
  return { expanded, missing }
}

/** The mcp-client config for one integration, or null with the reason it cannot be mounted. */
export function mcpConfigFor(integration, env) {
  const base = { serverName: integration.name, transport: integration.transport, toolCallTimeoutMs: integration.toolCallTimeoutMs, failOnStartupError: false }
  if (integration.transport === 'stdio') {
    const { expanded, missing } = expandSecrets(integration.env, env)
    if (missing.length > 0) return { config: null, reason: `missing ${missing.join(', ')} — set it in ~/.sundial/.env` }
    return { config: { ...base, command: integration.command, args: integration.args, env: expanded, cwd: integration.cwd ?? process.cwd() }, reason: null }
  }
  const { expanded, missing } = expandSecrets(integration.headers, env)
  if (missing.length > 0) return { config: null, reason: `missing ${missing.join(', ')} — set it in ~/.sundial/.env` }
  return { config: { ...base, url: integration.url, headers: expanded }, reason: null }
}

/**
 * Mount every enabled integration. Returns the names that came up, for the log
 * and for the gate, which needs to know which servers are Gnomon's.
 *
 * @param ctx the plugin context.
 * @param McpClient the `@deepseek-ai/dsh-mcp-client` namespace.
 * @param integrations the resolved config.
 */
export function mountIntegrations(ctx, McpClient, integrations, { env = { ...readSundialEnvFile(), ...process.env }, log = console.log, warn = console.warn } = {}) {
  // One status per configured integration, mounted or not, WITH the reason —
  // so the UI can show "not mounted: missing OBSIDIAN_API_KEY" rather than the
  // owner having to find it in a log.
  const statuses = []
  for (const integration of integrations) {
    if (!integration.enabled) {
      statuses.push({ name: integration.name, transport: integration.transport, reads: integration.reads, mounted: false, reason: 'disabled in config' })
      continue
    }
    const { config, reason } = mcpConfigFor(integration, env)
    if (config === null) {
      warn(`[sundial-actions] integration ${integration.name} not mounted: ${reason}`)
      statuses.push({ name: integration.name, transport: integration.transport, reads: integration.reads, mounted: false, reason })
      continue
    }
    try {
      ctx.plugin(McpClient, config)
      statuses.push({ name: integration.name, transport: integration.transport, reads: integration.reads, mounted: true, reason: null })
      log(`[sundial-actions] integration ${integration.name} mounted (${integration.transport}${integration.reads.length > 0 ? `, ${integration.reads.length} read pattern${integration.reads.length === 1 ? '' : 's'}` : ''})`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warn(`[sundial-actions] integration ${integration.name} failed to mount: ${message}`)
      statuses.push({ name: integration.name, transport: integration.transport, reads: integration.reads, mounted: false, reason: `failed to mount: ${message}` })
    }
  }
  return statuses
}
