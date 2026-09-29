// Hardening S1: a test run never uses the caller's data folder.
import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { testHomes } from '../vitest.config.ts'

describe('vitest data folders (hardening S1)', () => {
  it('this run does not use the owner\'s folders', () => {
    for (const key of ['SUNDIAL_HOME', 'DSH_HOME']) {
      expect(process.env[key]).toBeTruthy()
      expect(process.env[key].startsWith(join(homedir(), '.sundial'))).toBe(false)
      expect(process.env[key].startsWith(join(homedir(), '.dsh'))).toBe(false)
    }
  })

  it('ignores SUNDIAL_HOME and DSH_HOME from the caller and makes fresh temp folders', () => {
    const fake = mkdtempSync(join(tmpdir(), 'mira-'))
    const homes = testHomes({ SUNDIAL_HOME: join(fake, '.sundial'), DSH_HOME: join(fake, '.sundial', 'dsh') }, fake)
    expect(homes.SUNDIAL_HOME).not.toContain(fake)
    expect(homes.DSH_HOME).not.toContain(fake)
    expect(homes.SUNDIAL_HOME).not.toBe(homes.DSH_HOME)
    rmSync(fake, { recursive: true, force: true })
  })

  it('uses SUNDIAL_TEST_HOME when it is named, and refuses the owner\'s own folders', () => {
    const fake = mkdtempSync(join(tmpdir(), 'mira-'))
    const scratch = join(fake, 'scratch')
    mkdirSync(scratch)
    expect(testHomes({ SUNDIAL_TEST_HOME: scratch }, fake).SUNDIAL_HOME).toMatch(/scratch$/)
    mkdirSync(join(fake, '.sundial', 'dsh'), { recursive: true })
    expect(() => testHomes({ SUNDIAL_TEST_HOME: join(fake, '.sundial') }, fake)).toThrow(/live install/)
    expect(() => testHomes({ SUNDIAL_TEST_DSH_HOME: join(fake, '.sundial', 'dsh') }, fake)).toThrow(/live install/)
    expect(() => testHomes({ SUNDIAL_TEST_HOME: join(fake, '.dsh') }, fake)).toThrow(/live install/)
    // A parent of the live folder is refused as well: a test would write into it.
    expect(() => testHomes({ SUNDIAL_TEST_HOME: fake }, fake)).toThrow(/live install/)
    rmSync(fake, { recursive: true, force: true })
  })
})
