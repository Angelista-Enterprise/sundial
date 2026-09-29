import { isHiddenProcess, isSensitiveProcess } from '@sundial/helpers/redact/redact-policy.js';
import { readScreenOcrSnapshot, type ScreenOcrSnapshot } from './screen-ocr-capture.js';

export { readScreenOcrSnapshot, type ScreenOcrSnapshot } from './screen-ocr-capture.js';

export interface ScreenOcrEvent {
  type: 'screen:ocr';
  payload: Record<string, unknown>;
}

export interface ScreenOcrSensorConfig {
  enabled?: boolean;
}

/**
 * P7 (docs/design/07) — reads the `screen-ocr.json` sidecar and emits one
 * `screen:ocr` event per fresh capture. Off unless `ocr.enabled` (the owner's
 * config); no-op off darwin. The `screenText` field name is deliberate — it's
 * exactly what `sanitizeAtIngest` clears for a hidden/sensitive app and
 * pattern-redacts otherwise, so OCR text is never a redaction bypass.
 *
 * Two privacy layers before that even matters: (1) the focused app's
 * `processName` rides along so the sanitizer can clear on sensitivity; (2) this
 * sensor drops the capture entirely when the focused app is sensitive/hidden,
 * so such screens are never logged at all. A static screen (identical text to
 * the last emit of the SAME region) is skipped, so a motionless window doesn't
 * spam the log. Per region, because the cursor and focused captures alternate:
 * one shared `lastText` almost never matched.
 */
/**
 * A capture that must never be logged: the focused app is sensitive or hidden
 * by name OR bundle id (a localized name misses; the id does not), or a secure
 * text field holds the keyboard. Secure input is system-wide, so it can be on
 * under another app's name — a password prompt over the focused window is
 * exactly that case, and dropping one capture too many is the cheap side.
 */
export function isPrivateCapture(snapshot: ScreenOcrSnapshot): boolean {
  if (snapshot.secureInput) return true;
  return [snapshot.processName, snapshot.bundleId].some((name) => !!name && (isSensitiveProcess(name) || isHiddenProcess(name)));
}

export class ScreenOcrSensor {
  private readonly enabled: boolean;
  private readonly lastText = new Map<string, string>();
  /**
   * Captures dropped because secure input was on, counted once per capture.
   * Secure Keyboard Entry can stay on for hours and blank all OCR; this is how
   * the sensor health report shows it rather than going quietly dark.
   */
  readonly secureInputDrops = { count: 0, lastAt: null as string | null };

  constructor(config: ScreenOcrSensorConfig = {}) {
    this.enabled = config.enabled === true;
  }

  poll(): ScreenOcrEvent[] {
    if (!this.enabled || process.platform !== 'darwin') return [];
    const snapshot = readScreenOcrSnapshot();
    if (!snapshot) return [];

    if (snapshot.secureInput && snapshot.captureTimestamp !== this.secureInputDrops.lastAt) {
      this.secureInputDrops.count += 1;
      this.secureInputDrops.lastAt = snapshot.captureTimestamp;
    }
    if (isPrivateCapture(snapshot)) return [];

    const text = snapshot.text.trim();
    if (!text || text === this.lastText.get(snapshot.region)) return [];
    this.lastText.set(snapshot.region, text);

    return [
      {
        type: 'screen:ocr',
        payload: {
          timestamp: snapshot.captureTimestamp,
          region: snapshot.region,
          processName: snapshot.processName,
          bundleId: snapshot.bundleId,
          screenText: text,
          lineCount: text.split('\n').length,
          topics: snapshot.topics,
        },
      },
    ];
  }
}
