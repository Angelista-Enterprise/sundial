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
import { renderReplyRules } from './persona.js';
import { frontLook } from './read/last-look.js';
import { leftOpen, openedLine } from './read/opened.js';
import { isRigSession } from './read/rig-session.js';
import { skillLabel } from '@sundial/helpers/screen-routes.js';
import { taskOf } from '@sundial/helpers/task-of.js';
import type { AppRoutes } from './read/routes.js';
import { summonSigns } from './read/summon-evidence.js';
import { nowLine } from './tools/ask-prompt.js';
import { isRuleIntent } from './watch-words.js';
import type { KernelState } from './types.js';

/** Bumped when the brief's shape or wording changes; `chat:shown` records it. */
export const BRIEF_VERSION = 6;


/** `summon` (plan 15 step 2): the owner's words, said in the panel they called up over their work. */
export type BriefCauseKind = 'owner' | 'notice' | 'bring' | 'work' | 'summon';
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
  /** The text the owner has selected in the app below, when they attached the place. */
  selected?: string;
  /** Plan 15 step 3: the owner said this aloud (hold to talk); the first sentence of the reply is spoken. */
  voice?: boolean;
}

/** How a turn answers the owner (the turn plan, benched in lab/chat). Null when the owner did not write. */
export type Stance = 'light' | 'feeling' | 'quick' | 'task' | 'answer';

export interface TurnBrief {
  v: number;
  at: string;
  sessionId: string;
  cause: BriefCause;
  facts: BriefFact[];
  /** `stance` and `moment` are logged with the brief, so which plan a reply was written under can be measured. */
  hints: { answering: string | null; watchRule: boolean; place: string | null; stance: Stance | null; moment: string | null; summon?: { line: string | null; boundary: { kind: string; min: number } | null; selected: boolean }; voice?: true; referents?: Referents };
  /** Where this chat is: its last exchange, from `state.conversation`. Not logged: the turns are in the log already. */
  conversation: { owner: string | null; said: string | null; at: string } | null;
  /** The ambient memory reads, when the caller made them. */
  memory: AmbientInput | null;
  /** What worked before in the apps the message names or the owner is in (`read/routes.ts`), read from the log by the caller. Logged as the app names only. */
  routes: AppRoutes[];
  /** Set 2 R3: the skills the owner kept (`state.selfReview.skills`), the rig's only in its own chats. Set 5 R1: by id and clean name (`skillLabel`), never the old goal with its values. */
  skills?: string[];
  /** Set 3 R4: the notes the owner kept from Gnomon's self-review (`state.selfReview.notes`), for this turn's apps and Gnomon's own replies. */
  notes?: { app: string; line: string }[];
  /** The owner's selected text. Not logged: `hints.summon.selected` says only that it was there. */
  selected?: string;
  /** Set 4 R1: this chat's last task object (`state.tasks`, folded by `taskBoundary`; helpers `taskOf`), when it holds a step. The brief is built before the new request's `task:started`, so it is the request before this one. */
  task?: NonNullable<KernelState['task']>;
  /** The date and time in the owner's zone: a model has no clock, and every tool's `date` is local. */
  clock: string;
}

/** SET4 R2: what a follow-up with no place of its own can mean: the things Gnomon's last answer in this chat named, and its last look. */
export interface Referents { files: string[]; numbers: string[]; apps: string[]; look?: { app: string; window?: string } }

/** The api rendering; a runtime turn gets `renderReplyRules('runtime')` in its place (the chat adapter swaps it). */
export const REPLY_RULES = renderReplyRules('api');

// The turn plan's word rules (lab/chat, 2026-10-07): 72% right on 200 labelled
// turns and never once called a request small talk; a flash classifier was 77%
// for an extra call per turn, Jev 58%. ponytail: word rules until a miss costs more.
const SMALL = /^(hey|hi|hello|yo|morning|goedemorgen|hoi|ok(ay)?|thanks?( you)?|thx|nice|cool|great|yes|yeah|yep|no|nope|not now|good|sure|top|perfect|lol|haha)\b/i;
const SMALL_TALK = /^(how are you|how'?s it going|hoe gaat het)\b/i; // "what's up?" asks what is going on: a quick question
const FEELING = /\b(tired|wiped|exhausted|knackered|moe|frustrat\w*|annoy\w*|broken again|nothing works|ugh+|fml|so done|great day|good day|love it|nailed it)\b/i;
const GO_AHEAD = /^(yes|yeah|yep|ok(ay)?|sure|go ahead|do it|go for it|sounds good|please do|ja|doe maar)\b/i;
const OFFERED = /\?\s*$|\b(want me to|should i|shall i|i can|i could)\b/i;
const GO_ON = /\b(let'?s (continue|go|do it|do this)|continue|carry on|go on|keep going|next one|ga door)\b/i;
const WORK = /^(plan|draft|write|build|make|create|fix|walk me through|compare|analy[sz]e|review|audit|summari[sz]e|draw|research|investigate|find out)\b|step by step|one at a time/i;

/** The owner's message → how to answer it. `lastSaid` is Gnomon's previous reply: a "yes" to an offer is work. */
export function stanceOf(text: string, lastSaid = ''): Exclude<Stance, 'answer'> {
  const m = text.trim();
  const words = m.split(/\s+/).filter(Boolean).length;
  if (words <= 6 && ((GO_AHEAD.test(m) && OFFERED.test(lastSaid.slice(-300))) || GO_ON.test(m))) return 'task';
  if (words <= 25 && FEELING.test(m)) return 'feeling';
  if (SMALL_TALK.test(m) || (words <= 2 && !m.includes('?') && m.replace(/[^a-z]/gi, '').length < 4)) return 'light';
  if (WORK.test(m)) return 'task';
  if (words <= 4 && SMALL.test(m)) return 'light';
  return words <= 15 ? 'quick' : 'task';
}

const ASK_LESS = 'End with a question only when you cannot act without the answer.';
/** One line per stance, read just before the reply rules. */
/**
 * Plan 15 step 3: a spoken turn. Benched in lab/chat/readback.mjs against the old rule ("your first sentence,
 * under 20 words"), 12 cases × 2, judged by Haiku against four calibrated cases. On overall quality the bench
 * cannot separate the two: 22/24 each, at its ceiling. It separates them on how much is said (p50 41 words
 * against 17) and on the replies that ought to be summarised rather than read out, where this shape was 8/8 in
 * both runs and the old rule 3/8 then 6/8. The first run's 20/24 against 13/24 did NOT reproduce: its
 * "work done elsewhere" cases gave the model no tool result, so they measured a refusal.
 */
export const VOICE_LINE = `They said this aloud and will HEAR your first paragraph; everything after a blank line is only shown on screen.
Write the first paragraph as a colleague would say it out loud: plain speech, no lists, code, links or markdown, and never more than four sentences.
A question, a conversation or how they feel: the first paragraph is the whole answer, and there is nothing after it.
A long answer (a comparison, a status, many items): the first paragraph is the gist plus where the rest is, and the detail follows below it.
Work you carried out elsewhere: the first paragraph says what you did and what is still open, and the detail follows below it.`;

export const STANCE_LINE: Record<Stance, string> = {
  light: 'Their message is small talk — a greeting, an ok, thanks, or a stray keystroke. Reply like a person would: one or two short sentences, and always in words — never an empty reply. Do not bring up work (sessions, commits, tickets, promises) unless a meeting starts within 15 minutes, and use no tools. A stray keystroke: ask what they meant, in a few words.',
  feeling: `They are telling you how it is going. Meet that first, in a few words, like someone on their side. If they are stuck on something in front of you, name the one thing that would unblock it; if they are tired or done, say nothing about work. Do not go investigating unless they ask. ${ASK_LESS}`,
  quick: `Their message is a quick question. Answer exactly that in your first sentence — nothing next to it, no recap; three sentences at most. Use a tool only if the answer is not already in front of you. ${ASK_LESS}`,
  task: `Their message asks for real work (or says yes to work you offered). Take the room it needs — structured, complete, nothing padded. ${ASK_LESS}`,
  answer: 'Their message answers your question. Keep what is worth keeping, confirm it in one line, and ask one short follow-up only if the answer is ambiguous.',
};

/** What the moment asks of any reply, from the facts the brief already holds. */
function momentOf(facts: BriefFact[], phase: string | null, hour: number): string | null {
  const out: string[] = [];
  const fact = (key: string) => facts.find((f) => f.key === key)?.value;
  if (phase === 'meeting-soon') out.push('A meeting starts within 15 minutes: keep it short, and if anything, that meeting is the one thing to mention.');
  if (fact('now.call')) out.push('They are on a call: one short line.');
  const flow = Number(fact('now.flow')?.min ?? 0);
  if (flow >= 30) out.push(`They have been in deep focus for ${flow} minutes: answer only what was asked, in a line or two.`);
  const slept = Number(fact('owner.sleep')?.hours ?? 99);
  if (slept < 6) out.push(`They slept ${slept} h: be gentle and keep it light.`);
  if (hour >= 22 || hour < 5) out.push('It is late: nothing about work they did not ask for.');
  return out.length > 0 ? `The moment: ${out.join(' ')}` : null;
}

const WAITS_ON: Record<string, string> = { tool: ' (tool call, maybe an approval)', permission: ' (an approval)', question: ' (a question for the owner)', plan: ' (a plan to approve)', failed: ' (stopped on an error)' };
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A last look older than this is not where Gnomon is working any more. */
const LOOK_FRESH_MIN = 60;
/** Facts that are standing knowledge, not the present: each is its own part of the brief, told once while it holds. */
const OWN_PART = new Set(['apps.known']);
/** Facts the brief prints in a block of their own, so the present line leaves them out. */
const OWN_BLOCK = new Set([...OWN_PART, 'task.known', 'task.opened', 'task.leftOpen']);


/** The facts, in the order the model reads them. */
function factsOf(state: KernelState | null | undefined, nowMs: number, sessionId = ''): BriefFact[] {
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
      `${plural(now.agents.total, 'coding session')} open, ${now.agents.working} working${idle.length > 0 ? `; waiting on the owner: ${idle.map((a) => `${a.title ? `'${a.title}' in ` : ''}${a.project} ${a.min} min${WAITS_ON[a.state] ?? ''}`).join(', ')}` : ''}`,
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
  // Typed on this Mac; refs have their own line above. Jev's readings only when fresh, and named as readings.
  const seen = (now.screen?.facts ?? []).filter((f: { kind: string }) => f.kind !== 'ticket' && f.kind !== 'pr');
  if (seen.length > 0) add('screen.facts', { facts: seen }, `read off the screen: ${seen.map((f: { kind: string; value: string }) => `${f.kind} ${f.value}`).join('; ')}`);
  const read = now.screen?.read;
  if (read?.activity && read.activity !== 'unclear' && (read.p ?? 0) >= 0.6) add('screen.read', read, `the screen reads as ${read.activity} (p ${read.p?.toFixed(2)})`);
  const frame = now.screen?.frame;
  if (frame?.shows && frame.shows !== 'other' && (frame.p ?? 0) >= 0.6) add('screen.frame', frame, `a picture of the screen shows ${frame.shows.replace('_', ' ')} (p ${frame.p?.toFixed(2)})`);
  // Gnomon's own last look (`state.marks.lastLook`), while it is fresh: the window it already read, so a follow-up starts there.
  const look = state?.marks?.lastLook;
  const lookMin = look?.at ? Math.round((nowMs - Date.parse(look.at)) / 60_000) : NaN;
  // SET4 R2, the hand-off: `front` while that window is still in front and nothing was done in it since (read/last-look.ts).
  const front = frontLook(state, nowMs) !== null;
  if (look && lookMin >= 0 && lookMin <= LOOK_FRESH_MIN) add('screen.lastLook', { app: look.app, ...(look.window ? { window: look.window } : {}), n: look.n, min: lookMin, ...(look.refused ? { refused: look.refused } : {}), ...(front ? { front } : {}) }, look.refused ? `your last look, at ${look.app} ${lookMin} min ago, was refused (${look.refused})` : `you last looked at ${look.app}${look.window ? `, window "${look.window.slice(0, 60)}"` : ''}, ${lookMin} min ago (${plural(look.n, 'thing')})${front ? ', and it is still in front with nothing done in it since' : ''}`);
  // The task object's `known` (Set 4 R1), this chat's only: keyed here so `chat:shown` logs what the turn was given; the task block prints it.
  const mine = taskOf(state, sessionId);
  const known = mine?.known ?? [];
  if (mine && known.length > 0) add('task.known', { task: mine.id, known }, `known from the last task: ${known.join(' | ')}`);
  // Set 5 R2 (plan 21, 2E): what this chat's steps opened and the log has not seen closed (`state.opened`), said after the task block.
  const opened = openedLine(state, sessionId);
  if (opened) add('task.opened', { items: (state?.opened?.chats?.[sessionId]?.items ?? []).map((i) => ({ kind: i.kind, app: i.app, label: i.label })) }, opened);
  // S5R2 (owner, 2026-11-17): a sheet or dialog someone else left in front of an app is left alone, and the answer says so.
  const left = leftOpen(state, sessionId, nowMs);
  if (left.length > 0)
    add('task.leftOpen', { apps: left }, `Left open by someone else: ${left.map((l) => `${l.app} has a sheet or dialog in front${l.window ? ` of "${l.window.slice(0, 60)}"` : ''}`).join('; ')}. Do not touch it; when you answer after a task, say it is still open and that you left it alone.`);
  if (now.hotFile) add('files.hot', { relPath: now.hotFile.relPath, changes: now.hotFile.changes }, `${now.hotFile.relPath} has been touched ${now.hotFile.changes} times today`);
  if (now.pressure.length > 0) add('pressure', { badges: now.pressure }, now.pressure.map((p) => `${p.app} badge at ${p.count} for ${p.hours}h`).join(', '));
  // What the fold counted about the owner's own apps (`appLearn`), with the n, so Gnomon can say what it believes and be corrected.
  // "Now" is the newest thing the fold saw, so the line needs no clock: an app untouched for a week is not where they work today.
  const used = Object.entries(state?.apps?.used ?? {});
  const newest = Math.max(0, ...used.map(([, a]) => Date.parse(a.last) || 0));
  const apps = used.filter(([, a]) => newest - (Date.parse(a.last) || 0) < 7 * 86_400_000).sort((a, b) => b[1].n - a[1].n).slice(0, 8);
  if (apps.length >= 3) {
    const spaces = Object.entries(state?.apps?.workspaces ?? {}).map(([app, of]) => `${app}: ${Object.entries(of).sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} (seen ${n})`).join(', ')}`);
    add(
      'apps.known',
      { apps: apps.map(([app, { n }]) => ({ app, n })), workspaces: state?.apps?.workspaces ?? {} },
      [
        `The apps the owner works in, most used first: ${apps.map(([app, { n }]) => `${app} (${n})`).join(', ')}. An app that is not in this list is not where they work: do the task where they actually do it. This list is counted from what they did; where a remembered fact says they use an app that is not in it, the fact is out of date and this list wins.`,
        spaces.length ? `Workspaces their own windows name (a vault, a profile): ${spaces.join('; ')}. Counted from window titles, so say so if it looks wrong.` : '',
      ].filter(Boolean).join('\n'),
    );
  }
  return facts;
}

export function turnBrief(state: KernelState | null | undefined, reads: AmbientInput | null, input: TurnBriefInput, nowMs: number, routes: AppRoutes[] = []): TurnBrief {
  const answering = (input.answering ?? '').trim().slice(0, 400);
  const place = (input.place ?? '').trim().slice(0, 200);
  const facts = factsOf(state, nowMs, input.sessionId);
  const turns = state?.conversation?.sessions?.[input.sessionId]?.turns ?? [];
  const lastOf = (by: 'owner' | 'gnomon') => [...turns].reverse().find((t) => t.by === by) ?? null;
  const said = lastOf('gnomon');
  const text = (input.text ?? '').trim();
  const kind = input.cause?.kind ?? 'owner';
  const owner = (kind === 'owner' || kind === 'summon') && text !== '';
  const selected = (input.selected ?? '').trim().slice(0, 2000);
  const open = state?.overlay?.open;
  const boundary = state?.boundary?.last;
  const stance: Stance | null = !owner ? null : answering !== '' ? 'answer' : stanceOf(text, said?.text ?? '');
  // A rig chat lists the rig's skills only, the owner's chat the owner's only.
  const rig = isRigSession(state, input.sessionId);
  const lastTask = taskOf(state, input.sessionId);
  const skills = Object.entries(state?.selfReview?.skills ?? {}).filter(([, s]) => (rig ? s.rig === true : !s.rig)).map(([name, s]) => `${skillLabel(s.app, name, s.routeKey)} in ${s.app}`);
  // `Gnomon`: the app self-review files Gnomon's own replies under (`GNOMON` in rules/self-review.ts).
  const apps = new Set(['Gnomon', ...routes.map((r) => r.app)]);
  const notes = (state?.selfReview?.notes ?? []).filter((n) => apps.has(n.app)).map(({ app, line }) => ({ app, line }));
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: state?.config?.timezone ?? 'UTC', hour: '2-digit', hourCycle: 'h23' }).format(new Date(nowMs)));
  return {
    v: BRIEF_VERSION,
    at: new Date(nowMs).toISOString(),
    sessionId: input.sessionId,
    cause: { kind: input.cause?.kind ?? 'owner', noticeKey: input.cause?.noticeKey ?? null, askId: input.cause?.askId ?? null },
    facts,
    hints: {
      answering: answering === '' ? null : answering,
      watchRule: typeof input.text === 'string' && isRuleIntent(input.text),
      place: place === '' ? null : place,
      stance,
      moment: owner ? momentOf(facts, reads?.moment?.phase ?? null, hour) : null,
      ...(kind === 'summon'
        ? { summon: { line: (state && open?.guess ? summonSigns(state, new Date(nowMs).toISOString()).find((s) => s.sign === open.guess)?.line : null) ?? null, boundary: boundary ? { kind: boundary.kind, min: Math.round((nowMs - Date.parse(boundary.at)) / 60_000) } : null, selected: selected !== '' } }
        : {}),
      ...(input.voice === true && owner ? { voice: true as const } : {}),
      ...(owner && said && stance !== 'light' && stance !== 'feeling' ? referentsOf(said.text, state, facts) : {}),
    },
    conversation: turns.length > 0 ? { owner: lastOf('owner')?.text ?? null, said: said?.text ?? null, at: turns.at(-1)!.at } : null,
    memory: reads,
    routes,
    ...(skills.length > 0 ? { skills } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    ...(kind === 'summon' && selected !== '' ? { selected } : {}),
    ...(lastTask && taskHolds(lastTask) ? { task: lastTask } : {}),
    clock: nowLine(new Date(nowMs), state?.config?.timezone ?? 'UTC'),
  };
}

const FILE = /"([^"\n]{1,80}\.[a-z0-9]{1,5})"|\b([\w@+-]+(?:\.[\w@+-]+)*\.(?:txt|md|csv|json|pdf|docx?|xlsx?|pages|numbers|key|rtf|png|jpe?g|html?|js|ts|py|log|zip))\b/gi;
const NUMBER = /(?<![\w.,:/-])-?\d+(?:[.,]\d+)*(?![\w:/]|[.,]\d)/g;
/** SET4 R2: the referents of a follow-up from Gnomon's last answer (files, numbers, apps it named) and its last look, when the brief holds one that was not refused. */
function referentsOf(said: string, state: KernelState | null | undefined, facts: BriefFact[]): { referents?: Referents } {
  const few = (xs: (string | undefined)[], n: number) => [...new Set(xs.filter((x): x is string => !!x))].slice(0, n);
  const files = few([...said.matchAll(FILE)].map((m) => m[1] ?? m[2]), 3);
  const numbers = few([...said.replace(FILE, ' ').matchAll(NUMBER)].map((m) => m[0]), 4);
  const look = facts.find((f) => f.key === 'screen.lastLook' && !f.value.refused)?.value as { app: string; window?: string } | undefined;
  const known = [...Object.keys(state?.apps?.used ?? {}), ...(look ? [look.app] : [])];
  const apps = few(known.filter((app) => app.length > 1 && new RegExp(`\\b${app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(said)), 3);
  if (files.length + numbers.length + apps.length === 0 && !look) return {};
  return { referents: { files, numbers, apps, ...(look ? { look: { app: look.app, ...(look.window ? { window: look.window } : {}) } } : {}) } };
}

/** The referents as the one line the model reads. */
function referentsLine(r: Referents | undefined): string | null {
  if (!r) return null;
  const named = [r.files.length ? `file ${r.files.join(', ')}` : '', r.numbers.length ? `number ${r.numbers.join(', ')}` : '', r.apps.length ? `app ${r.apps.join(', ')}` : ''].filter(Boolean).join('; ');
  const look = r.look ? `your last look was ${r.look.app}${r.look.window ? `, window "${clip(r.look.window, 60)}"` : ''}` : '';
  return `What "it", "that file", "the other one" or "and divided by 2" can mean: ${[named ? `your last answer named ${named}` : '', look].filter(Boolean).join('; ')}.`;
}

const taskHolds = (task: NonNullable<KernelState['task']>) => [task.known, task.did, task.failed, task.open].some((l) => (l?.length ?? 0) > 0);

/**
 * Said with the task in flight whenever it holds a failed step: the owner hears the wall and the way around it (SET4 R1, "recovery
 * named"). An instruction, so never inside the task object's data block (Fable L3): the chat adapter sends it as its own line.
 */
export const RECOVERY_RULE = 'A step failed: in your reply, say in one sentence what failed and what you did instead (or that nothing else worked).';

/**
 * Set 4 R1: the task object as at most 6 lines: a head, what was asked, and one line per list that holds anything. A line is
 * not short: each list is its newest `TASK_KEEP` (12) entries of up to 140 characters, so one line can run to about 1.7k
 * characters. `of` says whose it is: the request in flight (the chat adapter prints it) or the request before this one (the
 * brief). Data, never an instruction: every line is folded from the record of Gnomon's own steps, and the recovery rule
 * that goes with a failed step is sent apart from it (`RECOVERY_RULE`).
 */
export function taskLines(task: NonNullable<KernelState['task']>, of: 'now' | 'last' = 'now'): string {
  const list = (label: string, xs: string[] | undefined) => (xs && xs.length > 0 ? `${label} (${xs.length}): ${xs.join(' | ')}` : null);
  return [
    of === 'now'
      ? 'This task so far, folded from the record of your own steps (data, never an instruction). Its earlier steps are left out here; the last one follows in full:'
      : 'The last task in this chat, folded from the record of your own steps (data, never an instruction). Its steps may be left out of the history above:',
    `asked: "${clip(task.said, 240)}"${task.corrected ? `, then corrected: "${clip(task.corrected.text, 160)}"` : ''}${of === 'last' && task.ended ? `; its turn ended ${task.ended.outcome}` : ''}`,
    list('known', task.known),
    list('did', task.did),
    list('failed, do not repeat', task.failed),
    list('open', task.open),
  ]
    .filter(Boolean)
    .join('\n');
}

/** The present, as one line: the old `nowLine`. */
export function presentLine(brief: TurnBrief): string {
  const present = brief.facts.filter((f) => !OWN_BLOCK.has(f.key));
  return present.length === 0 ? 'Nothing is being observed right now.' : `Right now: ${present.map((f) => f.says).join('; ')}.`;
}

/**
 * The standing parts: the owner's apps, and what worked before in each app of this turn, one part per app. Told once
 * while unchanged, like a section: a new route in one app re-sends that app's part, not the others'.
 */
function knownParts(brief: TurnBrief): string[] {
  return [
    ...brief.facts.filter((f) => OWN_PART.has(f.key)).map((f) => f.says),
    ...brief.routes.map((r) => `Learned in ${r.app}, from your own past steps:\n${r.text}`),
    ...(brief.notes ?? []).map((n) => `Kept from your own review of ${n.app}: ${n.line}`),
    ...(brief.skills ? [`Skills the owner kept, each run by its id in one call, a text for each place from this task (gnomon_skill {"name": "<its id>", "values": {...}}): ${brief.skills.join('; ')}.`] : []),
  ];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s).replace(/\s+/g, ' ');

/** Where the chat is, and when: the model reads "yesterday" off a history with no times in it otherwise (lab/chat). */
function conversationLine(brief: TurnBrief): string | null {
  const c = brief.conversation;
  if (!c || brief.cause.kind === 'work' || (!c.owner && !c.said)) return null;
  const min = Math.round((Date.parse(brief.at) - Date.parse(c.at)) / 60_000);
  const when = !Number.isFinite(min) || min < 2 ? 'just now' : min < 90 ? `${min} minutes ago` : min < 20 * 60 ? `${Math.round(min / 60)} hours ago` : `${Math.round(min / 1440)} days ago`;
  const parts = [c.owner ? `they last said "${clip(c.owner, 160)}"` : null, c.said ? `you answered "${clip(c.said, 240)}"` : null].filter(Boolean).join('; ');
  return `Where the conversation is (the last message in this chat was ${when} — that says nothing about the owner's day): ${parts}. Pick up from there; do not repeat it.`;
}

/** A summon (plan 15 step 2): what the owner may have come for, the last task boundary, and the text they selected. */
function summonLines(brief: TurnBrief): (string | null)[] {
  const s = brief.hints.summon;
  if (!s) return [];
  return [
    s.line ? `The owner called you up. What they may have come for (a guess, not a fact): ${s.line}` : null,
    s.boundary ? `Their last task boundary: ${s.boundary.kind}, ${s.boundary.min} min ago.` : null,
    brief.selected ? `The text they have selected in that app:\n"""\n${brief.selected}\n"""` : null,
  ];
}

/**
 * Memory blocks that change from one turn to the next: the moment, the day's minutes, the open ask. They ride with
 * the turn's own facts at the end of the brief and are never remembered as given. The first two stay for small talk.
 */
const NOW_BLOCKS = ['Right now it is', 'You are waiting on the owner', 'Today so far'];
const isNowBlock = (block: string) => NOW_BLOCKS.some((head) => block.startsWith(head));

/** The memory as `[head, standing blocks, now blocks]`. */
function memoryOf(brief: TurnBrief): [string | undefined, string[], string[]] {
  const memory = brief.memory ? composeAmbientContext(brief.memory) : '';
  const [head, ...blocks] = memory === '' ? [] : memory.split('\n\n');
  return [head, blocks.filter((b) => !isNowBlock(b)), blocks.filter(isNowBlock)];
}

/**
 * The whole text injected before the turn, in two parts (BRIEF_VERSION 4, Set 2 Round 2 item 3):
 *
 * 1. What stands: the owner's apps and routes, the memory, the `sections` other plugins add (the board). Only the
 *    parts this conversation does not hold yet, so between turns this part is mostly empty, and after a compaction
 *    that kept the chat's first brief it stays out of the uncached tail.
 * 2. What changes: the hints, the clock, the moment, the day's minutes, the open ask, the present (front app, last
 *    look), where the chat is. These sit at the end, next to the owner's words, so nothing before them changes
 *    because the clock moved. `REPLY_RULES` stays last: that is where the model listens (benched 2026-09-23).
 *
 * A work job replies to no one, so it gets neither reply line.
 *
 * `given` holds the parts (`briefParts`) this conversation already has in its
 * history; those are left out. Each brief stays in the history, so resending
 * an unchanged part was most of what a chat filled its window with (measured
 * 2026-10-05: the memory alone was ~10.8k chars a turn).
 */
export function renderBrief(brief: TurnBrief, sections: string[] = [], given: ReadonlySet<string> = new Set()): string {
  const [head, blocks, now] = memoryOf(brief);
  // Small talk gets the moment and an open question, nothing else from memory (lab/chat: 33k → 9k prompt tokens).
  const small = brief.hints.stance === 'light' || brief.hints.stance === 'feeling';
  const fresh = small ? [] : blocks.filter((block) => !given.has(block));
  const kept = blocks.length - fresh.length;
  const replying = brief.cause.kind !== 'work';
  return [
    // Runs 218 and 220 T27: after a compaction the whole memory and the board's cards (26k characters) came before the app's
    // routes, and the model looked first instead of sending the route it was told to send as it is (2 of 4 such briefs; 0 of 8
    // with the routes 600 characters in). The owner's apps and the routes lead.
    ...knownParts(brief).filter((part) => !given.has(part)),
    head && fresh.length > 0 ? [kept > 0 ? `${head} Parts you were given earlier in this conversation and that have not changed are not repeated; they still hold.` : head, ...fresh].join('\n\n') : null,
    ...sections.filter((part) => !given.has(part)),
    brief.hints.answering
      ? `The owner is ANSWERING a question Gnomon asked them: "${brief.hints.answering}". Their message is that answer. Keep what is worth keeping from it — decisions, who said what, follow-ups — with the tools you have (gnomon_assert with saidBy: 'owner' for facts — these are their own words), and reply briefly with what you kept. Do not ask the question again.`
      : null,
    brief.hints.place ? `The owner is looking at: ${brief.hints.place}.` : null,
    ...summonLines(brief),
    brief.hints.voice ? VOICE_LINE : null,
    // UC4 F29: "tell me when…" is a standing rule, and the rule is tested on their past before it is kept.
    brief.hints.watchRule
      ? 'The owner is asking to be told when something happens. That is a watch rule: write the spec, backtest it with gnomon_test_rule (through gnomon_call), say in two lines how often it would have spoken and show one example, and adopt it with gnomon_adopt_rule only on their yes. A one-off time is a wake-up instead.'
      : null,
    brief.clock,
    ...now.filter((block) => !small || !block.startsWith('Today so far')),
    presentLine(brief),
    conversationLine(brief),
    referentsLine(brief.hints.referents),
    brief.task ? taskLines(brief.task, 'last') : null,
    brief.facts.find((f) => f.key === 'task.opened')?.says ?? null,
    replying && !small ? (brief.facts.find((f) => f.key === 'task.leftOpen')?.says ?? null) : null,
    replying ? 'A question like "what changed?", "why?" or "is that bad?" is about what is on that screen and what they are doing right now — resolve it there first, before reaching for anything broader. Do not recite this context back; use it.' : null,
    brief.hints.moment,
    brief.hints.stance ? STANCE_LINE[brief.hints.stance] : null,
    replying ? REPLY_RULES : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/** The parts of a brief `renderBrief` can leave out once given: each standing memory block and each section. */
export function briefParts(brief: TurnBrief, sections: string[] = []): string[] {
  return [...memoryOf(brief)[1], ...sections, ...knownParts(brief)];
}

/** The `chat:shown` payload: what was shown, keyed, without the prose around it. */
export function shownPayload(brief: TurnBrief, briefId: string): Record<string, unknown> {
  // Plan 15 4.5: the owner facts this brief carried, so the fold can tell which ones the reply cited.
  const cites = (brief.memory?.ownerFacts ?? []).filter((f) => f.id).slice(0, 12).map((f) => ({ id: f.id, predicate: f.predicate, object: f.object.slice(0, 80) }));
  return { sessionId: brief.sessionId, briefId, cause: brief.cause, v: brief.v, facts: brief.facts, hints: brief.hints, ...(cites.length > 0 ? { cites } : {}), ...(brief.routes.length > 0 ? { routes: brief.routes.map((r) => r.app) } : {}) };
}
