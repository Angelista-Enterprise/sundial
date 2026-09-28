import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyTail, readAgentFleet } from './agent-fleet.js';

const rec = (type: string, ts: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type, timestamp: ts, cwd: '/Users/o/p', gitBranch: 'main', ...extra });
const prompt = (ts: string) => rec('user', ts, { message: { role: 'user', content: 'secret words' } });
const result = (ts: string) => rec('user', ts, { message: { content: [{ type: 'tool_result', content: 'x' }] } });
const said = (ts: string, stop: string | null) => rec('assistant', ts, { message: { stop_reason: stop, content: [{ type: 'text', text: 'secret' }] } });

describe('classifyTail', () => {
  it('an ended turn is waiting, since the answer', () => {
    expect(classifyTail([prompt('t1'), said('t2', 'tool_use'), result('t3'), said('t4', 'end_turn')])).toEqual({ cwd: '/Users/o/p', branch: 'main', state: 'waiting', since: 't4' });
  });
  it('a tool call with no result is tool, since the call', () => {
    expect(classifyTail([prompt('t1'), said('t2', 'tool_use')])?.state).toBe('tool');
  });
  it('mid-turn is working, since the owner\'s prompt — a tool result is not a prompt', () => {
    expect(classifyTail([prompt('t1'), said('t2', 'tool_use'), result('t3')])).toMatchObject({ state: 'working', since: 't1' });
  });
  it('skips sidechains and other record types, and copies no text', () => {
    const out = classifyTail([prompt('t1'), said('t2', 'end_turn'), rec('assistant', 't3', { isSidechain: true, message: { stop_reason: 'tool_use' } }), rec('attachment', 't4')]);
    expect(out?.state).toBe('waiting');
    expect(JSON.stringify(out)).not.toContain('secret');
  });
});

describe('readAgentFleet', () => {
  it('reads recent transcripts, skips Gnomon\'s own hands and cold files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-'));
    const write = (dir: string, name: string, lines: string[], ageMs = 0) => {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      const file = path.join(root, dir, name);
      fs.writeFileSync(file, lines.join('\n') + '\n');
      const t = (Date.now() - ageMs) / 1000;
      fs.utimesSync(file, t, t);
    };
    write('a', 'abcdef123456.jsonl', [prompt('t1'), said('t2', 'end_turn')]);
    write('h', 'hand.jsonl', [rec('assistant', 't2', { cwd: '/Users/o/.sundial/.daemon/hands', message: { stop_reason: 'end_turn' } })]);
    write('c', 'cold.jsonl', [prompt('t1')], 7 * 3600_000);
    expect(readAgentFleet(Date.now(), root)).toEqual([{ id: 'abcdef12', cwd: '/Users/o/p', branch: 'main', state: 'waiting', since: 't2' }]);
  });
});
