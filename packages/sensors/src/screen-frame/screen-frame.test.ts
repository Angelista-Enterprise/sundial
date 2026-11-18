import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScreenOcrSnapshot } from '../screen-ocr/screen-ocr-capture.js';
import { jpegSize, ScreenFrameSensor, type ScreenFrameReadingPayload } from './index.js';

/** The smallest JPEG `jpegSize` reads: SOI, an APP0 segment, a SOF0 with the size. */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

const READING: ScreenFrameReadingPayload = { shows: 'code', showsP: 0.8, meeting: 0.02, error: 0.1, focus: null };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(opts: { size?: [number, number]; snapshot?: Partial<ScreenOcrSnapshot> | null; enabled?: boolean; perHour?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-frame-'));
  dirs.push(dir);
  const framePath = path.join(dir, 'screen-frame.jpg');
  fs.writeFileSync(framePath, jpeg(...(opts.size ?? [768, 480])));
  const mtime = fs.statSync(framePath).mtimeMs;
  // The capture beside the frame, written with it unless a test says otherwise.
  const snapshot = (): ScreenOcrSnapshot | null =>
    opts.snapshot === null ? null : { region: 'focused', processName: 'Code', bundleId: 'com.microsoft.VSCode', text: 'x', topics: [], captureTimestamp: new Date(fs.statSync(framePath).mtimeMs).toISOString(), secureInput: false, ...opts.snapshot };
  const judge = vi.fn(async () => READING);
  const sensor = new ScreenFrameSensor({ enabled: opts.enabled ?? true, perHour: opts.perHour ?? 12, framePath, judge, readSnapshot: snapshot });
  /** The helper wrote a new frame at `ms`. */
  const rewrite = (ms: number) => fs.utimesSync(framePath, new Date(ms), new Date(ms));
  return { sensor, judge, framePath, mtime, rewrite };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('jpegSize', () => {
  it('reads the size from the start-of-frame marker, and refuses what is not a JPEG', () => {
    expect(jpegSize(jpeg(768, 480))).toEqual({ width: 768, height: 480 });
    expect(jpegSize(Buffer.from('not a jpeg at all'))).toBeNull();
  });
});

describe('ScreenFrameSensor', () => {
  it('sends nothing without consent, or off darwin', () => {
    const off = setup({ enabled: false });
    expect(off.sensor.poll(off.mtime, 'darwin')).toEqual([]);
    const linux = setup();
    expect(linux.sensor.poll(linux.mtime, 'linux')).toEqual([]);
    expect(off.judge).not.toHaveBeenCalled();
    expect(linux.judge).not.toHaveBeenCalled();
  });

  it('sends one frame with its capture, and emits only the typed answer', async () => {
    const { sensor, judge, mtime } = setup();
    expect(sensor.poll(mtime, 'darwin')).toEqual([]);
    expect(judge).toHaveBeenCalledTimes(1);
    const [capture, base64] = judge.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(capture).toEqual({ processName: 'Code', bundleId: 'com.microsoft.VSCode', width: 768, height: 480 });
    expect(Buffer.from(base64, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    await flush();
    const [event] = sensor.poll(mtime, 'darwin');
    expect(event!.type).toBe('screen:frame');
    expect(event!.payload).toMatchObject({ processName: 'Code', width: 768, height: 480, ...READING });
    expect(JSON.stringify(event!.payload)).not.toContain(base64.slice(0, 20));
  });

  it('fails closed: no capture beside the frame, a private one, or Sundial\'s own window', () => {
    for (const snapshot of [null, { captureTimestamp: '2020-01-01T00:00:00.000Z' }] as const) {
      const s = setup({ snapshot });
      s.sensor.poll(s.mtime, 'darwin');
      expect(s.judge).not.toHaveBeenCalled();
      expect(s.sensor.skipped.unpaired).toBe(1);
    }
    for (const snapshot of [{ secureInput: true }, { processName: '1Password', bundleId: 'com.1password.1password' }, { processName: 'Sundial', bundleId: 'dev.sundial.daemon' }]) {
      const s = setup({ snapshot });
      s.sensor.poll(s.mtime, 'darwin');
      expect(s.judge, JSON.stringify(snapshot)).not.toHaveBeenCalled();
      expect(s.sensor.skipped.private).toBe(1);
    }
  });

  it('skips a frame Jev would refuse for its size', () => {
    const s = setup({ size: [768, 200] });
    s.sensor.poll(s.mtime, 'darwin');
    expect(s.judge).not.toHaveBeenCalled();
    expect(s.sensor.skipped.size).toBe(1);
  });

  it('keeps to its hourly pace, and never sends the same frame twice', async () => {
    const { sensor, judge, mtime, rewrite } = setup({ perHour: 12 });
    sensor.poll(mtime, 'darwin');
    await flush();
    sensor.poll(mtime + 1000, 'darwin'); // the same file: not again
    rewrite(mtime + 4 * 60_000);
    sensor.poll(mtime + 4 * 60_000, 'darwin'); // a new frame, inside the 5-minute pace
    expect(judge).toHaveBeenCalledTimes(1);
    rewrite(mtime + 6 * 60_000);
    sensor.poll(mtime + 6 * 60_000, 'darwin');
    expect(judge).toHaveBeenCalledTimes(2);
  });
});
