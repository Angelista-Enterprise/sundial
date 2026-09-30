/**
 * W5 step 3: `state.calibrated` from the record's history, once — the first boot after
 * `calibrate` ships would otherwise start every parameter at its prior, on a machine holding two
 * months of verdicts. The same move as `rebuildTickets`: the one rule, folded alone over the rows
 * it reads, in time order. The deliveries it watches are not signals (the gate delivers them in
 * the fold), so they come from `gate_decisions`, each laid on `notices.lastDelivered` just before
 * its own step, with the evidence of the logged candidate behind it. Effects are dropped: the
 * `feedback:implicit` rows of the past stay unwritten, their counts are what is kept.
 *
 * What it cannot rebuild: the routine forecasts (it needs the trail as it was) and each
 * question's interruption cost when it was said tonic (the gate row holds 0 there).
 */
import { getGateDecisionsBetween, getSignalsInRange } from '@sundial/db/index.js';
import { calibrate, CALIBRATE_SOURCE_TYPES } from '@sundial/rules/calibrate.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';

export interface GateRowForBackfill {
  id: string;
  noticeKey: string;
  kind: string;
  channel: string;
  reason: string;
  interruptionCost: number | null;
  decidedAt: string;
}
export interface SignalRowForBackfill {
  id: string;
  signalType: string;
  eventType: string;
  capturedAt: string;
  data: Record<string, unknown>;
}

const PAGE = 5000;

export async function rebuildCalibrated(
  state: KernelState,
  read: { gateRows: () => Promise<GateRowForBackfill[]>; signals: (types: string[], offset: number, limit: number) => Promise<SignalRowForBackfill[]> },
): Promise<{ calibrated: KernelState['calibrated']; rows: number; deliveries: number }> {
  const delivered = (await read.gateRows()).filter((r) => r.channel === 'tonic' || r.channel === 'phasic');
  let folded: KernelState = { ...state, calibrated: { params: {}, noticeByKind: {}, watch: [], routine: null, app: null, probes: [] } };
  const evidence = new Map<string, { evidence: string[]; sessionId: string | null; askId: string | null }>();
  let next = 0;
  let rows = 0;
  const deliverUntil = (ts: string) => {
    for (; next < delivered.length && delivered[next]!.decidedAt < ts; next++) {
      const d = delivered[next]!;
      const from = evidence.get(d.noticeKey);
      const item = { key: d.noticeKey, kind: d.kind, channel: d.channel as 'tonic' | 'phasic', cost: d.interruptionCost ?? 0, evidence: from?.evidence ?? [], sessionId: from?.sessionId ?? null, askId: from?.askId ?? null, ...(d.reason === 'exploration' ? { exploration: true } : {}) };
      const at = folded.notices.lastDelivered?.at === d.decidedAt ? folded.notices.lastDelivered.items : [];
      folded = { ...folded, notices: { ...folded.notices, lastDelivered: { at: d.decidedAt, items: [...at, item] } } };
      folded = calibrate(folded, { id: d.id, type: 'notice:candidate', ts: d.decidedAt, payload: { key: d.noticeKey }, sanitized: true } as SanitizedEvent).state;
    }
  };
  for (let offset = 0; ; offset += PAGE) {
    const page = await read.signals([...CALIBRATE_SOURCE_TYPES, 'notice:candidate'], offset, PAGE);
    for (const row of page) {
      deliverUntil(row.capturedAt);
      const type = `${row.signalType}:${row.eventType}`;
      if (type === 'notice:candidate') {
        const p = row.data as { key?: unknown; evidence?: unknown; sessionId?: unknown; askId?: unknown };
        if (typeof p.key === 'string') evidence.set(p.key, { evidence: Array.isArray(p.evidence) ? p.evidence.slice(0, 2).map(String) : [], sessionId: typeof p.sessionId === 'string' ? p.sessionId : null, askId: typeof p.askId === 'string' ? p.askId : null });
        continue;
      }
      folded = calibrate(folded, { id: row.id, type, ts: row.capturedAt, payload: row.data, sanitized: true } as SanitizedEvent).state;
    }
    rows += page.length;
    if (page.length < PAGE) break;
  }
  deliverUntil('9999');
  return { calibrated: folded.calibrated, rows, deliveries: delivered.length };
}

/** The boot's call: the whole retained record, from the database. */
export async function rebuildCalibratedFromLog(state: KernelState): Promise<KernelState['calibrated']> {
  const started = Date.now();
  const from = new Date(started - (state.config.retentionDays ?? 180) * 86_400_000).toISOString();
  const to = new Date(started + 60_000).toISOString();
  const out = await rebuildCalibrated(state, { gateRows: () => getGateDecisionsBetween(from, to), signals: (types, offset, limit) => getSignalsInRange(from, to, limit, types, offset) });
  console.log(`[sundial-kernel] calibrated ${Object.keys(out.calibrated.params).length} parameter(s) from ${out.rows} signal(s) and ${out.deliveries} delivered notice(s) in ${Date.now() - started} ms`);
  return out.calibrated;
}
