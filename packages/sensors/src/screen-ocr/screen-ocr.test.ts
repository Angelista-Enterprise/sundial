import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readScreenOcrSnapshot, ScreenOcrSensor } from './index.js';

let scratchDir: string;
const ORIGINAL_GNOMON_DIR = process.env.SUNDIAL_HOME;
const isDarwin = process.platform === 'darwin';

function writeSidecar(obj: Record<string, unknown>): void {
  const daemonDir = path.join(scratchDir, '.daemon');
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.writeFileSync(path.join(daemonDir, 'screen-ocr.json'), JSON.stringify(obj));
}

describe('screen-ocr sensor', () => {
  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnomon-ocr-test-'));
    process.env.SUNDIAL_HOME = scratchDir;
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
    if (ORIGINAL_GNOMON_DIR === undefined) delete process.env.SUNDIAL_HOME;
    else process.env.SUNDIAL_HOME = ORIGINAL_GNOMON_DIR;
  });

  it('readScreenOcrSnapshot returns null when the sidecar is absent', () => {
    expect(readScreenOcrSnapshot()).toBeNull();
  });

  it('readScreenOcrSnapshot parses a fresh sidecar', () => {
    writeSidecar({ region: 'cursor', processName: 'Code', text: 'hello', topics: ['code'], captureTimestamp: '2026-07-20T12:00:00.000Z' });
    const snap = readScreenOcrSnapshot();
    expect(snap).toMatchObject({ region: 'cursor', processName: 'Code', text: 'hello', topics: ['code'] });
  });

  it('a disabled sensor never emits, regardless of platform', () => {
    writeSidecar({ region: 'focused', processName: 'Code', text: 'anything', topics: [], captureTimestamp: '2026-07-20T12:00:00.000Z' });
    expect(new ScreenOcrSensor({ enabled: false }).poll()).toEqual([]);
  });

  it.runIf(isDarwin)('an enabled sensor emits a screen:ocr with the screenText field', () => {
    writeSidecar({ region: 'focused', processName: 'Code', text: 'Clue 5 must see 5 filled cells', topics: ['code'], captureTimestamp: '2026-07-20T12:00:00.000Z' });
    const events = new ScreenOcrSensor({ enabled: true }).poll();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('screen:ocr');
    expect(events[0].payload).toMatchObject({ screenText: 'Clue 5 must see 5 filled cells', processName: 'Code', region: 'focused', topics: ['code'] });
  });

  it.runIf(isDarwin)('skips a capture whose focused app is sensitive (never logged at all)', () => {
    writeSidecar({ region: 'focused', processName: 'Slack', text: 'a private DM', topics: ['chat'], captureTimestamp: '2026-07-20T12:00:00.000Z' });
    expect(new ScreenOcrSensor({ enabled: true }).poll()).toEqual([]);
  });

  it.runIf(isDarwin)('does not re-emit an unchanged (static) screen', () => {
    writeSidecar({ region: 'focused', processName: 'Code', text: 'same text', topics: [], captureTimestamp: '2026-07-20T12:00:00.000Z' });
    const sensor = new ScreenOcrSensor({ enabled: true });
    expect(sensor.poll()).toHaveLength(1);
    expect(sensor.poll()).toEqual([]); // identical text → no re-emit
  });
});
