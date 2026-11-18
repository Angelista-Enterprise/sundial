import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readScreenOcrSnapshot, ScreenOcrSensor } from './index.js';

let scratchDir: string;
const ORIGINAL_SUNDIAL_HOME = process.env.SUNDIAL_HOME;
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
    if (ORIGINAL_SUNDIAL_HOME === undefined) delete process.env.SUNDIAL_HOME;
    else process.env.SUNDIAL_HOME = ORIGINAL_SUNDIAL_HOME;
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

  it.runIf(isDarwin)('skips the Passwords app by bundle id when its name is localized', () => {
    writeSidecar({ region: 'focused', processName: 'Wachtwoorden', bundleId: 'com.apple.Passwords', text: 'a saved login', topics: [], captureTimestamp: '2026-07-20T12:00:00.000Z' });
    expect(new ScreenOcrSensor({ enabled: true }).poll()).toEqual([]);
  });

  it.runIf(isDarwin)('skips any capture taken while a secure text field holds the keyboard', () => {
    writeSidecar({ region: 'focused', processName: 'Code', text: 'behind a password prompt', topics: [], captureTimestamp: '2026-07-20T12:00:00.000Z', secureInput: true });
    const sensor = new ScreenOcrSensor({ enabled: true });
    expect(sensor.poll()).toEqual([]);
    expect(sensor.poll()).toEqual([]);
    // Counted once per capture, so the health report shows OCR going dark.
    expect(sensor.secureInputDrops).toEqual({ count: 1, lastAt: '2026-07-20T12:00:00.000Z' });
  });

  it.runIf(isDarwin)('does not re-emit an unchanged (static) screen', () => {
    writeSidecar({ region: 'focused', processName: 'Code', text: 'same text', topics: [], captureTimestamp: '2026-07-20T12:00:00.000Z' });
    const sensor = new ScreenOcrSensor({ enabled: true });
    expect(sensor.poll()).toHaveLength(1);
    expect(sensor.poll()).toEqual([]); // identical text → no re-emit
  });

  it.runIf(isDarwin)('dedupes each region on its own, so alternating captures of a still screen stay quiet', () => {
    const sensor = new ScreenOcrSensor({ enabled: true });
    const poll = (region: string, text: string) => {
      writeSidecar({ region, processName: 'Code', text, topics: [], captureTimestamp: '2026-07-20T12:00:00.000Z' });
      return sensor.poll().length;
    };
    expect([poll('focused', 'the window'), poll('cursor', 'near the cursor'), poll('focused', 'the window'), poll('cursor', 'near the cursor')]).toEqual([1, 1, 0, 0]);
  });
});

describe('accept: own window and slow apps', () => {
  const snap = (processName: string, captureTimestamp: string, text = 'hello world', region = 'cursor') => ({ region, processName, bundleId: null, text, topics: [], captureTimestamp, secureInput: false });
  it("drops Sundial's own window by name or bundle id", () => {
    const s = new ScreenOcrSensor({ enabled: true });
    expect(s.accept(snap('Sundial', '2026-10-14T09:00:00.000Z'))).toBe(false);
    expect(s.accept({ ...snap('Web', '2026-10-14T09:00:01.000Z'), bundleId: 'dev.sundial.daemon' })).toBe(false);
    expect(s.accept(snap('Arc', '2026-10-14T09:00:02.000Z'))).toBe(true);
  });
  it('keeps a slow app once a minute per region, other apps every change', () => {
    const s = new ScreenOcrSensor({ enabled: true, slowApps: ['claude'], slowIntervalMs: 60_000 });
    expect(s.accept(snap('Claude', '2026-10-14T09:00:00.000Z', 'a'))).toBe(true);
    expect(s.accept(snap('Claude', '2026-10-14T09:00:30.000Z', 'b'))).toBe(false);
    expect(s.accept(snap('Claude', '2026-10-14T09:00:30.000Z', 'c', 'focused'))).toBe(true);
    expect(s.accept(snap('Claude', '2026-10-14T09:01:00.000Z', 'd'))).toBe(true);
    expect(s.accept(snap('Arc', '2026-10-14T09:01:01.000Z', 'e'))).toBe(true);
    expect(s.accept(snap('Arc', '2026-10-14T09:01:02.000Z', 'f'))).toBe(true);
  });
});
