// Set 3 R3: the gate's parts are modules of their own. The gate imports them; none of them imports the gate back.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as gate from './gate.js'
import * as finals from './gate-finals.js'
import * as shell from './gate-shell.js'
import { GNOMON_TOOLS } from './gate-tools.js'

const source = (name) => readFileSync(new URL(name, import.meta.url), 'utf8')

describe('the gate split', () => {
  it('no part imports the gate, and run-shell.js reads the parts, not the gate', () => {
    for (const part of ['gate-finals.js', 'gate-shell.js', 'gate-tools.js', 'run-shell.js']) expect(source(part), part).not.toMatch(/from '\.\/gate\.js'/)
  })

  it('the parts hold no em dash (the owner\'s rule): a comma, a colon or a period instead', () => {
    for (const part of ['gate.js', 'gate-finals.js', 'gate-shell.js', 'gate-tools.js', 'call-chat.js']) expect(source(part), part).not.toContain('\u2014')
  })

  it('the gate re-exports each part as the same function', () => {
    for (const name of ['finalOf', 'finalAsk', 'mailOf', 'privateApp', 'privateOf', 'stepList', 'keyboardLook']) expect(gate[name], name).toBe(finals[name])
    for (const name of ['shellWords', 'touchesOf', 'touchesLine', 'commandLine', 'shellWrite', 'SHELL_SYNTAX']) expect(gate[name], name).toBe(shell[name])
    expect(gate.GNOMON_TOOLS).toBe(GNOMON_TOOLS)
  })

  it('the one shell tool the table marks is read as a shell by the finals', () => {
    const shells = Object.keys(GNOMON_TOOLS).filter((t) => GNOMON_TOOLS[t].shell === true)
    expect(shells).toEqual(['gnomon_run_shell'])
    expect(finals.finalOf('gnomon_run_shell', { command: 'rm /tmp/gnomon-1/a.log' })).toEqual({ kind: 'delete', via: 'shell', blind: false })
  })
})
