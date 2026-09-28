import crypto from 'node:crypto';
import { classifyClipboardContent, readClipboardText } from './clipboard-meta-capture.js';

export interface ClipboardMetaEvent {
  type: 'clipboard:activity';
  payload: Record<string, unknown>;
}

const POLL_INTERVAL_MS = 5_000;

/**
 * Opt-in by default (`enabled: false`) — matches WCS's default exactly.
 * No config-loading mechanism exists yet for this in Gnomon (same gap as
 * `NotificationSensor`'s allowlist, Wave 3b); a constructor param stands in.
 */
export class ClipboardMetaSensor {
  private readonly enabled: boolean;
  private lastHash: string | null = null;
  private lastCheckedAt = 0;

  constructor(enabled = false) {
    this.enabled = enabled;
  }

  async poll(): Promise<ClipboardMetaEvent | null> {
    if (!this.enabled || process.platform !== 'darwin') return null;
    const now = Date.now();
    if (now - this.lastCheckedAt < POLL_INTERVAL_MS) return null;
    this.lastCheckedAt = now;

    const text = await readClipboardText();
    if (text == null) return null;

    const hash = crypto.createHash('sha256').update(text).digest('hex');
    if (hash === this.lastHash) return null;
    this.lastHash = hash;
    if (text.length === 0) return null; // empty clipboard — don't emit

    return {
      type: 'clipboard:activity',
      payload: { timestamp: new Date().toISOString(), type: classifyClipboardContent(text), sizeBytes: Buffer.byteLength(text, 'utf-8') },
    };
  }
}
