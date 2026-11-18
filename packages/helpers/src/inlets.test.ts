import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inletPayload, readInlets } from './inlets.js';

describe('inlets: declared types and fields only (observatory §4)', () => {
  const inlets = { 'ext:deploy': { fields: { service: 'string' as const, ok: 'boolean' as const, ms: 'number' as const } } };
  it('keeps declared fields of their declared kind and names what it dropped', () => {
    expect(inletPayload('ext:deploy', { service: 'api', ok: true, ms: 120, secret: 'x', ok2: 1 }, inlets)).toEqual({ payload: { service: 'api', ok: true, ms: 120 }, dropped: ['secret', 'ok2'] });
    expect(inletPayload('ext:deploy', { service: 3, ms: Number.NaN }, inlets)).toEqual({ payload: {}, dropped: ['service', 'ms'] });
    expect((inletPayload('ext:deploy', { service: 'y'.repeat(5000) }, inlets) as unknown as { payload: { service: string } }).payload.service).toHaveLength(2000);
  });
  it('refuses an undeclared type, a type outside ext:, and a payload that is not an object', () => {
    expect(inletPayload('ext:other', {}, inlets)).toEqual({ error: expect.stringContaining('not declared') });
    expect(inletPayload('git:commit', {}, inlets)).toEqual({ error: expect.stringContaining('ext:<name>') });
    expect(inletPayload('ext:deploy', [1], inlets)).toEqual({ error: 'the payload is a JSON object' });
  });
  it('reads inlets.json, leaving out what is malformed, and reads no file as none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inlets-'));
    const file = path.join(dir, 'inlets.json');
    expect(readInlets(file)).toEqual({});
    fs.writeFileSync(file, JSON.stringify({ 'ext:deploy': { fields: { service: 'string', bad: 'date', 'no space': 'string' } }, 'git:commit': { fields: { a: 'string' } }, 'ext:x': {} }));
    expect(readInlets(file)).toEqual({ 'ext:deploy': { fields: { service: 'string' } } });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
