import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeHookSensor } from './claude-hooks.js';

const line = (event: string, extra: Record<string, unknown> = {}) => `${JSON.stringify({ ts: '2026-09-28T10:00:00.000Z', event, session: 'abcdef12', cwd: '/Users/o/p', ...extra })}\n`;

describe('ClaudeHookSensor', () => {
  it('tails the hook file from where it stood, whole lines only, and follows a rotation', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-')), 'claude-hooks.jsonl');
    fs.writeFileSync(file, line('SessionStart'));
    const sensor = new ClaudeHookSensor(file);
    expect(sensor.poll()).toEqual([]); // the backlog before boot is not replayed
    fs.appendFileSync(file, line('Notification', { detail: 'permission_prompt', message: 'dropped' }) + '{"ts":"2026-09-28T10:0');
    const [e] = sensor.poll();
    expect(e).toEqual({ type: 'agent:hook', ts: '2026-09-28T10:00:00.000Z', payload: { timestamp: '2026-09-28T10:00:00.000Z', event: 'Notification', session: 'abcdef12', cwd: '/Users/o/p', detail: 'permission_prompt' } });
    fs.appendFileSync(file, `1:00.000Z","event":"Stop","session":"abcdef12"}\n`);
    expect(sensor.poll().map((x) => x.payload.event)).toEqual(['Stop']);
    fs.writeFileSync(file, line('SessionEnd'));
    expect(sensor.poll().map((x) => x.payload.event)).toEqual(['SessionEnd']);
  });

  it('a file that appears after boot is read from its start', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-')), 'claude-hooks.jsonl');
    const sensor = new ClaudeHookSensor(file);
    expect(sensor.poll()).toEqual([]);
    fs.writeFileSync(file, line('Stop'));
    expect(sensor.poll()).toHaveLength(1);
  });
});
