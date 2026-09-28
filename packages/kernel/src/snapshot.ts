import { getLatestSnapshot, getSignalsAfter, insertSnapshot, type StoredSignal } from '@sundial/db/index.js';
import { createEventId } from '@sundial/helpers/event-id.js';
import { hydrateSnapshot } from './initial-state.js';
import type { KernelState, SanitizedEvent } from './types.js';

function toSanitizedEvent(row: StoredSignal): SanitizedEvent {
  return {
    id: row.id,
    type: `${row.signalType}:${row.eventType}`,
    ts: row.capturedAt,
    payload: row.data,
    sanitized: true,
  };
}

export async function writeSnapshot(state: KernelState, logOffset: string): Promise<void> {
  await insertSnapshot({ id: createEventId(), stateJson: JSON.stringify(state), logOffset });
}

export interface LoadedSnapshot {
  state: KernelState;
  logOffset: string;
}

/**
 * Hydrates through `hydrateSnapshot` rather than a raw `JSON.parse(...) as
 * KernelState` cast — found missing during Phase 6 live verification: a
 * snapshot written before a phase adds a new top-level `KernelState` field
 * (here, Phase 5's `retention`) genuinely lacks that key, and every caller
 * of this function (not just the daemon's own boot path, which already
 * called `hydrateSnapshot` separately) needs the same backfill, including
 * CLI commands like `gnomon status` that read a snapshot without ever
 * folding it through `reduce()`. `device.id` comes from the persisted
 * state itself — a snapshot always has one, from whatever process wrote it.
 */
export async function loadLatestSnapshot(): Promise<LoadedSnapshot | null> {
  const row = await getLatestSnapshot();
  if (!row) return null;
  const persisted = JSON.parse(row.stateJson) as Partial<KernelState>;
  return { state: hydrateSnapshot(persisted.device?.id ?? 'unknown', persisted), logOffset: row.logOffset };
}

/**
 * Rows strictly after `fromSignalId` (or everything, if null — no snapshot
 * yet), already mapped to the `SanitizedEvent` shape `reduce()` expects.
 * Boot replay (decision #2, docs/design/00-overview.md): fold these through
 * reduce() to fast-forward state from the last snapshot to "now," in bounded
 * time regardless of total log size.
 */
export async function replayTail(fromSignalId: string | null): Promise<SanitizedEvent[]> {
  const rows = await getSignalsAfter(fromSignalId);
  return rows.map(toSanitizedEvent);
}
