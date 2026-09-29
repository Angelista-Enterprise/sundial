import { z } from 'zod';
import { getAllEntities, getAllProjects, getCurrentFactsWithProof, getMomentsForProject, getOpenCommitments, getProjectIntents, getPromises, getAllSignalsInRange, loadAliasNames } from '@sundial/db/index.js';
import type { StoredCommitment } from '@sundial/db/index.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { loadLatestSnapshot } from '../snapshot.js';
import type { AgentFleetEntry, TicketThread } from '../types.js';
import type { GnomonTool } from './registry.js';

// lane D — #20 project handoff.

/** What the handoff is written from. Every list is already the project's own and inside the window. */
export interface HandoffInput {
  project: { name: string; root: string };
  since: string;
  now: string;
  timeZone: string;
  moments: { startTime: string; durationMs: number; meetingAttendees: string[] }[];
  intents: { at: string; what: string }[];
  threads: StoredCommitment[];
  promises: StoredCommitment[];
  /** Current facts that are about the project: on its own entity, or naming it. */
  facts: { subject: string; subjectKind: string; predicate: string; object: string; since: string; provenance: string }[];
  commits: { at: string; line: string; branch: string | null }[];
  prs: { at: string; number: number; title: string; state: string | null; reviewState: string | null; checkState: string | null }[];
  status: { branch: string | null; dirtyFiles: number; ahead: number } | null;
  fileChanges: { at: string; files: string[] }[];
  /** `agent:fleet` samples, reduced to this project's sessions. */
  fleet: { at: string; sessions: AgentFleetEntry[] }[];
  collisions: Record<string, number>;
  tickets: TicketThread[];
  /** alias → name, for hashed people. */
  names: Record<string, string>;
  ownerAliases: string[];
}

const HASHED = /^person-[0-9a-f]{10}$/;
/** A calendar room carries its capacity: "Library (12)". The same test `situation.ts` uses. */
const ROOM = /\(\d+\)\s*$/;
/** A merge commit's line, after the short hash: it carries the other branch's work, not this one's. */
const MERGE = /^(?:[0-9a-f]{7,40}\s+)?Merge\b/;
/** Facts that list rather than decide: shown as one line each, not as decisions. */
const LISTED = new Set(['relatesToProject', 'usesTool']);
const PEOPLE_PREDICATES = new Set(['worksOn', 'worksWith', 'attendedMeetingWith', 'relationship', 'mentors', 'gaveFeedbackTo', 'expects']);
/** How long a fleet sample says what the sessions are doing. The sensor polls every 15 s. */
const FLEET_FRESH_MS = 2 * 60_000;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string, tz: string) => localDate(iso, tz);
const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;
const clip = (text: string, max = 90) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The handoff for one project, as a document another person can pick up from.
 *
 * Deterministic: every line is a row in the record, counted, with no model in
 * between. Seven parts: where it stands, decisions, open threads, people,
 * promises, agents, risky files. A part with nothing in it says so, because
 * "no promises on record" is itself worth handing over. Pure.
 */
export function buildHandoff(input: HandoffInput): { text: string; counts: Record<string, number> } {
  const tz = input.timeZone;
  const name = (who: string) => input.names[who] ?? who;
  const isOwner = (who: string) => input.ownerAliases.some((a) => a.toLowerCase() === who.toLowerCase() || a.toLowerCase() === name(who).toLowerCase());
  const lines: string[] = [`# Handoff: ${input.project.name}`, `${input.project.root}, from ${day(input.since, tz)} to ${day(input.now, tz)}.`, ''];

  // Where it stands.
  const activeDays = new Set(input.moments.map((m) => day(m.startTime, tz)));
  const workedMs = input.moments.reduce((sum, m) => sum + m.durationMs, 0);
  const last = input.moments.reduce<string | null>((max, m) => (max === null || m.startTime > max ? m.startTime : max), null);
  lines.push('## Where it stands');
  lines.push(input.moments.length === 0 ? '- No time on this project in the window.' : `- ${hours(workedMs)} over ${plural(activeDays.size, 'day')} (${plural(input.moments.length, 'moment')}); last worked ${last ? day(last, tz) : '?'}.`);
  if (input.status) lines.push(`- Checkout on ${input.status.branch ?? '(no branch)'}: ${plural(input.status.dirtyFiles, 'uncommitted file')}, ${plural(input.status.ahead, 'commit')} not pushed.`);
  const own = input.commits.filter((c) => !MERGE.test(c.line));
  const merges = input.commits.length - own.length;
  const branches = [...new Set(input.commits.map((c) => c.branch).filter((b): b is string => !!b))];
  if (input.commits.length > 0)
    lines.push(
      // No line counts: measured on the live record, one generated file made a month's total read +11 million.
      `- ${plural(own.length, 'commit')}${merges > 0 ? ` and ${plural(merges, 'merge')}` : ''} on ${plural(branches.length, 'branch', 'branches')}${branches.length > 0 ? ` (${branches.slice(-4).join(', ')})` : ''}.${own.length > 0 ? ` Latest: ${own.slice(-3).reverse().map((c) => `"${clip(c.line, 60)}"`).join(', ')}.` : ''}`,
    );
  const prs = [...new Map(input.prs.map((p) => [p.number, p])).values()];
  for (const p of prs.slice(-4)) lines.push(`- PR #${p.number} ${clip(p.title, 60)}: ${[p.state, p.reviewState, p.checkState].filter(Boolean).join(', ')}.`);
  for (const i of input.intents.slice(0, 3)) lines.push(`- ${day(i.at, tz)}: ${clip(i.what)}`);
  lines.push('');

  // Decisions and facts.
  const aboutProject = input.facts.filter((f) => !PEOPLE_PREDICATES.has(f.predicate) && f.subjectKind !== 'person');
  const decisions = aboutProject.filter((f) => !LISTED.has(f.predicate));
  lines.push('## Decisions and facts');
  if (aboutProject.length === 0) lines.push('- None on record.');
  const tasks = aboutProject.filter((f) => f.predicate === 'relatesToProject').sort((a, b) => b.since.localeCompare(a.since));
  if (tasks.length > 0) lines.push(`- ${plural(tasks.length, 'task')} on record, newest first: ${tasks.slice(0, 6).map((f) => f.subject).join(', ')}${tasks.length > 6 ? ', …' : ''}.`);
  const tools = [...new Set(aboutProject.filter((f) => f.predicate === 'usesTool').map((f) => f.object))];
  if (tools.length > 0) lines.push(`- Tools: ${tools.slice(0, 8).join(', ')}${tools.length > 8 ? ', …' : ''}.`);
  const owned = [...decisions].sort((a, b) => Number(b.provenance === 'owner') - Number(a.provenance === 'owner') || b.since.localeCompare(a.since));
  for (const f of owned.slice(0, 10)) lines.push(`- ${f.subject} ${f.predicate} ${clip(f.object, 70)}${f.provenance === 'owner' ? ' (you said)' : ''}, since ${day(f.since, tz)}.`);
  if (owned.length > 10) lines.push(`- …and ${owned.length - 10} more.`);
  lines.push('');

  // Open threads: branch threads and the tickets seen with this project.
  const threads = input.threads.filter((t) => t.promise === null && t.closedAt === null && t.branch.trim() !== '');
  lines.push('## Open threads');
  if (threads.length === 0 && input.tickets.length === 0) lines.push('- None open.');
  for (const t of threads.slice(0, 6)) lines.push(`- ${t.branch}: ${plural(t.activeDays, 'day')} of work, last touched ${day(t.lastTouchedAt, tz)}.`);
  for (const t of input.tickets.slice(0, 6)) lines.push(`- ${t.id}: ${t.stage}${t.pr?.number ? ` (PR #${t.pr.number}${t.pr.state ? `, ${t.pr.state}` : ''})` : ''}, seen on ${plural(t.days.length, 'day')}, last ${day(t.lastSeen, tz)}.`);
  lines.push('');

  // People: named in facts about the project, owed or owing, or in its meetings.
  const people = new Map<string, Set<string>>();
  const meet = (who: string, why: string) => {
    if (!who || isOwner(who) || ROOM.test(who)) return;
    const shown = name(who);
    people.set(shown, (people.get(shown) ?? new Set()).add(why));
  };
  for (const f of input.facts) if (f.subjectKind === 'person') meet(f.subject, f.predicate);
  for (const p of input.promises) if (typeof p.promise?.counterparty === 'string') meet(p.promise.counterparty, 'promise');
  for (const m of input.moments) for (const a of m.meetingAttendees) meet(a, 'meeting');
  const named = [...people].filter(([who]) => !HASHED.test(who));
  const unnamed = people.size - named.length;
  lines.push('## People');
  if (named.length === 0) lines.push('- Nobody named on record.');
  for (const [who, why] of named.slice(0, 8)) lines.push(`- ${who}: ${[...why].join(', ')}.`);
  if (unnamed > 0) lines.push(`- ${plural(unnamed, 'person', 'people')} without a name yet.`);
  lines.push('');

  // Promises.
  const open = input.promises.filter((p) => p.closedAt === null);
  const closed = input.promises.length - open.length;
  lines.push('## Promises');
  if (input.promises.length === 0) lines.push('- None on record.');
  for (const p of open.slice(0, 6)) {
    const terms = p.promise ?? {};
    const who = typeof terms.counterparty === 'string' ? name(terms.counterparty) : 'nobody in particular';
    const what = typeof terms.deliverable === 'string' ? terms.deliverable : p.name;
    const due = typeof terms.due === 'string' ? `, due ${day(terms.due, tz)}` : '';
    lines.push(`- ${terms.direction === 'awaiting' ? `${who} owes you` : `You owe ${who}`}: ${clip(what, 70)}${due}.`);
  }
  if (closed > 0) lines.push(`- ${plural(closed, 'promise')} closed: ${Object.entries(countBy(input.promises.filter((p) => p.closedAt !== null).map((p) => p.closedBecause ?? 'closed'))).map(([k, n]) => `${k} ${n}`).join(', ')}.`);
  lines.push('');

  // Agents.
  const sessions = new Map<string, AgentFleetEntry & { lastAt: string }>();
  for (const sample of input.fleet) for (const s of sample.sessions) sessions.set(s.id, { ...s, lastAt: sample.at });
  lines.push('## Agents');
  if (sessions.size === 0) lines.push('- No coding-agent session in this checkout in the window.');
  else lines.push(`- ${plural(sessions.size, 'session')} in the window.`);
  for (const s of [...sessions.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, 5)) {
    lines.push(`- ${s.title ? `"${clip(s.title, 60)}"` : s.id}${s.branch ? ` on ${s.branch}` : ''}: ${s.state} when last seen ${day(s.lastAt, tz)}.`);
  }
  const collisions = Object.entries(input.collisions).filter(([, n]) => n > 0);
  if (collisions.length > 0) lines.push(`- Collisions noticed: ${collisions.map(([k, n]) => `${k.replace(/^agent-/, '')} ${n}`).join(', ')}.`);
  lines.push('');

  // Risky files: the ones changed most, and how often an agent worked in the checkout while they changed.
  const files = new Map<string, { changes: number; days: Set<string>; withAgent: number }>();
  for (const change of input.fileChanges) {
    const agentWorking = input.fleet.some((f) => f.at <= change.at && Date.parse(change.at) - Date.parse(f.at) <= FLEET_FRESH_MS && f.sessions.some((s) => s.state === 'working'));
    for (const path of change.files) {
      const row = files.get(path) ?? { changes: 0, days: new Set<string>(), withAgent: 0 };
      row.changes += 1;
      row.days.add(day(change.at, tz));
      if (agentWorking) row.withAgent += 1;
      files.set(path, row);
    }
  }
  const risky = [...files].sort(([, a], [, b]) => b.withAgent - a.withAgent || b.changes - a.changes).slice(0, 8);
  lines.push('## Risky files');
  if (risky.length === 0) lines.push('- No file changes on record.');
  for (const [path, f] of risky) lines.push(`- ${path}: changed ${plural(f.changes, 'time')} on ${plural(f.days.size, 'day')}${f.withAgent > 0 ? `, ${f.withAgent} of them while an agent worked in the checkout` : ''}.`);

  return {
    text: lines.join('\n').trimEnd(),
    counts: {
      moments: input.moments.length,
      activeDays: activeDays.size,
      commits: input.commits.length,
      decisions: decisions.length,
      tasks: tasks.length,
      openThreads: threads.length,
      tickets: input.tickets.length,
      people: people.size,
      promisesOpen: open.length,
      promisesClosed: closed,
      agentSessions: sessions.size,
      filesChanged: files.size,
    },
  };
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

const inRoot = (path: unknown, root: string) => typeof path === 'string' && (path === root || path.startsWith(`${root}/`));
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : null);

export const HANDOFF_TOOLS: GnomonTool[] = [
  {
    name: 'gnomon_project_handoff',
    description:
      'Write the HANDOFF for one project: where it stands (time, commits, PRs, the checkout, recent intent lines), decisions and facts on record, open threads (branches and tickets), people, promises, coding-agent sessions and collisions, and risky files (most changed, and how often an agent worked in the checkout while they changed). Deterministic: every line is a counted row in the record. Use it for "write the handoff for puzzlebox", "hand this project over", "what would someone need to take over X". Pass the project by name or root; an unknown name returns the known projects. Give the owner `text` as it is; add nothing the record does not say.',
    schema: {
      project: z.string().describe('The project name (e.g. puzzlebox-studio) or its root path'),
      days: z.number().int().positive().max(90).optional().describe('How far back to look. Default 30.'),
    },
    readOnly: true,
    handler: async ({ project, days }) => {
      const wanted = String(project).trim().toLowerCase();
      const projects = await getAllProjects();
      const base = (root: string) => root.split('/').filter(Boolean).at(-1)?.toLowerCase() ?? '';
      const match =
        projects.find((p) => p.name.toLowerCase() === wanted || p.rootPath.toLowerCase() === wanted || p.id.toLowerCase() === wanted) ??
        projects.find((p) => base(p.rootPath) === wanted) ??
        (() => {
          const partial = projects.filter((p) => p.name.toLowerCase().includes(wanted));
          return partial.length === 1 ? partial[0] : undefined;
        })();
      if (!match) return { note: `No project matches "${project}".`, known: projects.map((p) => p.name).slice(0, 40) };

      const root = match.id;
      const now = new Date().toISOString();
      const since = new Date(Date.parse(now) - ((days as number | undefined) ?? 30) * 86_400_000).toISOString();
      const snapshot = await loadLatestSnapshot();
      const state = snapshot?.state;
      const timeZone = state?.config?.timezone ?? 'UTC';
      const nameLc = match.name.toLowerCase();

      const [moments, intents, open, promises, facts, entities, names, signals] = await Promise.all([
        getMomentsForProject(root, 5000),
        getProjectIntents(root, now, 5),
        getOpenCommitments(500),
        getPromises(500),
        getCurrentFactsWithProof(),
        getAllEntities(),
        loadAliasNames(),
        getAllSignalsInRange(since, now, ['git:commit', 'git:pr-status', 'git:status', 'file:changed', 'agent:fleet', 'notice:candidate'], root),
      ]);

      const entityById = new Map(entities.map((e) => [e.id, e]));
      const own = entities.find((e) => e.kind === 'project' && e.canonicalName.toLowerCase() === nameLc);
      const aboutIt = facts.filter((f) => f.entityId === own?.id || f.object.toLowerCase() === nameLc || f.object.toLowerCase().includes(nameLc));
      const mentions = (text: string) => text.toLowerCase().includes(nameLc);

      const commits: HandoffInput['commits'] = [];
      const prs: HandoffInput['prs'] = [];
      const fileChanges: HandoffInput['fileChanges'] = [];
      const fleet: HandoffInput['fleet'] = [];
      const collisions: Record<string, number> = {};
      let status: HandoffInput['status'] = null;
      for (const s of signals) {
        const d = s.data;
        const type = `${s.signalType}:${s.eventType}`;
        if (type === 'git:commit' && inRoot(d.cwd, root)) commits.push({ at: s.capturedAt, line: str(d.commitLine) ?? '', branch: str(d.branch) });
        else if (type === 'git:pr-status' && inRoot(d.cwd, root) && typeof d.number === 'number') prs.push({ at: s.capturedAt, number: d.number, title: str(d.title) ?? '', state: str(d.state), reviewState: str(d.reviewState), checkState: str(d.checkState) });
        else if (type === 'git:status' && inRoot(d.cwd, root)) status = { branch: str(d.branch), dirtyFiles: num(d.dirtyFiles), ahead: num(d.ahead) };
        else if (type === 'file:changed' && inRoot(d.projectRoot, root) && Array.isArray(d.changes)) fileChanges.push({ at: s.capturedAt, files: d.changes.map((c) => str((c as { relPath?: unknown }).relPath)).filter((p): p is string => p !== null) });
        else if (type === 'agent:fleet' && Array.isArray(d.sessions)) {
          const mine = (d.sessions as AgentFleetEntry[]).filter((x) => inRoot(x?.cwd, root));
          if (mine.length > 0) fleet.push({ at: s.capturedAt, sessions: mine });
        } else if (type === 'notice:candidate' && typeof d.kind === 'string' && /^agent-.*(collision|shared-checkout)$/.test(d.kind)) collisions[d.kind] = (collisions[d.kind] ?? 0) + 1;
      }

      // A ticket is this project's when its key rides on the project's branches, commits or PRs.
      const refs = [...commits.map((c) => `${c.line} ${c.branch ?? ''}`), ...prs.map((p) => p.title), ...open.filter((t) => t.projectId === root).map((t) => t.branch), status?.branch ?? ''].join(' ');
      const tickets = Object.values(state?.tickets ?? {}).filter((t) => refs.includes(t.id)).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));

      const promiseText = (p: StoredCommitment) => [p.name, p.promise?.deliverable, p.promise?.quote].filter((v): v is string => typeof v === 'string').join(' ');
      const { text, counts } = buildHandoff({
        project: { name: match.name, root },
        since,
        now,
        timeZone,
        moments: moments
          .filter((m) => m.startTime >= since)
          .map((m) => ({ startTime: m.startTime, durationMs: m.durationMs, meetingAttendees: Array.isArray(m.data.meetingAttendees) ? (m.data.meetingAttendees as unknown[]).filter((a): a is string => typeof a === 'string') : [] })),
        intents: intents.filter((i) => i.at >= since),
        threads: open.filter((t) => t.projectId === root),
        promises: promises.filter((p) => p.projectId === root || mentions(promiseText(p))),
        facts: aboutIt.map((f) => ({ subject: entityById.get(f.entityId)?.canonicalName ?? f.entityId, subjectKind: entityById.get(f.entityId)?.kind ?? '?', predicate: f.predicate, object: f.object, since: f.validFrom, provenance: f.provenance })),
        commits,
        prs,
        status,
        fileChanges,
        fleet,
        collisions,
        tickets,
        names,
        ownerAliases: state?.config?.ownerAliases ?? [],
      });
      return { project: match.name, root, since, text, counts, note: 'Every line is a row in the record. Counts carry their n; nothing is inferred.' };
    },
  },
];
