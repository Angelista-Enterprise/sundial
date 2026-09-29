import { deriveId } from '@sundial/helpers/derive-id.js';
import { formatClock, localDate, localHour } from '@sundial/helpers/local-day.js';
import { classifyActivity } from '@sundial/helpers/window-classification.js';
import { IGNORED_PATH } from './file-track.js';
import type { AgentFleetEntry, Commitment, Effect, KernelState, NoticeCandidate, ResumeLine, ResumePieces, ResumeTrigger, Rule, SanitizedEvent } from '@sundial/kernel/types.js';

/** One `input:activity` window, from the sensor's own `EMIT_WINDOW_MS`: the slack allowed around the break's start. */
const EMIT_WINDOW_MS = 10_000;
const MINUTE = 60_000;

/**
 * Below this, a pause is not a break worth a check-in — a bathroom trip, a phone
 * glance. Keeping the FLOOR here (not just in the gate) is deliberate: it holds the
 * candidate STREAM down rather than relying on `noticeGate` to suppress a flood, the
 * same discipline `anomalyZscore`'s own emission floor follows. Fifteen minutes is
 * long enough that the owner has genuinely context-switched (lost their place), short
 * enough to still be a break rather than an errand.
 */
const MIN_BREAK_MS = 15 * MINUTE;
/**
 * Above this it is not "stepped away for a bit", it is end-of-day, a meeting off the
 * machine, or an open laptop left overnight — none of which is a break to reconnect a
 * thread after. Without this cap a laptop left on all night would produce a
 * "back after 600 minutes" the morning it is touched, an enormous surprise on a
 * non-event.
 */
const MAX_BREAK_MS = 4 * 3_600_000;
/**
 * The break length at which surprise reaches 1.0. A return from an ordinary break
 * reads as unremarkable; only a genuinely long absence carries weight. Combined with
 * the honest precision below and the short half-life (phasic channel), the effective
 * bar is high: with `concernGain` 1.5 a candidate only clears `phasicThreshold` (1.6)
 * once the break is well over an hour, so ordinary breaks stay silent by construction.
 */
const REFERENCE_BREAK_MS = 30 * MINUTE;
/** From here up a return is worth interrupting for; below it is worth knowing. */
const LONG_BREAK_MS = 60 * MINUTE;
/**
 * Honest, and deliberately low. A return-from-break is a routine transition, not a
 * measured expectation being violated; it earns attention only when the absence was
 * long AND there is an open thread to reconnect — never on its own.
 */
/**
 * A thread touched shortly before the break is a HOT anchor: "you were on
 * BOX-484 when you stepped away" is checkable and useful. A thread last
 * touched three days ago is not what the owner left; it is just the newest
 * open branch. Thirty-nine candidates in a month were suppressed at the old
 * flat precision of 0.4 — with a hot anchor the claim is stronger, and without
 * one there is no candidate at all.
 */
export const HOT_ANCHOR_MS = 3 * 60 * MINUTE;
export const HOT_PRECISION = 0.7;
/**
 * Useful for a few minutes and worthless after. "The thread you left" is a reconnect
 * prompt at the instant of return; an hour later the owner has already re-oriented, so
 * this decays fast and routes to the phasic channel (see `noticeGate.decide`), which
 * carries its own high bar rather than competing for the one-a-day tonic budget that
 * the higher-value omission/commitment notices depend on.
 */
const VALUE_HALF_LIFE_MS = 10 * MINUTE;

interface InputActivityPayload {
  keyDownCount?: number;
  mouseClickCount?: number;
  mouseMoveCount?: number;
  scrollCount?: number;
}

/** Mirrors `idleTrack`'s own definition of a non-empty window — a real return, not another zero window. */
function hasActivity(payload: InputActivityPayload): boolean {
  return (payload.keyDownCount ?? 0) > 0 || (payload.mouseClickCount ?? 0) > 0 || (payload.mouseMoveCount ?? 0) > 0 || (payload.scrollCount ?? 0) > 0;
}

function fmtMinutes(ms: number): string {
  const min = Math.max(1, Math.round(ms / MINUTE));
  if (min < 60) return `${min} min`;
  const hours = Math.round((min / 60) * 10) / 10;
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * The open thread the owner most recently touched — the one "you left". A
 * promise heard aloud is never it (U2-F10): speech threads are ASR's reading of
 * a meeting, and 4 of 8 were still open ghosts. They have their own lane.
 */
function mostRecentOpenThread(state: KernelState): Commitment | null {
  let best: Commitment | null = null;
  for (const c of state.commitments.open) {
    if (c.source === 'speech') continue;
    if (!best || Date.parse(c.lastTouchedAt) > Date.parse(best.lastTouchedAt)) best = c;
  }
  return best;
}

/** States in which the session waits on the owner, most urgent first. */
const OWNER_WAITS: AgentFleetEntry['state'][] = ['permission', 'question', 'plan', 'failed', 'waiting'];
/** The app the owner talks to their agents in. */
const AGENT_APPS = new Set(['Claude']);
/** A prompt this recent before the break means the owner was in that session. */
const ATTENDED_BEFORE_MS = 30 * MINUTE;

/** What each state says, bare and before a session's title. */
const AGENT_SAYS: Record<AgentFleetEntry['state'], [string, string]> = {
  waiting: ['Claude waits on you', 'Claude waits on'],
  question: ['Claude asked you something', 'Claude asked you something in'],
  plan: ['Claude wants a plan approved', 'Claude wants a plan approved in'],
  permission: ['Claude waits for a permission', 'Claude waits for a permission in'],
  failed: ['Claude stopped on an error', 'Claude stopped on an error in'],
  working: ['Claude was still working', 'Claude was still working on'],
  tool: ['Claude was still working', 'Claude was still working on'],
};

/**
 * The session the owner left (U2-F15): the one they last prompted, if that was
 * shortly before the break; else one waiting on them, on the project first. A
 * session that is only working, and was not the owner's, is not theirs to resume.
 */
function agentLeft(state: KernelState, breakStartMs: number, projectId: string | null): AgentFleetEntry | null {
  const fleet = state.agent.fleet ?? [];
  const attended = state.agent.attended;
  const mine = attended && breakStartMs - Date.parse(attended.at) <= ATTENDED_BEFORE_MS ? fleet.find((s) => s.id === attended.id) : undefined;
  if (mine) return mine;
  const waiting = fleet.filter((s) => OWNER_WAITS.includes(s.state)).sort((a, b) => OWNER_WAITS.indexOf(a.state) - OWNER_WAITS.indexOf(b.state) || b.since.localeCompare(a.since));
  return waiting.find((s) => projectId !== null && s.cwd.startsWith(projectId)) ?? waiting[0] ?? null;
}

const agentClause = (a: NonNullable<ResumePieces['agent']>): string => {
  const name = a.title ?? a.lastPrompt;
  return name ? `${AGENT_SAYS[a.state][1]} "${clip(name, 45)}"` : AGENT_SAYS[a.state][0];
};

/** Unpushed commits older than a week, or more than this many, are not what the owner left (U2-F20). */
export const UNPUSHED_FRESH_MS = 7 * 86_400_000;
export const MAX_PLAUSIBLE_AHEAD = 200;

/** A return after a night away, in these local hours, is a morning start (U2-F3): 27 of 28 first returns fell here. */
const MORNING_FROM_HOUR = 5;
const MORNING_UNTIL_HOUR = 11;
const MORNING_WEIGHT_MS = 2 * 60 * MINUTE;

/** A leave note is one line. */
export const MAX_NOTE_CHARS = 200;

/** Projects whose last intent line is kept. */
export const MAX_RESUME_INTENTS = 40;
/** The line stays a glance (U2-F28): long clauses are clipped, trailing ones dropped. */
export const MAX_LINE_CHARS = 120;

type ResumeState = NonNullable<KernelState['resume']>;
const EMPTY: ResumeState = { last: null, intents: {} };
const resumeOf = (state: KernelState): ResumeState => ({ ...EMPTY, ...state.resume });

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);
const projectName = (state: KernelState, id: string): string => state.project.known[id]?.name ?? id.split('/').filter(Boolean).at(-1) ?? id;

/**
 * What the record holds about what the owner left, each piece only when fresh:
 * seen within `HOT_ANCHOR_MS` before the break began. Pure over state.
 */
export function resumePieces(state: KernelState, breakStartMs: number, nowMs: number): ResumePieces {
  const pieces: ResumePieces = {};
  const fresh = (iso: string) => {
    const t = Date.parse(iso);
    return t <= nowMs && breakStartMs - t <= HOT_ANCHOR_MS;
  };

  // The intent line (U2-F9): a project's first, since that is the work thread; any line otherwise.
  const intents = Object.entries(resumeOf(state).intents).filter(([, v]) => fresh(v.at));
  const newest = (list: typeof intents) => [...list].sort((a, b) => b[1].at.localeCompare(a[1].at))[0];
  const intent = newest(intents.filter(([id]) => id !== '')) ?? newest(intents);
  if (intent) {
    pieces.intent = intent[1];
    if (intent[0] !== '') pieces.project = { id: intent[0], name: projectName(state, intent[0]) };
  }

  // A hot thread only: touched within a few hours BEFORE the break began, or it
  // is just the newest open branch, not the one the owner left.
  const thread = mostRecentOpenThread(state);
  const touched = thread ? Date.parse(thread.lastTouchedAt) : NaN;
  // And on the project the intent names: another project's branch is not this work.
  const sameProject = !pieces.project || thread?.projectId === pieces.project.id;
  if (thread && sameProject && touched <= breakStartMs + EMIT_WINDOW_MS && breakStartMs - touched <= HOT_ANCHOR_MS) {
    pieces.thread = { id: thread.id, name: thread.name };
    if (!pieces.project && thread.projectId) pieces.project = { id: thread.projectId, name: thread.projectName ?? projectName(state, thread.projectId) };
  }

  // The branch from the repository itself (U2-F11), else the thread's.
  const branch = (pieces.project ? state.project.known[pieces.project.id]?.branch : null) ?? (pieces.thread ? thread?.branch : null) ?? null;
  if (branch) pieces.branch = branch;

  // A ticket the work reached (U2-F12): named by the branch, else worked on just
  // before the break. `seen` alone is often an OCR misread of another key.
  const worked = Object.values(state.tickets ?? {}).filter((t) => t.stage !== 'seen');
  const ticket = (branch ? worked.find((t) => branch.toLowerCase().includes(t.id.toLowerCase())) : undefined) ?? worked.filter((t) => fresh(t.lastSeen)).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))[0];
  if (ticket) pieces.ticket = { id: ticket.id, stage: ticket.stage, pr: ticket.pr };

  const inProject = (path: string) => !pieces.project || path.startsWith(pieces.project.id);
  // The last failure in this project that has not passed since (U2-F17).
  const failure = Object.entries(state.shell.lastFailure ?? {})
    .filter(([cwd, f]) => inProject(cwd) && fresh(f.at))
    .sort((a, b) => b[1].at.localeCompare(a[1].at))[0];
  if (failure) pieces.failure = { ...failure[1], cwd: failure[0] };

  // The tab in front before the break (U2-F18): revisited within 30 min after 64 of 95 breaks.
  const tab = state.browser.current;
  if (tab && fresh(tab.updatedAt)) pieces.tab = { url: `https://${tab.host}${tab.path}`, title: tab.title };

  // Arc's space, when the owner left from Arc: the file is only ever the latest state, never history.
  const arc = resumeOf(state).arc;
  const inArc = state.window.active?.processName === 'Arc' || state.browser.current?.app === 'Arc';
  if (arc && inArc && arc.tabs.length > 0) pieces.tabs = { space: arc.space, tabs: arc.tabs };

  const file = resumeOf(state).lastFile;
  if (file && fresh(file.at) && inProject(file.path)) pieces.file = { path: file.path, app: file.app };

  // Unpushed, only when recent and plausible (U2-F20): weeks-old and runaway counts were noise.
  const ahead = pieces.project ? state.git.unpushed[pieces.project.id] : undefined;
  if (ahead && ahead.ahead < MAX_PLAUSIBLE_AHEAD && breakStartMs - Date.parse(ahead.since) <= UNPUSHED_FRESH_MS) pieces.unpushed = { branch: ahead.branch, ahead: ahead.ahead };

  // What rose while away (U2-F25): 91 of 174 breaks had one, so it never enters the line.
  const rose = Object.entries(state.pressure.byApp).filter(([, b]) => b.count > 0 && Date.parse(b.since) > breakStartMs && Date.parse(b.since) <= nowMs).map(([app, b]) => ({ app, count: b.count }));
  if (rose.length) pieces.badges = rose.sort((a, b) => b.count - a.count).slice(0, 4);

  const left = agentLeft(state, breakStartMs, pieces.project?.id ?? null);
  if (left) pieces.agent = { id: left.id, ...(left.sid ? { sid: left.sid } : {}), cwd: left.cwd, state: left.state, title: left.title ?? null, lastPrompt: left.lastPrompt ?? null, since: left.since };
  pieces.leftFromAgent = AGENT_APPS.has(state.window.active?.processName ?? '');
  return pieces;
}

/** The lead and the clauses after it, most important first. Null when nothing names the work. */
function clauses(pieces: ResumePieces): string[] | null {
  // Left from the agent app: what the agent was doing leads (36% of breaks
  // started in Claude, 2% in an editor). Otherwise the intent does, and the
  // agent follows only when it waits on the owner.
  const agent = pieces.agent ? agentClause(pieces.agent) : null;
  const intent = pieces.intent ? clip(pieces.intent.text, 70) : null;
  const waits = pieces.agent && OWNER_WAITS.includes(pieces.agent.state);
  const [lead, second] = pieces.leftFromAgent && agent ? [agent, null] : [intent ?? (waits ? agent : null), intent && waits ? agent : null];
  const fallback = pieces.thread ? `on ${pieces.thread.name}` : null;
  // The owner's own next step comes first (U2-F35): 80 of 87 notes in TaCoS held one, the summaries none.
  const note = pieces.note ? `your note: “${clip(pieces.note.text, 60)}”` : null;
  if ((note ?? lead ?? fallback) === null) return null;
  const out = note ? [note, ...(lead ? [lead] : [])] : [(lead ?? fallback) as string];
  if (second) out.push(second);
  if (pieces.project) out.push(pieces.project.name);
  if (pieces.branch) out.push(pieces.branch);
  else if (pieces.thread && lead !== null) out.push(pieces.thread.name);
  const t = pieces.ticket;
  const pr = t?.pr?.number ? `PR #${t.pr.number}${t.pr.reviewState ? ` ${t.pr.reviewState.toLowerCase().replace(/_/g, ' ')}` : ''}` : null;
  // The branch usually names the ticket already; then only its PR is news.
  if (t && !(pieces.branch ?? '').toLowerCase().includes(t.id.toLowerCase())) out.push(pr ? `${t.id} (${pr})` : t.id);
  else if (pr) out.push(pr);
  if (pieces.failure) out.push(`\`${clip(pieces.failure.command, 30)}\` failed`);
  if (pieces.file) out.push(pieces.file.path.split('/').pop() ?? pieces.file.path);
  return out;
}

/** "Back after 40 min — Fixing the retry test · puzzlebox-studio · BOX-484", at most `MAX_LINE_CHARS`. */
export function resumeLineText(prefix: string, pieces: ResumePieces, sep = ' — '): string | null {
  const parts = clauses(pieces);
  if (parts === null) return null;
  const join = () => `${prefix}${sep}${parts.join(' · ')}`;
  while (join().length > MAX_LINE_CHARS && parts.length > 1) parts.pop();
  return clip(join(), MAX_LINE_CHARS);
}

/** One labelled line per piece: the gate's record and the replay read these. */
function evidenceOf(awayMs: number, pieces: ResumePieces): string[] {
  const out = [`away ${fmtMinutes(awayMs)}`];
  if (pieces.note) out.push(`note: ${pieces.note.text}`);
  if (pieces.intent) out.push(`intent: ${pieces.intent.text}`);
  if (pieces.project) out.push(`project: ${pieces.project.name}`);
  if (pieces.thread) out.push(`thread: ${pieces.thread.name}`);
  if (pieces.branch) out.push(`branch: ${pieces.branch}`);
  if (pieces.ticket) out.push(`ticket: ${pieces.ticket.id} (${pieces.ticket.stage})`);
  if (pieces.failure) out.push(`failure: ${pieces.failure.command} (exit ${pieces.failure.exitCode})`);
  if (pieces.file) out.push(`file: ${pieces.file.path}`);
  if (pieces.unpushed) out.push(`unpushed: ${pieces.unpushed.ahead}`);
  if (pieces.tab) out.push(`tab: ${pieces.tab.url}`);
  if (pieces.tabs) out.push(`tabs: ${pieces.tabs.tabs.length}${pieces.tabs.space ? ` in ${pieces.tabs.space}` : ''}`);
  if (pieces.agent) out.push(`agent: ${pieces.agent.state}${pieces.agent.title ? ` · ${pieces.agent.title}` : ''}`);
  return out;
}

function candidateEffect(event: { ts: string; id: string }, candidate: NoticeCandidate): Effect {
  return {
    type: 'EmitEvent',
    event: { id: deriveId(event.ts, event.id, 'return-from-break', candidate.key), type: 'notice:candidate', ts: event.ts, payload: { timestamp: event.ts, ...candidate } },
  };
}

/** Away from a project this long is a return after days (U2-F5): about two a month, the highest-value case. */
export const PROJECT_RETURN_MS = 3 * 86_400_000;
/** A run of one project this long counts for a switch-back (U2-F6); raw flips are shorter. */
export const SWITCH_RUN_MS = 10 * MINUTE;
const MAX_SEEN_PROJECTS = 40;

/** What the record keeps about one project, however old: for a return to it. */
function projectPieces(state: KernelState, projectId: string): ResumePieces {
  const pieces: ResumePieces = { project: { id: projectId, name: projectName(state, projectId) } };
  const intent = resumeOf(state).intents[projectId];
  if (intent) pieces.intent = intent;
  const branch = state.project.known[projectId]?.branch;
  if (branch) pieces.branch = branch;
  const thread = state.commitments.open.filter((c) => c.source !== 'speech' && c.projectId === projectId).sort((a, b) => b.lastTouchedAt.localeCompare(a.lastTouchedAt))[0];
  if (thread) pieces.thread = { id: thread.id, name: thread.name };
  return pieces;
}

/**
 * A certain moment closed: keep when each project was last worked on and the
 * runs of work, and say so when the owner comes back to a project after days
 * (U2-F5, pushed) or to the one they were on before a detour of ten minutes or
 * more the same day (U2-F6, the list only). Unattributed moments neither break
 * nor extend a run.
 */
function foldClose(state: KernelState, event: SanitizedEvent, closed: NonNullable<KernelState['project']['lastClosedMoment']>): ReturnType<Rule> {
  const resume = { ...resumeOf(state), closedAt: event.ts };
  const p = closed.projectId;
  if (!p || closed.confidence !== 'certain' || !closed.endedAt) return { state: { ...state, resume }, effects: [] };
  const end = closed.endedAt;
  const start = new Date(Date.parse(end) - (closed.durationMs ?? 0)).toISOString();
  const tz = state.config.timezone;

  const prior = resume.seen?.[p];
  const seen = Object.fromEntries(Object.entries({ ...resume.seen, [p]: end }).sort((a, b) => b[1].localeCompare(a[1])).slice(0, MAX_SEEN_PROJECTS));
  const runs = [...(resume.runs ?? [])];
  const tail = runs.at(-1);
  const extends_ = tail?.projectId === p;
  if (extends_) runs[runs.length - 1] = { ...tail!, to: end };
  else runs.push({ projectId: p, from: start, to: end });
  const kept = runs.slice(-3);
  // Back on the line's project soon after it was shown: the line was used (U2-F37).
  const last = resume.last;
  const followed = last && !last.followed && last.pieces.project?.id === p && Date.parse(end) - Date.parse(last.at) <= FOLLOWED_WITHIN_MS && Date.parse(end) >= Date.parse(last.at);
  const learn = followed && resume.learn ? { ...resume.learn, followed: resume.learn.followed + 1 } : resume.learn;
  const next: KernelState = { ...state, resume: { ...resume, seen, runs: kept, ...(followed ? { last: { ...last, followed: true }, learn } : {}) } };

  const pieces = projectPieces(state, p);
  const say = (trigger: ResumeTrigger, key: string, prefix: string, phasic: boolean, awayMs: number): ReturnType<Rule> => {
    // The prefix names the project already.
    const line = resumeLineText(prefix, { ...pieces, project: null }) ?? prefix;
    const last: ResumeLine = { at: event.ts, trigger, awayMs, key, line, pieces };
    const candidate: NoticeCandidate = {
      shape: 'transition',
      kind: 'return-from-break',
      key,
      surprise: phasic ? 3 : 1,
      precision: HOT_PRECISION,
      valueHalfLifeMs: phasic ? VALUE_HALF_LIFE_MS : null,
      observation: line,
      evidence: [`away from ${pieces.project!.name} ${fmtMinutes(awayMs)}`, ...evidenceOf(awayMs, pieces).slice(1)],
      concerns: [`project:${p}`],
    };
    return { state: { ...next, resume: withLine(next.resume!, last) }, effects: [candidateEffect(event, candidate)] };
  };

  if (prior && Date.parse(start) - Date.parse(prior) >= PROJECT_RETURN_MS) {
    const days = Math.floor((Date.parse(start) - Date.parse(prior)) / 86_400_000);
    return say('project-return', `resume-project:${p}:${localDate(end, tz)}`, `Back on ${pieces.project!.name} after ${days} days`, true, Date.parse(start) - Date.parse(prior));
  }
  const [a, b] = kept.length === 3 && !extends_ ? kept : [];
  const long = (r: { from: string; to: string }) => Date.parse(r.to) - Date.parse(r.from) >= SWITCH_RUN_MS;
  if (a && b && a.projectId === p && b.projectId !== p && long(a) && long(b) && localDate(a.to, tz) === localDate(end, tz)) {
    return say('switch-back', `resume-switch:${p}:${localDate(end, tz)}`, `Back on ${pieces.project!.name}`, false, Date.parse(start) - Date.parse(a.to));
  }
  return { state: next, effects: [] };
}

/** A line followed by the owner back on its project this soon counts as used (U2-F37). */
export const FOLLOWED_WITHIN_MS = 10 * MINUTE;
const PIECE_KEYS = ['note', 'agent', 'intent', 'branch', 'ticket', 'failure', 'file', 'tab', 'tabs', 'thread', 'unpushed'] as const;

/** A new line: it replaces the last, and every piece it carries counts as shown. */
function withLine(resume: ResumeState, last: ResumeLine): ResumeState {
  const learn = resume.learn ?? { pieces: {}, lines: 0, followed: 0 };
  const pieces = { ...learn.pieces };
  for (const k of PIECE_KEYS) if (last.pieces[k]) pieces[k] = { shown: (pieces[k]?.shown ?? 0) + 1, opened: pieces[k]?.opened ?? 0 };
  return { ...resume, last, learn: { ...learn, pieces, lines: learn.lines + 1 } };
}

/** A restore link opened (`resume:opened`) on the line still shown. */
function foldOpened(state: KernelState, payload: { piece?: unknown }): ReturnType<Rule> {
  const resume = resumeOf(state);
  const piece = typeof payload.piece === 'string' ? payload.piece : '';
  const learn = resume.learn;
  if (!learn || !learn.pieces[piece]) return { state, effects: [] };
  const entry = learn.pieces[piece];
  return { state: { ...state, resume: { ...resume, learn: { ...learn, pieces: { ...learn.pieces, [piece]: { ...entry, opened: entry.opened + 1 } } } } }, effects: [] };
}

/** A meeting's debrief window: `meetingFollowup` asks 2–20 min after the end. */
const MEETING_RETURN_MS = 20 * MINUTE;

/**
 * Back from a meeting (U2-F4): what was left before it. Captured at the first
 * input inside the meeting, said once at the first input after it ends, to the
 * list only — the debrief question is the meeting's interruption. A meeting
 * the owner was not in (hearing awake, almost nothing heard) says nothing.
 */
function meetingReturn(state: KernelState, event: SanitizedEvent): ReturnType<Rule> | null {
  const resume = resumeOf(state);
  const ts = Date.parse(event.ts);
  const inRoom = ([, m]: [string, NonNullable<KernelState['meetings']>['seen'][string]]) => {
    const minutes = (Date.parse(m.end) - Date.parse(m.start)) / MINUTE;
    return !(m.listened === true && (m.heard ?? 0) > 0 && (m.heard ?? 0) < minutes);
  };
  const under = Object.entries(state.meetings?.seen ?? {}).find(([, m]) => Date.parse(m.start) <= ts && ts < Date.parse(m.end));
  if (under && inRoom(under) && resume.meeting?.key !== under[0]) {
    const meeting = { key: under[0], title: under[1].title, end: under[1].end, pieces: resumePieces(state, ts, ts), said: false };
    return { state: { ...state, resume: { ...resume, meeting } }, effects: [] };
  }
  const m = resume.meeting;
  if (!m || m.said || ts < Date.parse(m.end) || ts - Date.parse(m.end) > MEETING_RETURN_MS) return null;
  const said = { ...state, resume: { ...resume, meeting: { ...m, said: true } } };
  const line = resumeLineText(`Back from ${clip(m.title, 40)}. Before it`, m.pieces, ': ');
  if (line === null) return { state: said, effects: [] };
  const key = `resume-meeting:${m.end}`;
  const last: ResumeLine = { at: event.ts, trigger: 'meeting-end', awayMs: ts - Date.parse(m.end), key, line, pieces: m.pieces };
  const candidate: NoticeCandidate = { shape: 'transition', kind: 'return-from-break', key, surprise: 1, precision: HOT_PRECISION, valueHalfLifeMs: null, observation: line, evidence: ['after a meeting', ...evidenceOf(0, m.pieces).slice(1)], concerns: [m.pieces.project ? `project:${m.pieces.project.id}` : 'resume'] };
  return { state: { ...said, resume: withLine(said.resume!, last) }, effects: [candidateEffect(event, candidate)] };
}

/** A window's local file (not a page URL, not a tool's cache) → the last file. */
function foldFile(state: KernelState, payload: { documentPath?: unknown; processName?: unknown }, ts: string): ReturnType<Rule> {
  const path = typeof payload.documentPath === 'string' ? payload.documentPath : '';
  if (!/^[~/]/.test(path) || IGNORED_PATH.test(path)) return { state, effects: [] };
  const app = typeof payload.processName === 'string' ? payload.processName : '';
  return { state: { ...state, resume: { ...resumeOf(state), lastFile: { path, app, at: ts } } }, effects: [] };
}

/** `moment:intent` → the last intent line per project, newest kept. */
function foldIntent(state: KernelState, payload: { projectId?: unknown; confidence?: unknown; text?: unknown }, ts: string): ReturnType<Rule> {
  if (typeof payload.text !== 'string' || payload.text.trim() === '') return { state, effects: [] };
  // Only a certain attribution files a line under its project: a guessed one was
  // "watching a video" filed under the repository git was active in.
  const certain = payload.confidence === undefined || payload.confidence === 'certain';
  const id = typeof payload.projectId === 'string' && certain ? payload.projectId : '';
  const resume = resumeOf(state);
  const intents = Object.fromEntries(
    Object.entries({ ...resume.intents, [id]: { text: payload.text.trim(), at: ts } })
      .sort((a, b) => b[1].at.localeCompare(a[1].at))
      .slice(0, MAX_RESUME_INTENTS),
  );
  return { state: { ...state, resume: { ...resume, intents } }, effects: [] };
}

/**
 * "Where was I?" — a line when a break ends, built from what the record holds
 * about what the owner left.
 *
 * ## Why this is a producer at all
 *
 * Every omission producer notices something that did NOT happen; this notices a
 * TRANSITION that did — the moment of return, which is exactly when a reconnect prompt
 * is worth anything and never again. It is the complement of `absent:break`, not a
 * duplicate: that one fires when a break is overdue (too long WITHOUT a break), this
 * fires when a break ENDS and there is work to pick back up.
 *
 * ## Read the idle state BEFORE `idleTrack` moves it — the placement is load-bearing
 *
 * `idleTrack` sets `lastActiveAt` to the very `input:activity` event that ends a
 * break. So the break length is only legible on the returning event itself, and
 * only to a rule that folds BEFORE `idleTrack`. `RULE_MANIFEST` places it
 * immediately before `idleTrack`. The break is `event.ts − lastActiveAt`, not a
 * count of zero windows: a closed lid emits no windows at all.
 *
 * ## Two outputs
 *
 * `state.resume.last` is the line itself, for the Today card, whatever the gate
 * decides later: a pull surface may always answer "where was I". The
 * `notice:candidate` is the push, and only for a real break (15 min – 4 h), back to
 * work rather than leisure, with something that names the work. With nothing
 * to name there is nothing to say, which keeps the producer quiet most of the time.
 */
export const returnFromBreak: Rule = (state, event) => {
  const closed = state.project.lastClosedMoment;
  if (closed?.endedAt === event.ts && resumeOf(state).closedAt !== event.ts) {
    const out = foldClose(state, event, closed);
    const rest = returnFromBreak(out.state, event);
    return { state: rest.state, effects: [...out.effects, ...rest.effects] };
  }
  if (event.type === 'moment:intent') return foldIntent(state, event.payload as { projectId?: unknown; confidence?: unknown; text?: unknown }, event.ts);
  if (event.type === 'resume:opened') return foldOpened(state, event.payload as { piece?: unknown });
  if (event.type === 'resume:note') {
    const text = typeof (event.payload as { text?: unknown }).text === 'string' ? ((event.payload as { text: string }).text.trim().slice(0, MAX_NOTE_CHARS)) : '';
    return { state: { ...state, resume: { ...resumeOf(state), note: text ? { text, at: event.ts } : null } }, effects: [] };
  }
  if (event.type === 'browser:arc-space') {
    const p = event.payload as { title?: unknown; tabs?: unknown };
    const tabs = (Array.isArray(p.tabs) ? p.tabs : []).filter((t): t is { url: string; title: string | null } => typeof t?.url === 'string').map((t) => ({ url: t.url, title: typeof t.title === 'string' ? t.title : null }));
    return { state: { ...state, resume: { ...resumeOf(state), arc: { space: typeof p.title === 'string' ? p.title : null, tabs, at: event.ts } } }, effects: [] };
  }
  if (event.type === 'window:changed') return foldFile(state, event.payload as { documentPath?: unknown; processName?: unknown }, event.ts);
  if (event.type !== 'input:activity') return { state, effects: [] };

  // Pre-transition idle state: this rule folds before `idleTrack`, so
  // `lastActiveAt` is still the last input BEFORE this event.
  if (!hasActivity(event.payload as InputActivityPayload)) return { state, effects: [] };
  const meeting = meetingReturn(state, event);
  if (meeting) return meeting;
  const lastActiveAt = state.lifeEvent.idle.lastActiveAt;
  if (!lastActiveAt) return { state, effects: [] };

  // By the wall clock (U2-F1). Counting zero windows read a sleep as no time at
  // all: the input sensor emits nothing while the lid is closed, so 26 of 34
  // breaks of 1–4 h went unseen.
  const breakMs = Date.parse(event.ts) - Date.parse(lastActiveAt);
  if (breakMs < MIN_BREAK_MS) return { state, effects: [] };

  // Returning to leisure is not returning to a work thread. `state.window.active` is the
  // last window seen before the break; if it reads as the owner's own time, this nudge
  // would be an intrusion rather than a help.
  const active = state.window.active;
  if (active && classifyActivity(active.processName, active.windowTitle, state.config.leisureRules) === 'personal') {
    return { state, effects: [] };
  }

  const pieces = resumePieces(state, Date.parse(lastActiveAt), Date.parse(event.ts));
  // A note written before this break is for this return; it is spent by it.
  const note = resumeOf(state).note;
  if (note && Date.parse(note.at) <= Date.parse(lastActiveAt) + EMIT_WINDOW_MS) pieces.note = note;
  const tz = state.config.timezone;
  const today = localDate(event.ts, tz);
  // The first return of the day after a night away (U2-F3): what was left yesterday.
  const hour = localHour(event.ts, tz);
  const morning = breakMs > MAX_BREAK_MS && hour >= MORNING_FROM_HOUR && hour < MORNING_UNTIL_HOUR;
  const trigger: ResumeTrigger = morning ? 'morning' : 'break';
  // Once per local day: a second long break the same day habituates rather than
  // re-announcing. Keeping it constant within the day is what makes habituation do
  // that work.
  const key = morning ? `resume-morning:${today}` : `return-from-break:${today}`;
  const left = `${formatClock(lastActiveAt, tz)}${localDate(lastActiveAt, tz) === today ? '' : ' yesterday'}`;
  const line = resumeLineText(morning ? `Morning. You stopped at ${left}` : `Back after ${fmtMinutes(breakMs)}`, pieces);
  if (line === null) return { state, effects: [] };

  const last: ResumeLine = { at: event.ts, trigger, awayMs: breakMs, key, line, pieces };
  const next: KernelState = { ...state, resume: { ...withLine(resumeOf(state), last), ...(pieces.note ? { note: null } : {}) } };
  if (breakMs > MAX_BREAK_MS && !morning) return { state: next, effects: [] };

  const candidate: NoticeCandidate = {
    shape: 'transition',
    kind: 'return-from-break',
    key,
    // A morning weighs like a two-hour break: enough to be pushed once, not a night's worth.
    surprise: Math.min(breakMs, MORNING_WEIGHT_MS) / REFERENCE_BREAK_MS,
    precision: HOT_PRECISION,
    // A SHORT break is ambient, a LONG one is worth a word. `valueHalfLifeMs` is
    // what routes a candidate to the urgent (phasic) path in the gate, and the
    // first version sent every break there. At the rule's own honest precision
    // of 0.4 a 30-minute break weighs 0.6 with an open thread — far under the
    // 1.6 phasic bar — so the producer fired 13 times in a week and was dropped
    // every time. Below an hour it is now tonic: it clears the 0.55 tonic bar,
    // and lands as context for the next turn rather than as an interruption,
    // which is what "you're back — you were on BOX-484" should be.
    valueHalfLifeMs: breakMs >= LONG_BREAK_MS ? VALUE_HALF_LIFE_MS : null,
    observation: line,
    evidence: evidenceOf(breakMs, pieces),
    // The thing the line is about, so the gate weighs it as a concern.
    concerns: [pieces.thread?.id ?? (pieces.project ? `project:${pieces.project.id}` : pieces.agent ? `agent:${pieces.agent.id}` : 'resume')],
  };
  return { state: next, effects: [candidateEffect(event, candidate)] };
};
