// The bench clock hold (lab/bench/longmemeval): no wall-clock tick on the bench install while its marker holds the clock,
// and the owner's clock ticks whatever a marker says. Made-up folders only.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BENCH_LABEL, benchSetup } from '@sundial/helpers/bench-guard.js'
import { tickUnlessHeld } from './index.js'

/** A made-up user home with an install in `dir`, its install marker under `label`, and a bench marker. */
function homeWith(dir, label, marker) {
  const home = mkdtempSync(join(tmpdir(), 'bench-clock-'))
  const at = join(home, dir)
  mkdirSync(at)
  writeFileSync(join(at, '.sundial-install.json'), JSON.stringify({ tool: 'sundial', home: at, label }))
  writeFileSync(join(at, 'bench.json'), JSON.stringify({ bench: true, home: at, label, ...marker }))
  return { home, at }
}
const runtime = () => ({ tickClock: vi.fn(async () => {}) })
const setupOf = (env, home) => () => benchSetup({ env, home })

describe('tickUnlessHeld', () => {
  it('holds the clock on the bench install when its marker says so', async () => {
    const { home, at } = homeWith('.sundial-bench', BENCH_LABEL, { holdClock: true })
    const r = runtime()
    expect(await tickUnlessHeld(r, setupOf({ SUNDIAL_LABEL: BENCH_LABEL, SUNDIAL_HOME: at }, home))).toBe(false)
    expect(r.tickClock).not.toHaveBeenCalled()
  })

  it('ticks on the bench install when the marker does not hold it', async () => {
    const { home, at } = homeWith('.sundial-bench', BENCH_LABEL, { holdClock: false })
    const r = runtime()
    expect(await tickUnlessHeld(r, setupOf({ SUNDIAL_LABEL: BENCH_LABEL, SUNDIAL_HOME: at }, home))).toBe(true)
    expect(r.tickClock).toHaveBeenCalledTimes(1)
  })

  it("ticks on the owner's install, even with a marker that holds the clock in its home", async () => {
    const owner = homeWith('.sundial', 'dev.sundial.daemon', { holdClock: true })
    const r = runtime()
    expect(await tickUnlessHeld(r, setupOf({ SUNDIAL_LABEL: 'dev.sundial.daemon', SUNDIAL_HOME: owner.at }, owner.home))).toBe(true)
    // The bench label set by hand on the owner's home is still the owner's home.
    expect(await tickUnlessHeld(r, setupOf({ SUNDIAL_LABEL: BENCH_LABEL, SUNDIAL_HOME: owner.at }, owner.home))).toBe(true)
    // No env at all (the default install): the clock ticks.
    expect(await tickUnlessHeld(r, setupOf({}, owner.home))).toBe(true)
    expect(r.tickClock).toHaveBeenCalledTimes(3)
  })

  it('ticks under the real default probe in a test run (this process is not the bench)', async () => {
    const r = runtime()
    expect(await tickUnlessHeld(r)).toBe(true)
  })
})
