// Round 4: a notice that offers one act. The offer rides the candidate through the gate to the
// delivery payload and into `notices.offers`; a press spends it; the strip reads it from the snapshot.
import { createInitialState } from '@sundial/kernel/initial-state.js';
import { nowSnapshot, OFFER_LIFE_MS } from '@sundial/kernel/now.js';
import type { Effect, KernelState, NoticeCandidate, SanitizedEvent } from '@sundial/kernel/types.js';
import { describe, expect, it } from 'vitest';
import { MAX_OFFERS, noticeGate } from './notice-gate.js';

const TS = '2026-03-10T14:00:00.000Z';
const offer = { tool: 'gnomon_brief', args: { kind: 'meeting', title: 'Planning' }, label: 'Open the prep' };
const prep = (over: Partial<NoticeCandidate> = {}): NoticeCandidate => ({ shape: 'anticipatory', kind: 'meeting-prep', key: 'prep:planning', surprise: 1, precision: 1, valueHalfLifeMs: null, observation: 'Planning with Mira Bakker at 14:10.', evidence: [], concerns: [], offer, ...over });
const ev = (type: string, payload: Record<string, unknown>, ts = TS, id = `${type}-${ts}`): SanitizedEvent => ({ id, type, ts, payload, sanitized: true });
const base = (): KernelState => {
  const s = createInitialState('d1');
  return { ...s, config: { ...s.config, timezone: 'UTC' } };
};
const notify = (effects: Effect[]) => effects.find((e) => e.type === 'Notify') as Extract<Effect, { type: 'Notify' }> | undefined;

describe('a notice that offers an act (Round 4)', () => {
  it('carries the offer end to end: the payload gets its label, the gate keeps the call by notice key', () => {
    const out = noticeGate(base(), ev('notice:candidate', { ...prep() }));
    expect(notify(out.effects)?.payload).toMatchObject({ noticeKey: 'prep:planning', offer: 'Open the prep' });
    // The page gets only the words; the call stays in state for the press.
    expect(JSON.stringify(notify(out.effects)?.payload)).not.toContain('gnomon_brief');
    // The notice's own line rides with the offer, so a surface shows exactly the line it came with.
    expect(out.state.notices.offers?.['prep:planning']).toEqual({ ...offer, kind: 'meeting-prep', at: TS, line: 'Planning with Mira Bakker at 14:10.' });
    expect(nowSnapshot(out.state, Date.parse(TS) + 60_000).offer).toEqual({ noticeKey: 'prep:planning', label: 'Open the prep', kind: 'meeting-prep', at: TS, line: 'Planning with Mira Bakker at 14:10.' });
  });

  it("each offer keeps its own notice's line: a second notice with its own offer never lends the first its words", () => {
    let s = noticeGate(base(), ev('notice:candidate', { ...prep() })).state;
    s = noticeGate(s, ev('notice:candidate', { ...prep({ kind: 'stuck', key: 'stuck:build', observation: 'The puzzlebox-studio build is red since 09:40.', offer: { tool: 'gnomon_signals', args: { contains: 'pnpm test' }, label: 'Pull it up' } }) }, '2026-03-10T14:00:30.000Z')).state;
    expect(s.notices.offers?.['prep:planning']?.line).toBe('Planning with Mira Bakker at 14:10.');
    expect(s.notices.offers?.['stuck:build']?.line).toBe('The puzzlebox-studio build is red since 09:40.');
    expect(nowSnapshot(s, Date.parse(TS) + 60_000).offer).toMatchObject({ noticeKey: 'stuck:build', line: 'The puzzlebox-studio build is red since 09:40.' });
  });

  it('a notice without an offer, or with half of one, carries none', () => {
    for (const c of [prep({ offer: undefined }), prep({ offer: { tool: '', args: {}, label: 'Go' } }), prep({ offer: { tool: 'gnomon_brief', args: {}, label: '' } })]) {
      const out = noticeGate(base(), ev('notice:candidate', { ...c }));
      expect(notify(out.effects)?.payload.offer).toBeUndefined();
      expect(out.state.notices.offers ?? {}).toEqual({});
    }
  });

  it('a suppressed candidate keeps no offer: nothing was said, so nothing can be pressed', () => {
    const out = noticeGate(base(), ev('notice:candidate', { ...prep({ precision: 0.1 }) }));
    expect(out.effects.some((e) => e.type === 'Notify')).toBe(false);
    expect(out.state.notices.offers).toBeUndefined();
  });

  it('an offer held for a better moment keeps its offer, and delivers it when it lands', () => {
    // An hour away: a tonic row waits for the return, whole.
    let s = noticeGate(base(), ev('idle:start', {}, '2026-03-10T12:00:00.000Z')).state;
    s = noticeGate(s, ev('notice:candidate', { ...prep() })).state;
    expect(s.notices.away?.held[0]?.candidate.offer).toEqual(offer);
    const back = noticeGate(s, ev('input:activity', { keyDownCount: 4, mouseClickCount: 1 }, '2026-03-10T14:05:00.000Z'));
    expect(notify(back.effects)?.payload.offer).toBe('Open the prep');
    expect(back.state.notices.offers?.['prep:planning']?.at).toBe('2026-03-10T14:05:00.000Z');
  });

  it('a press spends it (notice:offer-taken), and a second press finds nothing to spend', () => {
    const delivered = noticeGate(base(), ev('notice:candidate', { ...prep() })).state;
    const taken = noticeGate(delivered, ev('notice:offer-taken', { noticeKey: 'prep:planning', kind: 'meeting-prep', tool: 'gnomon_brief' }));
    expect(taken.state.notices.offers).toEqual({});
    expect(nowSnapshot(taken.state, Date.parse(TS)).offer).toBeNull();
    expect(noticeGate(taken.state, ev('notice:offer-taken', { noticeKey: 'prep:planning' })).state).toBe(taken.state);
    // A key every plain object has is no offer: the state is left as it was.
    for (const noticeKey of ['__proto__', 'constructor']) expect(noticeGate(delivered, ev('notice:offer-taken', { noticeKey })).state).toBe(delivered);
  });

  it('untaken past its life, it leaves the strip (ignored); the gate keeps at most eight', () => {
    const delivered = noticeGate(base(), ev('notice:candidate', { ...prep() })).state;
    expect(nowSnapshot(delivered, Date.parse(TS) + OFFER_LIFE_MS + 1).offer).toBeNull();
    let s = base();
    for (let i = 0; i < MAX_OFFERS + 3; i++) {
      const ts = new Date(Date.parse(TS) + i * 60_000).toISOString();
      // Heavy enough to be said past any budget, so every one of the eleven is delivered.
      s = noticeGate(s, ev('notice:candidate', { ...prep({ key: `prep:${i}`, surprise: 2 }) }, ts, `c${i}`)).state;
    }
    const keys = Object.keys(s.notices.offers ?? {});
    expect(keys).toEqual(Array.from({ length: MAX_OFFERS }, (_, i) => `prep:${i + 3}`));
    expect(nowSnapshot(s, Date.parse(TS) + 11 * 60_000).offer?.noticeKey).toBe('prep:10');
  });
});
