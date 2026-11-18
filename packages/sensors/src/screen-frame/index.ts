import fs from 'node:fs';
import path from 'node:path';
import { getSundialHome } from '@sundial/helpers/config.js';
import { readScreenOcrSnapshot, type ScreenOcrSnapshot } from '../screen-ocr/screen-ocr-capture.js';
import { isOwnWindow, isPrivateCapture } from '../screen-ocr/index.js';

/**
 * The screen as a PICTURE, read by Jev (`ocr.jev.frames`, off unless the owner
 * turns it on). The OCR helper writes a downscaled JPEG of the window in front
 * (`screen-frame.jpg`, ≤ 768 px) at each full capture; this sensor sends it to
 * Jev at most `perHour` times an hour and emits `screen:frame`: a fixed label,
 * three probabilities and a region. No pixel and no text reaches the log.
 *
 * Fails closed, like the hearing helper: a frame goes only when the capture
 * beside it (written within `PAIR_MS`) names the app and could itself be
 * logged: not a secure-input capture, not a sensitive or hidden app, not
 * Sundial's own window. No capture, a stale one, or a stale frame: nothing.
 * The call is the kernel's `judgeNow` (budget purpose `frame`, audited, Jev
 * only), injected so this package needs no model package.
 */
export interface ScreenFrameReadingPayload {
  shows: string | null;
  showsP: number | null;
  meeting: number | null;
  error: number | null;
  focus: { x: number; y: number; w: number; h: number } | null;
}

export interface ScreenFrameEvent {
  type: 'screen:frame';
  payload: { timestamp: string; processName: string; bundleId: string | null; width: number; height: number; latencyMs: number } & ScreenFrameReadingPayload;
}

export interface ScreenFrameConfig {
  enabled: boolean;
  perHour: number;
  framePath?: string;
  /** The frame to Jev: `judgeNow` with the frame as an image asset. Null when refused (budget, breaker, off-Jev) or failed. */
  judge?: (capture: { processName: string; bundleId: string | null; width: number; height: number }, jpegBase64: string) => Promise<ScreenFrameReadingPayload | null>;
  /** Injectable for tests; defaults to the OCR sidecar's file. */
  readSnapshot?: () => ScreenOcrSnapshot | null;
}

/** Jev takes 280..1568 px a side. */
export const FRAME_MIN_SIDE = 280;
export const FRAME_MAX_SIDE = 1568;
/** The frame and the capture that vouches for it are written in one helper task; further apart, they may not be the same window. */
const PAIR_MS = 4_000;
/** A frame older than this is a helper that stopped writing. */
const FRESH_MS = 15_000;

/** Width and height from a JPEG's start-of-frame marker, or null for anything else. */
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC), carry the size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

export class ScreenFrameSensor {
  private lastAt = 0;
  private lastMtimeMs = 0;
  private inFlight = false;
  private buffered: ScreenFrameEvent[] = [];
  private readonly framePath: string;
  private readonly readSnapshot: () => ScreenOcrSnapshot | null;
  /** Frames not sent, by reason, for the health report: a consent that sends nothing should say why. */
  readonly skipped = { unpaired: 0, private: 0, size: 0 };

  constructor(private readonly config: ScreenFrameConfig) {
    this.framePath = config.framePath ?? path.join(getSundialHome(), '.daemon', 'screen-frame.jpg');
    this.readSnapshot = config.readSnapshot ?? readScreenOcrSnapshot;
  }

  /** Emits what the last call produced; starts the next when due. Never blocks the poll. */
  poll(now = Date.now(), platform: string = process.platform): ScreenFrameEvent[] {
    const out = this.buffered;
    this.buffered = [];
    if (!this.config.enabled || !this.config.judge || platform !== 'darwin' || this.inFlight) return out;
    if (now - this.lastAt < 3_600_000 / Math.max(1, this.config.perHour)) return out;
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(this.framePath).mtimeMs;
    } catch {
      return out;
    }
    if (mtimeMs === this.lastMtimeMs || now - mtimeMs > FRESH_MS) return out;
    this.lastMtimeMs = mtimeMs;
    const capture = this.readSnapshot();
    if (!capture || Math.abs(Date.parse(capture.captureTimestamp) - mtimeMs) > PAIR_MS) {
      this.skipped.unpaired += 1;
      return out;
    }
    if (isPrivateCapture(capture) || isOwnWindow(capture)) {
      this.skipped.private += 1;
      return out;
    }
    const jpeg = fs.readFileSync(this.framePath);
    const size = jpegSize(jpeg);
    if (!size || Math.min(size.width, size.height) < FRAME_MIN_SIDE || Math.max(size.width, size.height) > FRAME_MAX_SIDE) {
      this.skipped.size += 1;
      return out;
    }
    this.lastAt = now;
    this.inFlight = true;
    const started = Date.now();
    const who = { processName: capture.processName, bundleId: capture.bundleId };
    const timestamp = capture.captureTimestamp;
    void this.config
      .judge({ ...who, ...size }, jpeg.toString('base64'))
      .then((reading) => {
        if (reading) this.buffered.push({ type: 'screen:frame', payload: { timestamp, ...who, ...size, latencyMs: Date.now() - started, ...reading } });
      })
      .catch((error) => console.warn('[screen-frame] judge failed:', error instanceof Error ? error.message : error))
      .finally(() => {
        this.inFlight = false;
      });
    return out;
  }
}
