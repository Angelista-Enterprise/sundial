// Plan 15 step 3: how fast the voice feels, from the log. Time to the nod and to the first spoken word after the
// key comes up, p50 and p90 with n; how often the owner stopped it. Round 5 (NEXT 3.1): of the screen steps whose
// line was sent (`voice:line` with a `stepId`), how many began to sound (`voice:said`, mode step) before the act's
// own answer (`screen:acted`) was logged. Both rows carry the app's clock. Target 80 percent, read with its n.
// Set 2 R1 item 5: of the refused screen steps in a spoken turn (a `screen:step` with ok false, in a session whose
// spoken `chat:shown` came at most two minutes before, voice-turn.js's own turn cap), how many were said with the
// next step (`voice:line` with `refused`, sent before that step's act). Target 80 percent, n at least 20.
import { getAllSignalsInRange } from '@sundial/db/index.js';

export interface VoiceStats {
  days: number;
  turns: number;
  interrupted: number;
  nod: { n: number; p50: number | null; p90: number | null };
  firstWord: { n: number; p50: number | null; p90: number | null };
  stepLines: { n: number; early: number };
  refusals: { n: number; said: number };
}
const TURN_MS = 120_000;

const spread = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
  return { n: sorted.length, p50: at(0.5), p90: at(0.9) };
};

export async function readVoiceStats({ now, days = 30 }: { now: number; days?: number }): Promise<VoiceStats> {
  const [from, to] = [new Date(now - days * 86_400_000).toISOString(), new Date(now + 1).toISOString()];
  const signals = await getAllSignalsInRange(from, to, ['voice', 'screen:acted', 'screen:step']);
  const kind = (s: { signalType: string; eventType: string }) => `${s.signalType}:${s.eventType}`;
  const at = (type: string, keep: (d: Record<string, unknown>) => boolean = () => true) => new Map(signals.filter((s) => kind(s) === type && keep(s.data)).map((s) => [String(s.data[type === 'screen:acted' ? 'id' : 'stepId']), Date.parse(s.capturedAt)]));
  const acted = at('screen:acted');
  const began = at('voice:said', (d) => d.mode === 'step');
  const lines = [...at('voice:line', (d) => typeof d.stepId === 'string' && d.stepId !== '').keys()];
  const spoken = await getAllSignalsInRange(from, to, ['chat:shown'], '"voice":true');
  const turnAt = (session: unknown, at: number) => spoken.some((s) => s.data.sessionId === session && s.data.hints && (s.data.hints as { voice?: unknown }).voice === true && at >= Date.parse(s.capturedAt) && at - Date.parse(s.capturedAt) <= TURN_MS);
  const refused = signals.filter((s) => kind(s) === 'screen:step' && s.data.ok === false && turnAt(s.data.session, Date.parse(s.capturedAt))).map((s) => String(s.data.id));
  const told = new Set(signals.filter((s) => kind(s) === 'voice:line' && typeof s.data.refused === 'string').map((s) => s.data.refused));
  const said = signals.filter((s) => `${s.signalType}:${s.eventType}` === 'voice:said' && s.data.mode === 'reply');
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? [v] : []);
  return {
    days,
    turns: said.length,
    interrupted: signals.filter((s) => `${s.signalType}:${s.eventType}` === 'voice:interrupted').length,
    nod: spread(said.flatMap((s) => num(s.data.nodMs))),
    firstWord: spread(said.flatMap((s) => num(s.data.firstWordMs))),
    stepLines: { n: lines.length, early: lines.filter((id) => began.has(id) && began.get(id)! < (acted.get(id) ?? Infinity)).length },
    refusals: { n: refused.length, said: refused.filter((id) => told.has(id)).length },
  };
}
