// W1: what Gnomon is shown at the start of a turn, as data, and the one place
// that data becomes prose.
//
// `turnBrief` is pure: `state`, the reads a turn makes when it starts (the
// ambient memory's `gatherAmbientInput`, once per turn, or null), the turn's own
// input, and a clock. The brief is the one context a turn gets: the clock, the
// memory and the board no longer ride as system-prompt contexts (W1 step 5). It returns keyed facts — `git.unpushed`, `agents.idle`, `failing`, … —
// each with the value it rests on and the clause that says it. `renderBrief`
// joins them in the order the old `nowLine` did, so the model reads the same
// words; the difference is that the facts also go to the log (`chat:shown`),
// and `conversationTrack` can tell afterwards which of them Gnomon repeated.
//
// Every number shown carries its n. The routine clause used to end on a
// hard-coded "about 27% reliable"; it now says `formatParam(param('routine.next'))`
// (W5 step 6): the forecasts `calibrate` scored against the next step, with n.
//
// Keys `processName`, `bundleId` and `path` never appear in a fact value:
// sanitize-at-ingest treats them by name. `app` is the word here.
import { composeAmbientContext, type AmbientInput } from './ambient-context.js';
import { formatParam, param } from './calibrated.js';
import { nowSnapshot } from './now.js';
import { nowLine } from './tools/ask-prompt.js';
import { isRuleIntent } from './watch.js';
import type { KernelState } from './types.js';

/** Bumped when the brief's shape or wording changes; `chat:shown` records it. */
export const BRIEF_VERSION = 1;


export type BriefCauseKind = 'owner' | 'notice' | 'bring' | 'work';
export interface BriefCause {
  kind: BriefCauseKind;
  noticeKey?: string | null;
  askId?: string | null;
}

export interface BriefFact {
  key: string;
  value: Record<string, unknown>;
  /** The clause the model reads. Only `renderBrief` joins these. */
  says: string;
}

export interface TurnBriefInput {
  sessionId: string;
  cause?: BriefCause;
  /** What the owner is looking at, as the client names it. */
  place?: string;
  /** Gnomon's own question, when the owner's message answers it. */
  answering?: string;
  /** The owner's words, read only for the watch-rule hint. */
  text?: string;
}

export interface TurnBrief {
  v: number;
  at: string;
  sessionId: string;
  cause: BriefCause;
  facts: BriefFact[];
  hints: { answering: string | null; watchRule: boolean; place: string | null };
  /** The ambient memory reads, when the caller made them. */
  memory: AmbientInput | null;
  /** The date and time in the owner's zone: a model has no clock, and every tool's `date` is local. */
  clock: string;
}

export const REPLY_RULES = [
  'How to reply: answer the question in your first sentence, then stop. Match the length asked; with none, one to three sentences.',
  'Only what was asked — at most one unasked point, and only if it matters today.',
  'Never end with an offer ("Want me to…", "Say the word…", "I can also…").',
  'If they only acknowledge ("ok", "thanks", "nice"), reply with a few words and nothing else. A choice only they can make is an ask_user_question, not a question in prose.',
  'Use as few tools as answer it; the shell only when no gnomon_* tool can.',
  'A plan you write with todo_write is shown to the owner: mark each step completed when it is done, and before you answer, do every step or remove it from the list.',
].join(' ');

const WAITS_ON: Record<string, string> = { tool: ' (tool call, maybe an approval)', permission: ' (an approval)', question: ' (a question for the owner)', plan: ' (a plan to approve)', failed: ' (stopped on an error)' };
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;


/** The facts, in the order the model reads them. */
function factsOf(state: KernelState | null | undefined, nowMs: number): BriefFact[] {
  const now = nowSnapshot(state, nowMs);
  const facts: BriefFact[] = [];
  const add = (key: string, value: Record<string, unknown>, says: string) => facts.push({ key, value, says });

  if (now.idle) add('now.idle', { idle: true }, 'the owner is idle');
  else if (now.app) add('now.app', { app: now.app, name: now.project, min: now.momentMin }, `the owner is in ${now.app}${now.project ? ` on ${now.project}` : ''}${now.momentMin !== null ? `, ${now.momentMin} min into this stretch` : ''}`);
  if (now.intent) add('now.intent', { intent: now.intent }, `doing: ${now.intent}`);
  if (now.branch) add('now.branch', { branch: now.branch, commits: now.commits }, `branch ${now.branch}${now.commits > 0 ? `, ${plural(now.commits, 'commit')} so far` : ''}`);
  if (now.flowMin !== null && now.flowMin >= 5) add('now.flow', { min: now.flowMin }, `in sustained focus for ${now.flowMin} min`);
  if (now.nextStep) {
    const held = param(state, 'routine.next');
    add(
      'now.nextStep',
      { app: now.nextStep.process, support: now.nextStep.support, scored: { n: held.n, value: Math.round(held.value * 1000) / 1000 } },
      `from here they usually open ${now.nextStep.process} next (seen ${now.nextStep.support} times; a tendency: such forecasts held ${formatParam(held)})`,
    );
  }
  if (now.switchesLastHour !== null) add('now.switches', { count: now.switchesLastHour }, `${now.switchesLastHour} app switch${now.switchesLastHour === 1 ? '' : 'es'} in the last hour`);
  if (now.held > 0) add('notices.held', { count: now.held }, `${plural(now.held, 'observation')} held back for a better moment`);
  if (now.place) add('now.place', { place: now.place, activity: now.activity }, `the phone puts them at ${now.place}${now.activity ? `, ${now.activity}` : ''}`);
  else if (now.activity) add('now.activity', { activity: now.activity }, `the phone says they are ${now.activity}`);
  if (now.sleep) add('owner.sleep', { hours: now.sleep.hours }, `they slept ${now.sleep.hours} h last night`);
  else if (now.wokeAt) add('owner.woke', { at: now.wokeAt }, `they woke at ${clock(now.wokeAt)}`);
  if (now.page) add('now.page', { host: now.page.host, page: now.page.path, title: now.page.title, min: now.page.min }, `reading ${now.page.host}${now.page.path === '/' ? '' : now.page.path}${now.page.title ? ` ("${now.page.title.slice(0, 60)}")` : ''}${(now.page.min ?? 0) >= 2 ? `, ${now.page.min} min on it` : ''}`);
  if (now.call) add('now.call', { app: now.call.app, kind: now.call.kind, min: now.call.min }, `on a ${now.call.kind === 'personal-call' ? 'personal call' : now.call.kind === 'work-call' ? 'work call' : 'call'} in ${now.call.app} for ${now.call.min} min`);
  if (now.failing) add('failing', { count: now.failing.count, lastCommand: now.failing.lastCommand.slice(0, 60), exitCode: now.failing.exitCode }, `${now.failing.count} commands in a row have failed, last \`${now.failing.lastCommand.slice(0, 60)}\` (exit ${now.failing.exitCode})`);
  if (now.agents) {
    const idle = now.agents.idle.slice(0, 3);
    add(
      'agents.idle',
      { total: now.agents.total, working: now.agents.working, idle: idle.map((a) => ({ name: a.project, state: a.state, min: a.min, ...(a.title ? { title: a.title } : {}) })) },
      `${plural(now.agents.total, 'Claude session')} open, ${now.agents.working} working${idle.length > 0 ? `; waiting on the owner: ${idle.map((a) => `${a.title ? `'${a.title}' in ` : ''}${a.project} ${a.min} min${WAITS_ON[a.state] ?? ''}`).join(', ')}` : ''}`,
    );
  }
  // One fact for every working copy together, with each copy's count and name: a reply that names a repo
  // (however few its commits) is a mention of it, and a follow-up resolves per cwd.
  // `since` is when Sundial first SAW them unpushed, not when they were made: "263 commits since 13:51" read as a burst of work.
  if (now.unpushed) {
    const repos = Object.entries(state?.git?.unpushed ?? {}).filter(([, e]) => e.ahead > 0).map(([cwd, e]) => ({ cwd, name: cwd.replace(/\/+$/, '').split('/').pop() || cwd, ahead: e.ahead }));
    add('git.unpushed', { total: now.unpushed.total, repos, since: now.unpushed.since }, `${plural(now.unpushed.total, 'commit')} not pushed yet${now.unpushed.repos > 1 ? ` across ${now.unpushed.repos} repos` : ''} (Sundial first saw them unpushed at ${clock(now.unpushed.since)}; a push clears this within a minute)`);
  }
  if (now.screenRefs.length > 0) add('screen.refs', { refs: now.screenRefs }, `on screen: ${now.screenRefs.join(', ')}`);
  if (now.hotFile) add('files.hot', { relPath: now.hotFile.relPath, changes: now.hotFile.changes }, `${now.hotFile.relPath} has been touched ${now.hotFile.changes} times today`);
  if (now.pressure.length > 0) add('pressure', { badges: now.pressure }, now.pressure.map((p) => `${p.app} badge at ${p.count} for ${p.hours}h`).join(', '));
  return facts;
}

export function turnBrief(state: KernelState | null | undefined, reads: AmbientInput | null, input: TurnBriefInput, nowMs: number): TurnBrief {
  const answering = (input.answering ?? '').trim().slice(0, 400);
  const place = (input.place ?? '').trim().slice(0, 200);
  return {
    v: BRIEF_VERSION,
    at: new Date(nowMs).toISOString(),
    sessionId: input.sessionId,
    cause: { kind: input.cause?.kind ?? 'owner', noticeKey: input.cause?.noticeKey ?? null, askId: input.cause?.askId ?? null },
    facts: factsOf(state, nowMs),
    hints: { answering: answering === '' ? null : answering, watchRule: typeof input.text === 'string' && isRuleIntent(input.text), place: place === '' ? null : place },
    memory: reads,
    clock: nowLine(new Date(nowMs), state?.config?.timezone ?? 'UTC'),
  };
}

/** The present, as one line: the old `nowLine`. */
export function presentLine(brief: TurnBrief): string {
  return brief.facts.length === 0 ? 'Nothing is being observed right now.' : `Right now: ${brief.facts.map((f) => f.says).join('; ')}.`;
}

/**
 * The whole text injected before the turn: the clock, the memory, the
 * `sections` other plugins add (the board), the hints, the present.
 * `REPLY_RULES` stays last: that is where the model listens (benched
 * 2026-09-23). A work job replies to no one, so it gets neither reply line.
 */
export function renderBrief(brief: TurnBrief, sections: string[] = []): string {
  const memory = brief.memory ? composeAmbientContext(brief.memory) : '';
  const replying = brief.cause.kind !== 'work';
  return [
    brief.clock,
    memory !== '' ? memory : null,
    ...sections,
    brief.hints.answering
      ? `The owner is ANSWERING a question Gnomon asked them: "${brief.hints.answering}". Their message is that answer. Keep what is worth keeping from it — decisions, who said what, follow-ups — with the tools you have (gnomon_assert with saidBy: 'owner' for facts — these are their own words), and reply briefly with what you kept. Do not ask the question again.`
      : null,
    brief.hints.place ? `The owner is looking at: ${brief.hints.place}.` : null,
    // UC4 F29: "tell me when…" is a standing rule, and the rule is tested on their past before it is kept.
    brief.hints.watchRule
      ? 'The owner is asking to be told when something happens. That is a watch rule: write the spec, backtest it with gnomon_test_rule (through gnomon_call), say in two lines how often it would have spoken and show one example, and adopt it with gnomon_adopt_rule only on their yes. A one-off time is a wake-up instead.'
      : null,
    presentLine(brief),
    replying ? 'A question like "what changed?", "why?" or "is that bad?" is about what is on that screen and what they are doing right now — resolve it there first, before reaching for anything broader. Do not recite this context back; use it.' : null,
    replying ? REPLY_RULES : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/** The `chat:shown` payload: what was shown, keyed, without the prose around it. */
export function shownPayload(brief: TurnBrief, briefId: string): Record<string, unknown> {
  return { sessionId: brief.sessionId, briefId, cause: brief.cause, v: brief.v, facts: brief.facts, hints: brief.hints };
}
