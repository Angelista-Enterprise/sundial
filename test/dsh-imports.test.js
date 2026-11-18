// The dsh plugins Sundial needs must import from where dsh loads them: dsh-base's own folder.
// On 2026-10-06 a re-resolved lockfile (the safe-chain pnpm wrapper, see apps/harness/DSH_VERSION.md)
// linked dsh-bash-sandbox 0.2 to dsh-sandbox 0.1.5. Every test passed while the live app lost its
// shell, then sundial-actions, then the theme, and dsh's own page answered `/`.
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = fs.realpathSync(path.join(fs.realpathSync(path.join(REPO, 'apps/harness/node_modules/@deepseek-ai/dsh')), '..', 'dsh-base'))
const NEEDED = ['dsh-bash-sandbox', 'dsh-permission-presets', 'dsh-ptc-runtime-node', 'dsh-llm-deepseek-account']

describe('the dsh plugins Sundial needs', () => {
  it.each(NEEDED)('%s imports from dsh-base', (name) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import('@deepseek-ai/${name}')`], { cwd: BASE, encoding: 'utf8', timeout: 60_000 })
    expect(r.stderr.split('\n').find((l) => /Error/.test(l)) ?? '').toBe('')
    expect(r.status).toBe(0)
  })
})
