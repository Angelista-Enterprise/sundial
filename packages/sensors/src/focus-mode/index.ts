import { readFocusModeSidecar } from './focus-mode-capture.js';

export interface FocusModeEvent {
  type: 'focus-mode:changed';
  payload: Record<string, unknown>;
}

function focusModeKey(snapshot: { state: string; name?: string; modeIdentifier?: string }): string {
  return `${snapshot.state}|${snapshot.name ?? ''}|${snapshot.modeIdentifier ?? ''}`;
}

/** Emits only on state/name/modeIdentifier change — the reference pattern sleep-wake's fix (Wave 3e) copies. */
export class FocusModeSensor {
  private lastKey: string | null = null;

  poll(): FocusModeEvent | null {
    const snapshot = readFocusModeSidecar();
    if (!snapshot) return null;

    const key = focusModeKey(snapshot);
    if (key === this.lastKey) return null;
    this.lastKey = key;

    return {
      type: 'focus-mode:changed',
      payload: { timestamp: new Date().toISOString(), state: snapshot.state, name: snapshot.name, modeIdentifier: snapshot.modeIdentifier },
    };
  }
}
