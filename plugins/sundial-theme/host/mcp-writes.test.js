// The MCP server's request files, applied with the routes' own handlers and never twice.
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { consumeMcpWrites } from './mcp-writes.js'

describe('consumeMcpWrites', () => {
  it('hands each whole request to its handler, in order, deletes it, and skips the rest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-writes-'))
    writeFileSync(join(dir, '1-a.json'), JSON.stringify({ write: 'feedback', at: 'x', body: { seen: true, artifactKind: 'notice', artifactId: 'k1' } }))
    writeFileSync(join(dir, '2-b.json'), JSON.stringify({ write: 'assert', at: 'x', body: { entityKind: 'tool', canonicalName: 'Xcode', predicate: 'is', object: 'an IDE' } }))
    writeFileSync(join(dir, '3-c.json'), JSON.stringify({ write: 'rm-rf', body: {} }))
    writeFileSync(join(dir, '4-d.json'), 'not json')
    writeFileSync(join(dir, '.5-e.json'), JSON.stringify({ write: 'feedback', body: { half: true } }))
    const calls = []
    const handlers = { feedback: vi.fn(async (b) => calls.push(['feedback', b])), assert: vi.fn(async (b) => { calls.push(['assert', b]); return 'refused' }) }
    const warn = vi.fn()
    const close = consumeMcpWrites(dir, handlers, warn)
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    close()
    expect(calls.map(([w]) => w)).toEqual(['feedback', 'assert'])
    expect(calls[0][1]).toEqual({ seen: true, artifactKind: 'notice', artifactId: 'k1' })
    expect(readdirSync(dir)).toEqual(['.5-e.json'])
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[sundial-shell] mcp assert refused: refused'))
    expect(warn.mock.calls.filter(([m]) => m.includes('not a known write'))).toHaveLength(2)
  })
})
