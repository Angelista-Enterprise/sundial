// lane H (H5)
import { describe, expect, it } from 'vitest';
import { stampConsole } from './log-stamp.js';

describe('stampConsole', () => {
  it('prefixes each line with its ISO time, once, and keeps format strings working', () => {
    const lines: unknown[][] = [];
    const fake = { log: (...a: unknown[]) => lines.push(a), info: () => {}, warn: (...a: unknown[]) => lines.push(a), error: () => {}, debug: () => {} } as unknown as Console;
    const now = () => new Date('2026-09-01T09:00:00.000Z');
    stampConsole(fake, now);
    stampConsole(fake, now);
    fake.log('[sundial-kernel] %s ready', 'x');
    fake.warn({ a: 1 });
    expect(lines).toEqual([['2026-09-01T09:00:00.000Z [sundial-kernel] %s ready', 'x'], ['2026-09-01T09:00:00.000Z', { a: 1 }]]);
  });
});
