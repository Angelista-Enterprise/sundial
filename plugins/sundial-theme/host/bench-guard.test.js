// The bench identity guard (docs/release/27 section 4): a bench answer only on the bench install. Made-up folders only.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BENCH_LABEL, benchRefusal } from './bench-guard.js'

/** A made-up user home with a bench install in it, markers and all. */
function benchHome({ installLabel = BENCH_LABEL, benchMarker = true, markerHome } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bench-guard-'))
  const bench = join(home, '.sundial-bench')
  mkdirSync(bench)
  writeFileSync(join(bench, '.sundial-install.json'), JSON.stringify({ tool: 'sundial', home: markerHome ?? bench, label: installLabel, installId: 'x' }))
  if (benchMarker) writeFileSync(join(bench, 'bench.json'), JSON.stringify({ bench: true, home: markerHome ?? bench, label: BENCH_LABEL }))
  return { home, bench }
}

describe('benchRefusal', () => {
  it('takes a bench answer on the bench install', () => {
    const { home, bench } = benchHome()
    expect(benchRefusal({ env: { SUNDIAL_LABEL: BENCH_LABEL, SUNDIAL_HOME: bench }, home })).toBeNull()
  })

  it("refuses on the owner's install: its label, its home", () => {
    const { home } = benchHome()
    mkdirSync(join(home, '.sundial'))
    expect(benchRefusal({ env: { SUNDIAL_LABEL: 'dev.sundial.agent', SUNDIAL_HOME: join(home, '.sundial') }, home })).toMatch(/not dev\.sundial\.bench/)
    expect(benchRefusal({ env: { SUNDIAL_HOME: join(home, '.sundial') }, home })).toMatch(/default label/)
    // The bench label set by hand on the owner's home is still the owner's home.
    expect(benchRefusal({ env: { SUNDIAL_LABEL: BENCH_LABEL, SUNDIAL_HOME: join(home, '.sundial') }, home })).toMatch(/owner's ~\/\.sundial/)
  })

  it("refuses a bench folder that is a link to the owner's home", () => {
    const home = mkdtempSync(join(tmpdir(), 'bench-guard-'))
    mkdirSync(join(home, '.sundial'))
    symlinkSync(join(home, '.sundial'), join(home, '.sundial-bench'))
    expect(benchRefusal({ env: { SUNDIAL_LABEL: BENCH_LABEL, SUNDIAL_HOME: join(home, '.sundial-bench') }, home })).toMatch(/owner's/)
  })

  it('refuses a test install, an unnamed home, any other folder', () => {
    const { home } = benchHome()
    expect(benchRefusal({ env: { SUNDIAL_LABEL: 'dev.sundial.test', SUNDIAL_HOME: join(home, '.sundial-test') }, home })).toMatch(/not dev\.sundial\.bench/)
    expect(benchRefusal({ env: { SUNDIAL_LABEL: BENCH_LABEL }, home })).toMatch(/no SUNDIAL_HOME/)
    expect(benchRefusal({ env: { SUNDIAL_LABEL: BENCH_LABEL, SUNDIAL_HOME: join(home, 'elsewhere') }, home })).toMatch(/not ~\/\.sundial-bench/)
  })

  it('refuses without both markers naming the bench', () => {
    const noBench = benchHome({ benchMarker: false })
    expect(benchRefusal({ env: { SUNDIAL_LABEL: BENCH_LABEL, SUNDIAL_HOME: noBench.bench }, home: noBench.home })).toMatch(/no bench marker/)
    const wrongLabel = benchHome({ installLabel: 'dev.sundial.agent' })
    expect(benchRefusal({ env: { SUNDIAL_LABEL: BENCH_LABEL, SUNDIAL_HOME: wrongLabel.bench }, home: wrongLabel.home })).toMatch(/install marker/)
    const wrongHome = benchHome({ markerHome: '/elsewhere' })
    expect(benchRefusal({ env: { SUNDIAL_LABEL: BENCH_LABEL, SUNDIAL_HOME: wrongHome.bench }, home: wrongHome.home })).toMatch(/install marker/)
  })
})
