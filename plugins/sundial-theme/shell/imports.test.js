// @vitest-environment jsdom
// The client has no build step, so a module that imports a name another no
// longer exports shows up only as a blank page. This loads every module in
// shell/ the way the browser would, so that failure is a red test instead.
// The two page entry points boot against their page's DOM on load, so they are
// not loaded; every module's named imports are checked against what each target exports.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MODULES = readdirSync(HERE).filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))
const ENTRIES = new Set(['app.js', 'setup.js'])

describe('shell imports', () => {
  it.each(MODULES.filter((name) => !ENTRIES.has(name)))('%s loads', async (name) => {
    await expect(import(`./${name}`)).resolves.toBeTypeOf('object')
  })

  // Every module, not only the entries: the test runner's module transform turns a missing named
  // import into `undefined` instead of the link error the browser raises, so loading is not enough.
  it.each(MODULES)('%s names only what its imports export', async (name) => {
    const source = readFileSync(join(HERE, name), 'utf8')
    const missing = []
    for (const [, names, from] of source.matchAll(/^(?:import|export)\s*\{([^}]*)\}\s*from\s*'([^']+)'/gm)) {
      const target = await import(from.startsWith('.') ? `./${from.slice(2)}` : from)
      for (const n of names.split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)) if (!(n in target)) missing.push(`${n} from ${from}`)
    }
    expect(missing).toEqual([])
  })
})
