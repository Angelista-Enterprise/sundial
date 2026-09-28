import { isHiddenProcess, isSensitiveProcess } from '@sundial/helpers/redact/redact-policy.js';
import { readScreenOcrSnapshot } from './screen-ocr-capture.js';

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
 * the last emit) is skipped, so a motionless window doesn't spam the log.
 */
export class ScreenOcrSensor {
  private readonly enabled: boolean;
  private lastText: string | null = null;

  constructor(config: ScreenOcrSensorConfig = {}) {
    this.enabled = config.enabled === true;
  }

  poll(): ScreenOcrEvent[] {
    if (!this.enabled || process.platform !== 'darwin') return [];
    const snapshot = readScreenOcrSnapshot();
    if (!snapshot) return [];

    if (snapshot.processName && (isSensitiveProcess(snapshot.processName) || isHiddenProcess(snapshot.processName))) return [];

    const text = snapshot.text.trim();
    if (!text || text === this.lastText) return [];
    this.lastText = text;

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
