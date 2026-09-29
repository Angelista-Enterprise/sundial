// lane H
import { describe, expect, it } from 'vitest';
import { healthSignal, type HealthSignalInputs, type SensorHealth } from './sensor-health.js';

const health: SensorHealth = {
  permissions: [],
  sidecars: [
    { label: 'window', status: 'stale', ageMs: 60_000, permissionReason: null, heartbeat: true },
    { label: 'screen-ocr', status: 'ok', ageMs: 9_000_000, permissionReason: null, heartbeat: false },
    { label: 'calendar', status: 'idle', ageMs: null, permissionReason: null, heartbeat: false },
    { label: 'notifications', status: 'ok', ageMs: 1_000, permissionReason: null, heartbeat: true },
  ],
};
const inputs = (over: Partial<HealthSignalInputs> = {}): HealthSignalInputs => ({ health, hearing: true, audio: { state: 'listening' }, transcriptMtimeMs: null, ocr: true, ocrAccessGranted: true, configUnreadable: false, nativeHelpers: true, ...over });

describe('healthSignal', () => {
  it('judges only heartbeat sidecars and carries no ages, so it dedupes', () => {
    const p = healthSignal(inputs());
    expect(p.sidecars).toEqual({ window: 'stale', notifications: 'ok' });
    expect(JSON.stringify(p)).not.toMatch(/ageMs/);
  });

  it('judges nothing where no Swift helpers run', () => {
    expect(healthSignal(inputs({ nativeHelpers: false }))).toMatchObject({ sidecars: {}, microphone: null, screenRecording: null });
  });

  it('reports the microphone only while hearing is on, and a transcribe failure only until a transcript follows it', () => {
    expect(healthSignal(inputs({ hearing: false })).microphone).toBeNull();
    const failedAt = '2026-09-01T09:00:00.000Z';
    expect(healthSignal(inputs({ audio: { state: 'transcribe-failed', at: failedAt }, transcriptMtimeMs: Date.parse(failedAt) - 1000 })).microphone).toBe('transcribe-failed');
    expect(healthSignal(inputs({ audio: { state: 'transcribe-failed', at: failedAt }, transcriptMtimeMs: Date.parse(failedAt) + 1000 })).microphone).toBe('listening');
  });
});
