import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { rebuildCalibrated } from './calibrate-backfill.js';

const T0 = Date.parse('2026-09-20T09:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
let seq = 0;
const ev = (type: string, ts: string, payload: Record<string, unknown> = {}): SanitizedEvent => ({ id: `e${++seq}`, type, ts, payload, sanitized: true });
const verdict = (ts: string, artifactId: string, v: string) => ev('feedback:verdict', ts, { artifactKind: 'notice', artifactId, verdict: v });
const input = (ts: string) => ev('input:activity', ts, { keyDownCount: 3 });

describe('the boot backfill (W5 step 3)', () => {
  it('rebuilds from the gate rows and the log what the live fold would have counted', async () => {
    const gate = [
      { id: 'g1', noticeKey: 'k:1', kind: 'return-from-break', channel: 'tonic', reason: 'admitted', interruptionCost: 0, decidedAt: at(0) },
      { id: 'g2', noticeKey: 'k:2', kind: 'return-from-break', channel: 'suppressed', reason: 'below-threshold', interruptionCost: 0, decidedAt: at(1) },
    ];
    const rows = [input(at(2)), verdict(at(10), 'k:1', 'useful'), ev('action:verified', at(11), { tool: 't', failed: false })].map((e) => ({ id: e.id, signalType: e.type.split(':')[0]!, eventType: e.type.split(':')[1]!, capturedAt: e.ts, data: e.payload }));
    const out = await rebuildCalibrated(createInitialState('d1'), { gateRows: async () => gate, signals: async (_t, offset) => (offset === 0 ? rows : []) });
    expect(out.deliveries).toBe(1);
    expect(out.calibrated.params['notice.precision:return-from-break']).toMatchObject({ n: 1, hits: 1 });
    expect(out.calibrated.params['notice.seen:return-from-break']).toMatchObject({ n: 1, hits: 1 });
    expect(out.calibrated.params['action.verified:t']).toMatchObject({ n: 1, hits: 1 });
    expect(out.calibrated.noticeByKind['return-from-break']!['2026-09-20']).toMatchObject({ delivered: 1, labelled: 1, useful: 1, seen: 1 });
  });
});
