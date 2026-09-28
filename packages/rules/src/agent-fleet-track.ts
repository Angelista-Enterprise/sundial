import type { AgentFleetEntry, Rule } from '@sundial/kernel/types.js';
import { deriveId } from '@sundial/helpers/derive-id.js';
import { sharedCheckouts } from '@sundial/kernel/agent-fleet.js';

/** A wait shorter than this is the owner reading the answer, not an agent left idle. The measured median wait is 2.6 min. */
export const AGENT_WAIT_NOTICE_MS = 5 * 60 * 1000;
/** A wait older than this is a session the owner walked away from, not one waiting on them. */
export const AGENT_WAIT_STALE_MS = 2 * 60 * 60 * 1000;
/** How fast "your agent is waiting" loses its value: after half an hour it is old news. */
export const AGENT_WAIT_HALF_LIFE_MS = 30 * 60 * 1000;
/** Apps an agent runs in. When one of these is frontmost the owner is already with their agents. */
const AGENT_HOSTS = /^(Claude|Warp|Terminal|iTerm2|Ghostty|Code|Cursor|Zed|Windsurf)$/;

const VALID_STATES = new Set(['working', 'waiting', 'tool']);

function entries(payload: unknown): AgentFleetEntry[] {
  const sessions = (payload as { sessions?: unknown })?.sessions;
  if (!Array.isArray(sessions)) return [];
  return sessions.filter(
    (s): s is AgentFleetEntry =>
      typeof s === 'object' && s !== null && typeof s.id === 'string' && typeof s.cwd === 'string' && VALID_STATES.has(s.state) && typeof s.since === 'string' && !Number.isNaN(Date.parse(s.since)),
  );
}

const project = (cwd: string) => cwd.split('/').filter(Boolean).pop() ?? cwd;
const waitKey = (s: AgentFleetEntry) => `${s.id}@${s.since}`;

const collisionKey = (c: { cwd: string; ids: string[] }) => `collide:${c.cwd}:${c.ids.join('+')}`;

/**
 * The owner's coding agents, and the one thing about them worth saying: an
 * agent has been waiting for them a while, and they are somewhere else.
 *
 * `agent:fleet` replaces `state.agent.fleet` whole — it is a sample, not a
 * delta. On `clock:tick`, the longest wait past five minutes becomes one
 * `notice:candidate`, once per wait (`nudged`), and only while the owner is at
 * the machine, in the daytime, in an app that is not an agent host. Whether it
 * is worth an interruption is the gate's decision, as always.
 *
 * `tool` counts too, at lower precision: a tool call with no result for five
 * minutes is either a long build or an approval prompt nobody is answering, and
 * the transcript cannot tell which.
 */
export const agentFleetTrack: Rule = (state, event) => {
  if (event.type === 'agent:fleet') {
    const fleet = entries(event.payload);
    const collisions = sharedCheckouts(fleet);
    const live = new Set([...fleet.map(waitKey), ...collisions.map(collisionKey)]);
    const nudged = (state.agent.nudged ?? []).filter((k) => live.has(k));
    // Said even when the owner is in Claude: being in one session says nothing about the other.
    const fresh = state.lifeEvent.idle.isIdle || state.mind.circadian !== 'day' ? [] : collisions.filter((c) => !nudged.includes(collisionKey(c)));
    const effects = fresh.map((c) => ({
      type: 'EmitEvent' as const,
      event: {
        id: deriveId(event.ts, event.id, 'agent-fleet-track', collisionKey(c)),
        type: 'notice:candidate',
        ts: event.ts,
        payload: {
          timestamp: event.ts,
          shape: 'transition',
          kind: 'agent-shared-checkout',
          key: `agent-shared-checkout:${c.cwd}`,
          surprise: Math.log(1 + c.ids.length),
          // Two transcripts naming one folder is a fact, not a guess.
          precision: 0.9,
          valueHalfLifeMs: 20 * 60 * 1000,
          observation: `${c.ids.length} Claude sessions are working in ${c.cwd} at the same time. A build or commit in one ships the other's unsaved changes — a worktree per session keeps them apart.`,
          evidence: [`sessions ${c.ids.join(', ')}`, `in ${c.cwd}`],
          concerns: [],
        },
      },
    }));
    return { state: { ...state, agent: { ...state.agent, fleet, nudged: [...nudged, ...fresh.map(collisionKey)] } }, effects };
  }
  if (event.type !== 'clock:tick') return { state, effects: [] };

  const fleet = state.agent.fleet ?? [];
  if (fleet.length === 0) return { state, effects: [] };
  if (state.lifeEvent.idle.isIdle || state.mind.circadian !== 'day') return { state, effects: [] };
  const front = state.window.active?.processName ?? '';
  if (AGENT_HOSTS.test(front)) return { state, effects: [] };

  const now = Date.parse(event.ts);
  const nudged = new Set(state.agent.nudged ?? []);
  const stuck = fleet
    .filter((s) => s.state !== 'working')
    .map((s) => ({ s, waitMs: now - Date.parse(s.since) }))
    .filter(({ waitMs }) => waitMs >= AGENT_WAIT_NOTICE_MS && waitMs <= AGENT_WAIT_STALE_MS)
    .sort((a, b) => b.waitMs - a.waitMs);
  const pick = stuck.find(({ s }) => !nudged.has(waitKey(s)));
  if (!pick) return { state, effects: [] };

  const { s, waitMs } = pick;
  const minutes = Math.round(waitMs / 60000);
  const where = `${project(s.cwd)}${s.branch && s.branch !== 'main' && s.branch !== 'master' ? ` (${s.branch})` : ''}`;
  const others = stuck.length - 1;
  const observation =
    s.state === 'waiting'
      ? `Your Claude session in ${where} finished ${minutes} min ago and is waiting for you${others > 0 ? ` — ${others} more waiting too` : ''}.`
      : `Your Claude session in ${where} has been on one tool call for ${minutes} min — it may be waiting for your approval${others > 0 ? ` (${others} more waiting)` : ''}.`;

  return {
    state: { ...state, agent: { ...state.agent, nudged: [...nudged, waitKey(s)] } },
    effects: [
      {
        type: 'EmitEvent',
        event: {
          id: deriveId(event.ts, event.id, 'agent-fleet-track', waitKey(s)),
          type: 'notice:candidate',
          ts: event.ts,
          payload: {
            timestamp: event.ts,
            shape: 'transition',
            kind: s.state === 'waiting' ? 'agent-waiting' : 'agent-tool-pending',
            key: `agent-waiting:${waitKey(s)}`,
            // ln: five minutes is a small surprise, forty a real one.
            surprise: Math.log(1 + waitMs / AGENT_WAIT_NOTICE_MS),
            // An ended turn is a fact; a pending tool call is a guess about an approval prompt.
            precision: s.state === 'waiting' ? 0.85 : 0.5,
            valueHalfLifeMs: AGENT_WAIT_HALF_LIFE_MS,
            observation,
            evidence: [`session ${s.id} in ${s.cwd}`, `${s.state} since ${s.since}`, `owner in ${front || 'an unknown app'}`],
            concerns: [],
          },
        },
      },
    ],
  };
};
