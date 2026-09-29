// Hardening F2: a tripwire on the dsh seam that already cost a hung approval.
// dsh-api-remotes forwards every `waterfall` event in its allowlist to a remote
// client, and dsh's own client is dark here, so a waterfall event nobody claims
// first waits forever. Each one needs a `{ prepend: true }` listener in
// server.js. A dsh upgrade that adds a waterfall event fails this test.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

async function forwardedEvents() {
  // Not a dependency of this plugin: reached the way the harness reaches it, through dsh.
  const fromHarness = createRequire(join(HERE, '../../../apps/harness/package.json'))
  const fromDsh = createRequire(fromHarness.resolve('@deepseek-ai/dsh/package.json'))
  return (await import(fromDsh.resolve('@deepseek-ai/dsh-api-remotes'))).API_REMOTE_FORWARDED_EVENTS
}

describe('dsh forwarded waterfall events', () => {
  it('each one has a prepended listener in shell/server.js', async () => {
    const waterfalls = (await forwardedEvents()).filter((e) => e.mode === 'waterfall').map((e) => e.event)
    expect(waterfalls.length).toBeGreaterThan(0)
    const calls = readFileSync(join(HERE, 'server.js'), 'utf8').split('ctx.on(').slice(1)
    const prepended = (event) => calls.some((c) => c.trimStart().startsWith(`'${event}'`) && /\{\s*prepend:\s*true\s*\}\s*,?\s*\)/.test(c))
    expect(waterfalls.filter((e) => !prepended(e))).toEqual([])
  })
})
