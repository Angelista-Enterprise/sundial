import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultSensor, type VaultEvent } from './index.js';

describe('VaultSensor (J3.5)', () => {
  let dir: string;
  let sensor: VaultSensor | null = null;
  afterEach(() => {
    sensor?.stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('emits the changed .md paths once per debounce, never contents, and skips .obsidian', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnomon-vault-'));
    fs.mkdirSync(path.join(dir, '.obsidian'));
    fs.mkdirSync(path.join(dir, 'Dailies'));
    const events: VaultEvent[] = [];
    sensor = new VaultSensor(dir, (e) => events.push(e), 150);
    expect(sensor.start()).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(path.join(dir, 'Dailies', '2026-09-22.md'), '# secret words');
    fs.writeFileSync(path.join(dir, '.obsidian', 'workspace.md'), 'x');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    await new Promise((r) => setTimeout(r, 600));
    expect(events).toHaveLength(1);
    expect(events[0].payload.notes).toEqual(['Dailies/2026-09-22.md']);
    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it('does not start on a missing directory', () => {
    dir = path.join(os.tmpdir(), `gnomon-vault-missing-${Date.now()}`);
    sensor = new VaultSensor(dir, () => undefined);
    expect(sensor.start()).toBe(false);
  });
});
