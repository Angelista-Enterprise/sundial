// W6 P12: the agent-watch notice kinds, from a made-up Claude hook log. On the record (13 hours of
// hooks, from 2026-09-28) none of seven kinds had a candidate. Each line below is what
// `packages/sensors/claude-hook.mjs` writes, read back through the hook sensor's own parser; the
// registry and transcript states come as the fleet sensor sends them. Every kind fires here, so
// none is retired: the record simply held no such wait while the owner was at the Mac.
import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { agentFleetTrack } from '@sundial/rules/agent-fleet-track.js';
import { parseHookLine } from '@sundial/sensors/agent-session/claude-hooks.js';

const T0 = Date.parse('2026-09-28T10:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
let seq = 0;
const ev = (type: string, payload: Record<string, unknown>, ts: string): SanitizedEvent => ({ id: `w${++seq}`, type, ts, payload, sanitized: true });
const CWD = '~/Projects/puzzlebox-studio';
const session = (id: string, over: Record<string, unknown> = {}) => ({ id, cwd: CWD, branch: 'feat/box-484', state: 'working', since: at(0), source: 'registry', ...over });
const hook = (min: number, line: Record<string, unknown>) => {
  const parsed = parseHookLine(JSON.stringify({ ts: at(min), cwd: CWD, ...line }))!;
  return ev(parsed.type, parsed.payload, parsed.ts);
};

/** The owner at the Mac, in the day, in an app that is not an agent's. */
function present(): KernelState {
  const s = createInitialState('d');
  return { ...s, mind: { ...s.mind, circadian: 'day' }, window: { ...s.window, active: { processName: 'Arc', windowTitle: 'BOX-484' } as never } };
}

function kinds(events: SanitizedEvent[]): string[] {
  let state = present();
  const out: string[] = [];
  for (const e of events) {
    const r = agentFleetTrack(state, e);
    state = r.state;
    for (const x of r.effects) if (x.type === 'EmitEvent' && x.event.type === 'notice:candidate') out.push(String(x.event.payload.kind));
  }
  return out;
}

describe('W6 P12: each agent-watch kind fires from a hook log', () => {
  const fleet = (...sessions: Record<string, unknown>[]) => ev('agent:fleet', { sessions }, at(0));
  const cases: [string, SanitizedEvent[]][] = [
    ['agent-permission', [fleet(session('aaaa1111')), hook(1, { event: 'Notification', session: 'aaaa1111', detail: 'permission_prompt' }), ev('clock:tick', {}, at(5))]],
    ['agent-question', [fleet(session('bbbb2222')), hook(1, { event: 'Notification', session: 'bbbb2222', detail: 'agent_needs_input' }), ev('clock:tick', {}, at(5))]],
    ['agent-failed', [fleet(session('cccc3333')), hook(1, { event: 'StopFailure', session: 'cccc3333', detail: 'rate_limit' }), ev('clock:tick', {}, at(3))]],
    ['agent-file-collision', [fleet(session('dddd4444'), session('eeee5555', { cwd: CWD })), hook(1, { event: 'PostToolUse', session: 'dddd4444', tool: 'Edit', file: 'src/retry.ts' }), hook(2, { event: 'PostToolUse', session: 'eeee5555', tool: 'Edit', file: 'src/retry.ts' })]],
    // The next three are the fleet sensor's reading of the transcript and the registry.
    ['agent-plan', [fleet(session('ffff6666', { state: 'plan', source: 'transcript' })), ev('clock:tick', {}, at(5))]],
    ['agent-stuck', [fleet(session('gggg7777', { state: 'tool', source: 'registry' })), ev('clock:tick', {}, at(20))]],
    ['agent-looping', [fleet(session('hhhh8888', { repeats: 6 })), ev('clock:tick', {}, at(1))]],
  ];
  for (const [kind, events] of cases) it(`${kind} fires`, () => expect(kinds(events)).toContain(kind));
});
