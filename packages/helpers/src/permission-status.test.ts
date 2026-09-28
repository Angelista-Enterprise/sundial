import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPermissionStatus } from './permission-status.js';

const ORIGINAL_ENV = { ...process.env };
let dir: string;
let runtimeDir: string;

function writeSidecar(name: string, obj: unknown): void {
  fs.writeFileSync(path.join(runtimeDir, name), JSON.stringify(obj));
}

function grantOf(key: string) {
  return getPermissionStatus().find((p) => p.key === key)?.granted;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnomon-perm-'));
  process.env.SUNDIAL_HOME = dir;
  runtimeDir = path.join(dir, '.daemon');
  fs.mkdirSync(runtimeDir, { recursive: true });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('getPermissionStatus', () => {
  it('reports null (unknown) for every permission when no sidecars exist', () => {
    for (const p of getPermissionStatus()) expect(p.granted).toBeNull();
  });

  it('maps a present sidecar with a false grant flag to denied, not unknown', () => {
    writeSidecar('notification-badges.json', { accessGranted: false });
    writeSidecar('input-activity.json', { listenAccessGranted: false });
    writeSidecar('focus-info.json', { assertionsReadable: false });
    writeSidecar('calendar-info.json', { accessGranted: false });
    writeSidecar('location-info.json', { locationServicesGranted: false });
    expect(grantOf('accessibility')).toBe(false);
    expect(grantOf('inputMonitoring')).toBe(false);
    expect(grantOf('fullDiskAccess')).toBe(false);
    expect(grantOf('calendar')).toBe(false);
    expect(grantOf('locationServices')).toBe(false);
  });

  it('maps present sidecars with true grant flags to granted', () => {
    writeSidecar('notification-badges.json', { accessGranted: true });
    writeSidecar('input-activity.json', { listenAccessGranted: true });
    writeSidecar('focus-info.json', { assertionsReadable: true });
    writeSidecar('calendar-info.json', { accessGranted: true });
    writeSidecar('location-info.json', { locationServicesGranted: true });
    expect(grantOf('accessibility')).toBe(true);
    expect(grantOf('inputMonitoring')).toBe(true);
    expect(grantOf('fullDiskAccess')).toBe(true);
    expect(grantOf('calendar')).toBe(true);
    expect(grantOf('locationServices')).toBe(true);
  });

  it('treats a location marker with no usable grant flag as unknown, not denied', () => {
    // The network sensor only writes a decided true/false, but a truncated or
    // hand-edited marker must not read as a denial — that's the freshness
    // conflation this surface exists to prevent.
    writeSidecar('location-info.json', { timestamp: '2026-07-30T06:34:33.665Z' });
    expect(grantOf('locationServices')).toBeNull();
  });

  it('treats a Screen Recording denial note as denied, a cgwindow method as granted, and an accessibility method as unknown', () => {
    writeSidecar('window-info.json', { method: 'cgwindow', diagnostics: { cgwindow: 'grant Screen Recording permission' } });
    expect(grantOf('screenRecording')).toBe(false);

    writeSidecar('window-info.json', { method: 'cgwindow' });
    expect(grantOf('screenRecording')).toBe(true);

    writeSidecar('window-info.json', { method: 'accessibility' });
    expect(grantOf('screenRecording')).toBeNull();
  });

  it("trusts the screen-text helper's own Screen Recording check over the window helper's guess", () => {
    writeSidecar('window-info.json', { method: 'cgwindow' });
    writeSidecar('screen-ocr-status.json', { accessGranted: false });
    expect(grantOf('screenRecording')).toBe(false);
    writeSidecar('screen-ocr-status.json', { accessGranted: true });
    expect(grantOf('screenRecording')).toBe(true);
  });

  it('carries a label and hint for every permission', () => {
    for (const p of getPermissionStatus()) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.hint.length).toBeGreaterThan(0);
    }
  });
});
