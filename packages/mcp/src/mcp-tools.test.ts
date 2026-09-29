import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerTools } from './mcp-tools.js';

describe('the MCP call audit (X2)', () => {
  const original = process.env.SUNDIAL_HOME;
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'sundial-mcp-test-'));
    process.env.SUNDIAL_HOME = home;
    // Never the owner's record, whatever the shell exported.
    process.env.DATABASE_URL = 'file::memory:';
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
    if (original === undefined) delete process.env.SUNDIAL_HOME;
    else process.env.SUNDIAL_HOME = original;
  });

  it('writes one private line per call, naming the tool and never its arguments', async () => {
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    registerTools({ tool: (name: string, _d: string, _s: unknown, handler: (args: unknown) => Promise<unknown>) => handlers.set(name, handler) } as never);
    // A tool that refuses bad arguments still counts as a call, and a failed one.
    await handlers.get('gnomon_moment_detail')!({ momentId: 'made-up-secret-id' }).catch(() => null);

    const file = path.join(home, '.daemon', 'mcp-calls.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: 'gnomon_moment_detail' });
    expect(['ok', 'failed']).toContain(lines[0].outcome);
    expect(JSON.stringify(lines[0])).not.toContain('made-up-secret-id');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
