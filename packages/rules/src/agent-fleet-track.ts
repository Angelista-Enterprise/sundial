import type { AgentEdit, AgentFleetEntry, AgentHook, Effect, KernelState, Rule, SanitizedEvent } from '@sundial/kernel/types.js';
import { deriveId } from '@sundial/helpers/derive-id.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { sharedCheckouts, withHooks } from '@sundial/kernel/agent-fleet.js';
import { inCall } from './notice-gate.js';

type RuleResult = ReturnType<Rule>;

const MINUTE = 60_000;
/** A wait shorter than this is the owner reading the answer, not an agent left idle. The measured median wait is 2.6 min. */
export const AGENT_WAIT_NOTICE_MS = 5 * 60 * 1000;
/** A wait older than this is a session the owner walked away from, not one waiting on them. */
export const AGENT_WAIT_STALE_MS = 2 * 60 * 60 * 1000;
/** How fast "your agent is waiting" loses its value: after half an hour it is old news. */
export const AGENT_WAIT_HALF_LIFE_MS = 30 * 60 * 1000;
/** Apps an agent runs in. When one of these is frontmost the owner is already with their agents. */
const AGENT_HOSTS = /^(Claude|Warp|Terminal|iTerm2|Ghostty|Code|Cursor|Zed|Windsurf)$/;
/** A prompt this recent means the owner is looking at that session. */
export const ATTENDED_MS = 10 * MINUTE;
/** Hooks kept per session: the fleet window. */
const HOOK_KEEP_MS = 6 * 60 * MINUTE;
/** The same failing call this many times in a row is a loop worth saying (U3-F33). */
export const LOOP_AT = 5;
/** Agent edits kept for file-level collisions (U3-F23): two sessions on one file within this are colliding. */
export const AGENT_EDIT_WINDOW_MS = 10 * MINUTE;
const MAX_EDITS = 50;
/** A file an agent edited this recently is the agent's change, not the owner's (U3-F24). */
const OWN_EDIT_MS = 2 * MINUTE;
/** A wait on the owner, as opposed to a finished turn: worth saying even from inside another session. */
const URGENT = new Set(['permission', 'question', 'plan', 'failed']);
const VALID_STATES = new Set(['working', 'waiting', 'tool', 'question', 'plan', 'permission', 'failed']);

function entries(payload: unknown): AgentFleetEntry[] {
  const sessions = (payload as { sessions?: unknown })?.sessions;
  if (!Array.isArray(sessions)) return [];
  return sessions.filter(
    (s): s is AgentFleetEntry =>
      typeof s === 'object' && s !== null && typeof s.id === 'string' && typeof s.cwd === 'string' && VALID_STATES.has(s.state) && typeof s.since === 'string' && !Number.isNaN(Date.parse(s.since)),
  );
}

const project = (cwd: string) => cwd.split('/').filter(Boolean).pop() ?? cwd;
const quote = (t: string) => `'${t.length > 60 ? `${t.slice(0, 59)}…` : t}'`;
/** "'Fix the checkout timeout' in puzzlebox-studio (feature/x)": the session's own name when it has one, else the owner's last prompt, else just where. */
function on(s: AgentFleetEntry): string {
  const where = `${project(s.cwd)}${s.branch && s.branch !== 'main' && s.branch !== 'master' ? ` (${s.branch})` : ''}`;
  const name = s.title ?? s.lastPrompt;
  return name ? `${quote(name)} in ${where}` : `in ${where}`;
}

/** What a finished session leaves to review (U3-F35): its line count and PR, when the transcript recorded them. */
function done(s: AgentFleetEntry): string {
  const parts = [s.lines && s.lines.added + s.lines.removed > 0 ? `+${s.lines.added} −${s.lines.removed}` : null, s.pr ? `PR #${s.pr.number}` : null].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

interface Kind {
  kind: string;
  afterMs: number;
  halfLifeMs: number;
  say: (on: string, minutes: number, s: AgentFleetEntry) => string;
}
type WaitState = Exclude<AgentFleetEntry['state'], 'working'>;
/**
 * One notice kind per thing an agent can wait on (U3-F14). `afterMs` is when a
 * wait is worth saying, and the unit its surprise grows in, so at the same wait
 * an approval outweighs a finished turn. A question for the owner is urgent:
 * 20 AskUserQuestion calls in 30 days waited over five minutes, and four of five
 * ExitPlanMode calls over fifteen.
 */
const KINDS: Record<WaitState, Kind> = {
  permission: { kind: 'agent-permission', afterMs: 3 * MINUTE, halfLifeMs: 10 * MINUTE, say: (o, m) => `Your Claude session ${o} has waited ${m} min for your approval.` },
  question: { kind: 'agent-question', afterMs: 3 * MINUTE, halfLifeMs: 15 * MINUTE, say: (o, m) => `Your Claude session ${o} asked you a question ${m} min ago.` },
  plan: { kind: 'agent-plan', afterMs: 3 * MINUTE, halfLifeMs: 15 * MINUTE, say: (o, m) => `Your Claude session ${o} has had a plan waiting for your approval for ${m} min.` },
  failed: {
    kind: 'agent-failed',
    afterMs: MINUTE,
    halfLifeMs: AGENT_WAIT_HALF_LIFE_MS,
    say: (o, m, s) => `Your Claude session ${o} stopped on ${s.error === 'rate_limit' ? 'a rate limit' : s.error && s.error !== 'api_error' ? `an API error (${s.error})` : 'an API error'} ${m} min ago.`,
  },
  waiting: { kind: 'agent-waiting', afterMs: AGENT_WAIT_NOTICE_MS, halfLifeMs: AGENT_WAIT_HALF_LIFE_MS, say: (o, m, s) => `Your Claude session ${o} finished ${m} min ago and is waiting for you${done(s)}.` },
  tool: { kind: 'agent-tool-pending', afterMs: AGENT_WAIT_NOTICE_MS, halfLifeMs: AGENT_WAIT_HALF_LIFE_MS, say: (o, m) => `Your Claude session ${o} has been on one tool call for ${m} min — it may be waiting for your approval.` },
};
/**
 * A tool call the registry or a hook says is running — not an approval, that
 * would be `permission` — is either a long build or a hung one (U3-F32). Bash
 * ran over five minutes 40 times in 30 days and over fifteen six times, so
 * fifteen minutes is the bar.
 */
const STUCK: Kind = { kind: 'agent-stuck', afterMs: 15 * MINUTE, halfLifeMs: AGENT_WAIT_HALF_LIFE_MS, say: (o, m) => `Your Claude session ${o} has been on one tool call for ${m} min with no result — it may be stuck.` };
const kindOf = (s: AgentFleetEntry & { state: WaitState }): Kind => (s.state === 'tool' && s.source && s.source !== 'transcript' ? STUCK : KINDS[s.state]);

/** Waits kept per kind for the owner's own thresholds, and how many before they replace the defaults (U3-F21). */
const WAITS_KEPT = 200;
export const WAITS_LEARNED_AT = 20;
const LEARNABLE = new Set(['waiting', 'question', 'plan', 'permission']);
const p75 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(0.75 * (xs.length - 1))];
/**
 * A kind's threshold, fitted to the owner (U3-F21): once 20 of their own waits
 * of that kind are known, a wait is worth saying past their 75th percentile —
 * longer than three in four of their waits. Below 20 the default stands. On the
 * 30-day record the finished-turn p75 is 6.7 min (n = 1,267) against the
 * default five, a question's 4.9 min (n = 83) against three; a plan has n = 5.
 */
function learned(kind: Kind, stateName: string, waits: Record<string, number[]> | undefined): Kind {
  const xs = LEARNABLE.has(stateName) ? waits?.[stateName] : undefined;
  if (!xs || xs.length < WAITS_LEARNED_AT) return kind;
  return { ...kind, afterMs: Math.max(MINUTE, p75(xs) * MINUTE) };
}
/** Each wait that ended between two fleets (the owner answered: the session went back to work), in minutes, by kind. */
function learnWaits(prev: AgentFleetEntry[], next: AgentFleetEntry[], waits: Record<string, number[]> = {}): Record<string, number[]> {
  const byId = new Map(next.map((s) => [s.id, s]));
  let out = waits;
  for (const s of prev) {
    const now = byId.get(s.id);
    if (!LEARNABLE.has(s.state) || now?.state !== 'working' || Date.parse(now.since) <= Date.parse(s.since)) continue;
    const minutes = Math.round((Date.parse(now.since) - Date.parse(s.since)) / 6000) / 10;
    if (minutes > AGENT_WAIT_STALE_MS / MINUTE) continue;
    out = { ...out, [s.state]: [...(out[s.state] ?? []), minutes].slice(-WAITS_KEPT) };
  }
  return out;
}

/**
 * How sure the state is, by where it came from: a hook is Claude saying so, the
 * registry is Claude's own status file, a transcript is an inference. A pending
 * tool call is a guess (an approval, a long build, a hung one) whatever the source.
 */
const SOURCE_PRECISION = { hook: 0.95, registry: 0.9, job: 0.9, transcript: 0.6 } as const;
const precisionOf = (s: AgentFleetEntry): number => (s.state === 'tool' ? (s.source && s.source !== 'transcript' ? 0.6 : 0.5) : s.source ? SOURCE_PRECISION[s.source] : 0.85);
const waitKey = (s: AgentFleetEntry) => `${s.id}@${s.since}`;
/**
 * The gate's habituation key: the kind and the folder, never the session. Keyed
 * by session, every new session was a stimulus never heard before, so nothing
 * wore down: on 2026-09-28 one checkout's finished turns made 22 keys in a day.
 * `waitKey` still makes each wait once-only; this only lets the gate learn.
 */
/**
 * Two limits on that (hardening review): the gate's ceiling is 1/fires, so a
 * folder key heard twice could never interrupt again for about a month — the
 * key is scoped to the owner-local day. And an agent blocked on the owner
 * (a permission, a question, a plan to approve) is a new question every time:
 * those keep the session, so they are never worn down by an earlier one.
 */
const BLOCKED_ON_OWNER = new Set(['agent-permission', 'agent-question', 'agent-plan']);
const habitKey = (kind: string, s: { cwd: string; id?: string }, day: string) => (BLOCKED_ON_OWNER.has(kind) && s.id ? `${kind}:${s.id}` : `${kind}:${s.cwd}:${day}`);

/** The folder alone: a third session joining, or one leaving, is the same collision, not a new one to announce. */
const collisionKey = (c: { cwd: string }) => `collide:${c.cwd}`;
const loopKey = (s: AgentFleetEntry) => `loop:${s.id}`;
const editKey = (cwd: string, file: string) => `edit:${cwd}:${file}`;
const ownerKey = (s: AgentFleetEntry) => `owner:${waitKey(s)}`;
/** Files more than one session edited inside the window, as nudge keys. */
function editCollisions(edits: AgentEdit[]): string[] {
  const by = new Map<string, Set<string>>();
  for (const e of edits) by.set(editKey(e.cwd, e.file), (by.get(editKey(e.cwd, e.file)) ?? new Set()).add(e.id));
  return [...by].filter(([, ids]) => ids.size >= 2).map(([k]) => k);
}
const quiet = (state: KernelState) => state.lifeEvent.idle.isIdle || !!state.notices.away?.since || state.mind.circadian !== 'day';

interface Say {
  kind: string;
  key: string;
  surprise: number;
  precision: number;
  valueHalfLifeMs: number;
  observation: string;
  evidence: string[];
}
/** One `notice:candidate`; `nudge` is the memory key that makes it once-only. */
function notice(event: SanitizedEvent, nudge: string, say: Say): Effect {
  return {
    type: 'EmitEvent',
    event: { id: deriveId(event.ts, event.id, 'agent-fleet-track', nudge), type: 'notice:candidate', ts: event.ts, payload: { timestamp: event.ts, shape: 'transition', ...say, concerns: [] } },
  };
}

/**
 * The owner's coding agents, and what about them is worth saying: an agent has
 * been waiting for them a while and they are somewhere else, two share a
 * checkout, one is stuck or looping.
 *
 * `agent:fleet` replaces `state.agent.fleet` whole — it is a sample, not a
 * delta — with the last hook of each session laid over it. On `clock:tick`, the
 * most urgent wait becomes one `notice:candidate`, once per wait (`nudged`), and
 * only while the owner is at the machine, in the daytime, and not already with
 * that session. Whether it is worth an interruption is the gate's decision.
 *
 * Each thing a session can wait on is its own kind (`KINDS`): an approval, a
 * question, a plan, a failed turn, a finished turn, a pending tool call. The
 * registry says which; `tool` from a transcript alone is a long build or an
 * approval nobody answers, so it keeps a low precision. The candidate names
 * the session by its title, so the owner knows which one.
 */
export const agentFleetTrack: Rule = (state, event) => {
  if (event.type === 'agent:hook') return foldHook(state, event);
  if (event.type === 'agent:fleet') return foldFleet(state, event);
  if (event.type === 'file:changed') return ownerEdits(state, event);
  if (event.type === 'git:pr-status') return prRed(state, event);
  if (event.type !== 'clock:tick') return { state, effects: [] };

  const fleet = state.agent.fleet ?? [];
  const now = Date.parse(event.ts);
  // Away (idle, night, or on a call): nothing is said, and the start is kept for one digest on return (U3-F16).
  // A call, not the interruption cost: that reaches 1 after a minute of typing, which is the owner here.
  if (quiet(state) || inCall(state)) {
    return state.agent.away ? { state, effects: [] } : { state: { ...state, agent: { ...state.agent, away: event.ts } }, effects: [] };
  }
  if (state.agent.away) return digest({ ...state, agent: { ...state.agent, away: null } }, event, state.agent.away);
  if (fleet.length === 0) return { state, effects: [] };
  const front = state.window.active?.processName ?? '';
  // In an agent's own app the owner sees the session they are typing to. Knowing
  // which one that is (a prompt hook, U3-F13), a question or approval in ANOTHER
  // session is still news; without it, the app is taken as the owner being with
  // all of them.
  const attended = state.agent.attended && now - Date.parse(state.agent.attended.at) <= ATTENDED_MS ? state.agent.attended.id : null;
  const inHost = AGENT_HOSTS.test(front);
  if (inHost && !attended) return { state, effects: [] };
  const nudged = new Set(state.agent.nudged ?? []);
  const seen = (s: AgentFleetEntry) => !inHost || s.id !== attended;

  const looping = fleet.find((s) => (s.repeats ?? 0) >= LOOP_AT && seen(s) && !nudged.has(loopKey(s)));
  if (looping) {
    return {
      state: { ...state, agent: { ...state.agent, nudged: [...nudged, loopKey(looping)] } },
      effects: [
        notice(event, loopKey(looping), {
          kind: 'agent-looping',
          key: habitKey('agent-looping', looping, localDate(event.ts, state.config.timezone)),
          surprise: Math.log(1 + looping.repeats! / LOOP_AT),
          // Identical input and an error result each time: counted, not guessed.
          precision: 0.8,
          valueHalfLifeMs: 20 * MINUTE,
          observation: `Your Claude session ${on(looping)} has run the same failing tool call ${looping.repeats} times in a row.`,
          evidence: [`session ${looping.id} in ${looping.cwd}`, `${looping.repeats} identical failing calls`],
        }),
      ],
    };
  }

  const stuck = fleet
    .filter((s): s is AgentFleetEntry & { state: WaitState } => s.state !== 'working')
    .filter((s) => seen(s) && (!inHost || URGENT.has(s.state)))
    .map((s) => {
      const waitMs = now - Date.parse(s.since);
      const kind = learned(kindOf(s), s.state, state.agent.waits);
      return { s, waitMs, kind, surprise: Math.log(1 + waitMs / kind.afterMs), precision: precisionOf(s) };
    })
    .filter(({ waitMs, kind }) => waitMs >= kind.afterMs && waitMs <= AGENT_WAIT_STALE_MS)
    // The most urgent first: an approval before a finished turn at the same wait.
    .sort((a, b) => b.surprise * b.precision - a.surprise * a.precision);
  const pick = stuck.find(({ s }) => !nudged.has(waitKey(s)));
  if (!pick) return { state, effects: [] };

  const { s, waitMs, kind, surprise, precision } = pick;
  const others = stuck.length - 1;
  return {
    state: { ...state, agent: { ...state.agent, nudged: [...nudged, waitKey(s)] } },
    effects: [
      notice(event, waitKey(s), {
        kind: kind.kind,
        key: habitKey(kind.kind, s, localDate(event.ts, state.config.timezone)),
        surprise,
        precision,
        valueHalfLifeMs: kind.halfLifeMs,
        observation: kind.say(on(s), Math.round(waitMs / 60000), s) + (others > 0 ? ` ${others} more session${others === 1 ? '' : 's'} waiting too.` : ''),
        evidence: [
          `session ${s.id} in ${s.cwd}`,
          `${s.state} since ${s.since}${s.source ? ` (from ${s.source})` : ''}`,
          `owner in ${front || 'an unknown app'}`,
          `said after ${Math.round(kind.afterMs / 6000) / 10} min: ${(state.agent.waits?.[s.state]?.length ?? 0) >= WAITS_LEARNED_AT ? `the owner's p75, n = ${state.agent.waits![s.state]!.length}` : `the default, n = ${state.agent.waits?.[s.state]?.length ?? 0}`}`,
        ],
      }),
    ],
  };
};

function foldFleet(state: KernelState, event: SanitizedEvent): RuleResult {
  const fleet = withHooks(entries(event.payload), state.agent.hooks ?? {});
  const collisions = sharedCheckouts(fleet, event.ts);
  const live = new Set([
    ...fleet.map(waitKey),
    ...fleet.map(ownerKey),
    ...collisions.map(collisionKey),
    ...fleet.filter((s) => (s.repeats ?? 0) >= LOOP_AT).map(loopKey),
    ...editCollisions(state.agent.edits ?? []),
    // Cleared by the PR's next status, not by the fleet: the PR sensor repeats a status after every restart.
    ...(state.agent.nudged ?? []).filter((k) => k.startsWith('pr-red:')).slice(-20),
  ]);
  const nudged = (state.agent.nudged ?? []).filter((k) => live.has(k));
  // Said even when the owner is in Claude: being in one session says nothing about the other.
  const fresh = quiet(state) ? [] : collisions.filter((c) => !nudged.includes(collisionKey(c)));
  const effects = fresh.map((c) =>
    notice(event, collisionKey(c), {
      kind: 'agent-shared-checkout',
      key: `agent-shared-checkout:${c.cwd}`,
      surprise: Math.log(1 + c.ids.length),
      // Two live sessions naming one folder is a fact, not a guess.
      precision: 0.9,
      valueHalfLifeMs: 20 * MINUTE,
      observation: `${c.ids.length} Claude sessions are open in ${c.cwd} at the same time. A build or commit in one ships the other's unsaved changes — a worktree per session keeps them apart.`,
      evidence: [`sessions ${c.ids.join(', ')}`, `in ${c.cwd}`],
    }),
  );
  const waits = learnWaits(state.agent.fleet ?? [], fleet, state.agent.waits);
  return { state: { ...state, agent: { ...state.agent, fleet, waits, nudged: [...nudged, ...fresh.map(collisionKey)] } }, effects };
}

interface HookPayload {
  event?: unknown;
  session?: unknown;
  detail?: unknown;
  cwd?: unknown;
  file?: unknown;
}

/**
 * One Claude Code hook (U3-F8): the session's last hook is kept and laid over
 * the fleet at once, so a permission prompt or a failed turn is known the
 * moment Claude reports it, not at the next 15-second registry poll. A prompt
 * marks the session the owner is in (U3-F13).
 */
function foldHook(state: KernelState, event: SanitizedEvent): RuleResult {
  const p = event.payload as HookPayload;
  if (typeof p.session !== 'string' || typeof p.event !== 'string') return { state, effects: [] };
  const hook: AgentHook = { event: p.event, detail: typeof p.detail === 'string' ? p.detail : null, at: event.ts };
  const cutoff = Date.parse(event.ts) - HOOK_KEEP_MS;
  const hooks = Object.fromEntries(Object.entries({ ...(state.agent.hooks ?? {}), [p.session]: hook }).filter(([, h]) => Date.parse(h.at) >= cutoff));
  const fleet = withHooks(state.agent.fleet ?? [], { [p.session]: hook });
  const attended = p.event === 'UserPromptSubmit' ? { id: p.session, at: event.ts } : (state.agent.attended ?? null);
  const since = Date.parse(event.ts) - AGENT_EDIT_WINDOW_MS;
  const edit = p.event === 'PostToolUse' && typeof p.file === 'string' && typeof p.cwd === 'string' ? { id: p.session, cwd: p.cwd, file: p.file, at: event.ts } : null;
  const edits = [...(state.agent.edits ?? []).filter((e) => Date.parse(e.at) >= since), ...(edit ? [edit] : [])].slice(-MAX_EDITS);
  const waits = learnWaits(state.agent.fleet ?? [], fleet, state.agent.waits);
  const next = { ...state, agent: { ...state.agent, hooks, fleet, attended, edits, waits } };
  if (!edit) return { state: next, effects: [] };

  // U3-F23: another session edited this very file in the last ten minutes.
  const key = editKey(edit.cwd, edit.file);
  const others = [...new Set(edits.filter((e) => e.cwd === edit.cwd && e.file === edit.file && e.id !== edit.id).map((e) => e.id))];
  const nudged = next.agent.nudged ?? [];
  if (others.length === 0 || nudged.includes(key) || quiet(state)) return { state: next, effects: [] };
  return {
    state: { ...next, agent: { ...next.agent, nudged: [...nudged, key] } },
    effects: [
      notice(event, key, {
        kind: 'agent-file-collision',
        key: `agent-file-collision:${edit.cwd}:${edit.file}`,
        surprise: Math.log(2 + others.length),
        // Two hooks naming one file: a fact.
        precision: 0.95,
        valueHalfLifeMs: 10 * MINUTE,
        observation: `Two Claude sessions edited ${edit.file} in ${project(edit.cwd)} within ten minutes of each other — one may undo the other's change.`,
        evidence: [`sessions ${[edit.id, ...others].sort().join(', ')}`, `${edit.file} in ${edit.cwd}`],
      }),
    ],
  };
}

/**
 * U3-F24: the owner changing files in a checkout where an agent is mid-turn.
 * A change is the owner's when no agent edited that file in the last two
 * minutes — which only means something while the hooks report that session's
 * edits, so a session with no hook yet is never the other party. The file
 * watcher debounces two seconds, so the agent's own hook line is in first.
 */
function ownerEdits(state: KernelState, event: SanitizedEvent): RuleResult {
  const p = event.payload as { projectRoot?: unknown; changes?: unknown };
  if (typeof p.projectRoot !== 'string' || !Array.isArray(p.changes) || quiet(state)) return { state, effects: [] };
  if ((state.window.active?.processName ?? '') === 'Claude') return { state, effects: [] };
  const now = Date.parse(event.ts);
  const recent = new Set((state.agent.edits ?? []).filter((e) => e.cwd === p.projectRoot && now - Date.parse(e.at) <= OWN_EDIT_MS).map((e) => e.file));
  const mine = p.changes.map((c) => (c as { relPath?: unknown }).relPath).filter((f): f is string => typeof f === 'string' && !recent.has(f));
  const nudged = state.agent.nudged ?? [];
  const agent = (state.agent.fleet ?? []).find((s) => s.cwd === p.projectRoot && s.state === 'working' && state.agent.hooks?.[s.id] && !nudged.includes(ownerKey(s)));
  if (mine.length === 0 || !agent) return { state, effects: [] };
  return {
    state: { ...state, agent: { ...state.agent, nudged: [...nudged, ownerKey(agent)] } },
    effects: [
      notice(event, ownerKey(agent), {
        kind: 'agent-owner-collision',
        key: habitKey('agent-owner-collision', agent, localDate(event.ts, state.config.timezone)),
        surprise: Math.log(2),
        // The change is inferred to be the owner's: no agent edit named the file.
        precision: 0.7,
        valueHalfLifeMs: 10 * MINUTE,
        observation: `You are changing ${mine[0]}${mine.length > 1 ? ` and ${mine.length - 1} more` : ''} in ${project(agent.cwd)} while your Claude session${agent.title ? ` ${quote(agent.title)}` : ''} is mid-turn there.`,
        evidence: [`session ${agent.id} working since ${agent.since}`, `${mine.length} changed file(s) no agent edited, in ${agent.cwd}`],
      }),
    ],
  };
}

const DIGEST_WORDS: Record<WaitState, [string, string]> = {
  permission: ['needs your approval', 'need your approval'],
  question: ['asked you a question', 'asked you a question'],
  plan: ['has a plan to approve', 'have a plan to approve'],
  failed: ['stopped on an error', 'stopped on an error'],
  tool: ['is on a long tool call', 'are on long tool calls'],
  waiting: ['finished', 'finished'],
};
const DIGEST_ORDER: WaitState[] = ['permission', 'question', 'plan', 'failed', 'tool', 'waiting'];

/**
 * U3-F16 — back from a break, a call or the night: what the agents did
 * meanwhile, in ONE candidate instead of one per session. Two or more waits
 * that began while the owner was away (and were never said) make a digest,
 * and are marked said; a single one is left to the ordinary path.
 */
function digest(state: KernelState, event: SanitizedEvent, awaySince: string): RuleResult {
  const from = Date.parse(awaySince) - AGENT_WAIT_NOTICE_MS;
  const nudged = state.agent.nudged ?? [];
  const waits = (state.agent.fleet ?? []).filter((s): s is AgentFleetEntry & { state: WaitState } => s.state !== 'working' && Date.parse(s.since) >= from && !nudged.includes(waitKey(s)));
  if (waits.length < 2) return { state, effects: [] };
  const parts = DIGEST_ORDER.map((k) => waits.filter((s) => s.state === k))
    .filter((group) => group.length > 0)
    .map((group) => {
      const [one, many] = DIGEST_WORDS[group[0].state];
      const urgent = URGENT.has(group[0].state) ? ` (${group.map(on).join('; ')})` : '';
      return `${group.length} ${group.length === 1 ? one : many}${urgent}`;
    });
  const key = `digest:${awaySince}`;
  return {
    state: { ...state, agent: { ...state.agent, nudged: [...nudged, ...waits.map(waitKey)] } },
    effects: [
      notice(event, key, {
        kind: 'agent-digest',
        // One key a day, so the gate habituates a second digest on the same day; the away start never recurs.
        key: `agent-digest:${localDate(event.ts, state.config.timezone)}`,
        surprise: Math.log(1 + waits.length),
        precision: Math.min(...waits.map(precisionOf)),
        valueHalfLifeMs: 20 * MINUTE,
        observation: `While you were away, your Claude sessions: ${parts.join(', ')}.`,
        evidence: waits.map((s) => `session ${s.id} ${s.state} since ${s.since} in ${s.cwd}`),
      }),
    ],
  };
}

/**
 * U3-F36 — a pull request an agent session is on went red. The join is the
 * session's branch in the same checkout, or the PR its transcript linked
 * (`pr-link`). Said once per failure; the PR's next non-failing status clears it.
 */
function prRed(state: KernelState, event: SanitizedEvent): RuleResult {
  const p = event.payload as { cwd?: unknown; branch?: unknown; number?: unknown; checkState?: unknown; url?: unknown; title?: unknown };
  if (typeof p.number !== 'number' || typeof p.cwd !== 'string') return { state, effects: [] };
  const key = `pr-red:${p.cwd}#${p.number}`;
  const nudged = state.agent.nudged ?? [];
  if (p.checkState !== 'failure') return nudged.includes(key) ? { state: { ...state, agent: { ...state.agent, nudged: nudged.filter((k) => k !== key) } }, effects: [] } : { state, effects: [] };
  const session = (state.agent.fleet ?? []).find((s) => s.cwd === p.cwd && ((typeof p.branch === 'string' && s.branch === p.branch) || s.pr?.number === p.number));
  if (!session || nudged.includes(key)) return { state, effects: [] };
  return {
    state: { ...state, agent: { ...state.agent, nudged: [...nudged, key] } },
    effects: [
      notice(event, key, {
        kind: 'agent-pr-red',
        key: `agent-pr-red:${p.cwd}#${p.number}`,
        surprise: Math.log(3),
        // The checks said failure; which session it belongs to is a branch match.
        precision: 0.85,
        valueHalfLifeMs: AGENT_WAIT_HALF_LIFE_MS,
        observation: `The checks failed on PR #${p.number}, which your Claude session ${on(session)} is working on${typeof p.url === 'string' ? ` — ${p.url}` : ''}.`,
        evidence: [`session ${session.id} on ${session.branch ?? 'its PR'}`, `PR #${p.number} checks: failure`],
      }),
    ],
  };
}
