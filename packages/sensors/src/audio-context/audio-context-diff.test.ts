import { describe, it, expect } from 'vitest';
import { mediaStateFromSnapshot } from './index.js';
import type { AvSnapshot } from './audio-context-capture.js';

function snapshot(overrides: Partial<AvSnapshot> = {}): AvSnapshot {
  return { microphoneActive: false, cameraActive: false, audioInputProcesses: [], audioOutputProcesses: [], cameraProcesses: [], ...overrides };
}

const zoom = { pid: 501, processName: 'Zoom' };
const music = { pid: 502, processName: 'Music' };

/**
 * These replace a lifecycle-diff suite that tested `start`/`end` emission from a
 * per-pid `Map` held on the sensor instance. That design is gone, because a restart
 * discarded the map and the `end` for a live span was then never emitted at all —
 * 161 microphone starts against 131 ends over three weeks, with one resulting
 * unclosed span holding 36% of all recorded microphone time.
 *
 * The sensor now reports the current state and the kernel deduplicates against
 * snapshotted state, so there is no per-instance memory left to lose.
 */
describe('mediaStateFromSnapshot', () => {
  it('reports nothing active for an idle machine', () => {
    expect(mediaStateFromSnapshot(snapshot())).toEqual({
      audioInput: false,
      audioOutput: false,
      camera: false,
      audioInputProcess: null,
      audioOutputProcess: null,
      cameraProcess: null,
    });
  });

  it('reports the microphone and attributes it', () => {
    const state = mediaStateFromSnapshot(snapshot({ audioInputProcesses: [zoom] }));
    expect(state.audioInput).toBe(true);
    expect(state.audioInputProcess).toBe('Zoom');
  });

  it('tracks input and output independently', () => {
    const state = mediaStateFromSnapshot(snapshot({ audioInputProcesses: [zoom], audioOutputProcesses: [music] }));
    expect(state).toMatchObject({ audioInput: true, audioOutput: true, audioInputProcess: 'Zoom', audioOutputProcess: 'Music' });
  });

  /**
   * On Apple Silicon the camera daemon mediates access over IPC, so an `lsof`-based
   * scan finds no process even while the camera is on. The boolean is still reliable
   * via the daemon's CPU usage, so "on, by nobody I can name" has to be
   * representable — the previous version invented a `pid: 0` placeholder process for
   * this, which made the attribution look more certain than it was.
   */
  it('reports an active camera with no attributable process', () => {
    const state = mediaStateFromSnapshot(snapshot({ cameraActive: true }));
    expect(state.camera).toBe(true);
    expect(state.cameraProcess).toBeNull();
  });

  it('prefers a real camera process when one is visible', () => {
    const state = mediaStateFromSnapshot(snapshot({ cameraProcesses: [zoom], cameraActive: false }));
    expect(state.camera).toBe(true);
    expect(state.cameraProcess).toBe('Zoom');
  });

  /**
   * The property that fixes the lost-`end` defect: the answer depends only on the
   * snapshot, so a restart cannot change it. An unchanged sample is dropped by the
   * ingest gate and the span continues, instead of being re-opened and orphaned.
   */
  it('carries no memory between calls, so a restart has nothing to lose', () => {
    const active = mediaStateFromSnapshot(snapshot({ audioInputProcesses: [zoom] }));
    const idle = mediaStateFromSnapshot(snapshot());
    // Re-evaluated in the opposite order, the answers are unchanged.
    expect(mediaStateFromSnapshot(snapshot())).toEqual(idle);
    expect(mediaStateFromSnapshot(snapshot({ audioInputProcesses: [zoom] }))).toEqual(active);
  });

  it('distinguishes one app handing the microphone to another', () => {
    expect(mediaStateFromSnapshot(snapshot({ audioInputProcesses: [zoom] }))).not.toEqual(mediaStateFromSnapshot(snapshot({ audioInputProcesses: [music] })));
  });
});
