import { formatClock } from '@sundial/helpers/local-day.js';

/*
 * UC10 — the flight recorder: one ordered timeline of a stretch of the log,
 * and a postmortem skeleton built from it. Pure functions over rows the tool
 * has already read, so a test, the tool and an offline replay read the same
 * lines. No model: every line is a row's own fields, and every line keeps the
 * id of the row behind it.
 */

/** One signal row, as the tools read it. */
export interface LogRow {
  id: string;
  /** `signalType:eventType`. */
  type: string;
  ts: string;
  data: Record<string, unknown>;
}

/** One moment row: a stretch of focus the fold already closed. */
export interface MomentRow {
  id: string;
  start: string;
  end: string;
  projectId: string | null;
  process: string;
  data: Record<string, unknown>;
}

/** The kinds a timeline reads. Telemetry (input, clock, screen text, window focus) is left to the moments, which already fold it. */
export const TIMELINE_TYPES = [
  'shell:command',
  'git:commit',
  'git:push',
  'git:pr-status',
  'calendar:active',
  'mail:sent',
  'mail:received',
  'browser:tab',
  'document:opened',
  'agent:hook',
  'agent:fleet',
  'file:changed',
  'idle:start',
  'idle:end',
  'system:sleep-wake',
  'work:shelved',
];

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const clip = (text: string, n: number): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
};
/** The last part of a path: `~/Projects/puzzlebox-studio` → `puzzlebox-studio`. */
export const baseName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() ?? path;

function attendeesOf(value: unknown): string[] {
  let list = value;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  return Array.isArray(list) ? list.map((a) => (typeof a === 'string' ? a : str((a as { name?: unknown })?.name))).filter(Boolean) : [];
}

/** A calendar row's event, whichever shape it came in. */
export function eventOf(row: LogRow): { id: string; title: string; start: string; end: string; attendees: string[]; allDay: boolean } | null {
  const e = row.data.event as Record<string, unknown> | undefined;
  if (!e || typeof e !== 'object') return null;
  return { id: str(e.eventId) || `${str(e.title)}@${str(e.startDate)}`, title: str(e.title), start: str(e.startDate), end: str(e.endDate), attendees: attendeesOf(e.attendees), allDay: e.isAllDay === true };
}

/** One row in a line of its own words, or null when the row says nothing worth a line. */
export function describeRow(row: LogRow, zone: string): { kind: string; text: string } | null {
  const d = row.data;
  switch (row.type) {
    case 'shell:command': {
      const exit = typeof d.exitCode === 'number' ? d.exitCode : null;
      return { kind: 'command', text: `$ ${clip(str(d.command), 100)}${exit !== null && exit !== 0 ? ` (exit ${exit})` : ''}${d.cwd ? ` in ${baseName(str(d.cwd))}` : ''}` };
    }
    case 'git:commit':
      return { kind: 'commit', text: `${baseName(str(d.cwd))}@${str(d.branch)}: ${clip(str(d.commitLine), 90)}${typeof d.filesChanged === 'number' ? ` (${d.filesChanged} files)` : ''}` };
    case 'git:push':
      return { kind: 'push', text: `pushed ${baseName(str(d.cwd))}@${str(d.branch)}${d.remote ? ` to ${str(d.remote)}` : ''}` };
    case 'git:pr-status':
      return { kind: 'pr', text: `PR #${str(d.number)} ${clip(str(d.title), 70)}: ${str(d.state).toLowerCase()}${d.checkState && d.checkState !== 'none' ? `, checks ${str(d.checkState)}` : ''}${d.reviewState ? `, review ${str(d.reviewState).toLowerCase()}` : ''}` };
    case 'calendar:active': {
      const e = eventOf(row);
      if (!e || e.allDay) return null;
      return { kind: 'meeting', text: `${clip(e.title, 70)} ${formatClock(e.start, zone)}–${formatClock(e.end, zone)}${e.attendees.length > 0 ? `, ${e.attendees.length} invited` : ''}` };
    }
    case 'mail:sent': {
      const to = Array.isArray(d.recipients) ? (d.recipients as { to?: unknown; toName?: unknown }[]).map((r) => str(r.toName) || str(r.to)).filter(Boolean) : [];
      return { kind: 'mail', text: `sent to ${clip(to.join(', ') || 'someone', 60)}: ${clip(str(d.subject), 80)}` };
    }
    case 'mail:received':
      return { kind: 'mail', text: `from ${clip(str(d.from), 40)}: ${clip(str(d.subject), 80)}` };
    case 'browser:tab':
    case 'page:text':
      return { kind: 'page', text: `${clip(str(d.title) || str(d.path), 70)} (${str(d.host)})` };
    case 'document:opened':
      return { kind: 'document', text: `opened ${clip(str(d.title), 80)}` };
    case 'agent:hook': {
      const ev = str(d.event);
      const where = d.cwd ? ` in ${baseName(str(d.cwd))}` : '';
      if (ev === 'PostToolUse' || ev === 'PreToolUse') return { kind: 'agent', text: `agent used ${str(d.tool) || 'a tool'}${where}` };
      if (ev === 'SessionStart') return { kind: 'agent', text: `agent session started${where}` };
      if (ev === 'SessionEnd') return { kind: 'agent', text: `agent session ended${where}` };
      if (ev === 'Stop') return { kind: 'agent', text: `agent finished its turn${where}` };
      if (ev === 'UserPromptSubmit') return { kind: 'agent', text: `you prompted the agent${where}` };
      return null;
    }
    case 'file:changed': {
      const names = [...new Set((Array.isArray(d.changes) ? (d.changes as { relPath?: unknown }[]) : []).map((c) => baseName(str(c.relPath))).filter(Boolean))];
      return names.length > 0 ? { kind: 'edit', text: editLine(baseName(str(d.projectRoot)), names) } : null;
    }
    case 'idle:start':
      return { kind: 'away', text: 'went idle' };
    case 'idle:end':
      return { kind: 'away', text: 'back at the keyboard' };
    case 'system:sleep-wake': {
      const kind = str(d.kind);
      return kind ? { kind: 'away', text: `machine ${kind}${typeof d.gapSeconds === 'number' && d.gapSeconds > 0 ? ` after ${Math.round(d.gapSeconds / 60)} min` : ''}` } : null;
    }
    case 'work:shelved':
      return { kind: 'gnomon', text: `Gnomon shelved: ${clip(str(d.title), 80)}` };
    default:
      return null;
  }
}

/** `edited 3 files in puzzlebox-studio: a.ts, b.ts, c.ts` — and back, so a fold can merge two. */
const editLine = (project: string, names: readonly string[]) => `edited ${names.length} file${names.length === 1 ? '' : 's'}${project ? ` in ${project}` : ''}: ${names.slice(0, 4).join(', ')}${names.length > 4 ? `, +${names.length - 4}` : ''}`;
const EDIT_LINE = /^edited \d+ files?(?: in (\S+))?: (.*)$/;

/** A moment in a line: what the owner was in, for how long, and why the fold thought so. */
export function describeMoment(m: MomentRow): { kind: string; text: string } {
  const min = Math.round((Date.parse(m.end) - Date.parse(m.start)) / 60_000);
  const intent = (m.data.intent as { text?: unknown } | undefined)?.text;
  const meeting = str(m.data.meetingTitle);
  const heard = m.data.micActive === true || typeof m.data.spokenExcerpt === 'string';
  const what = meeting ? `in ${clip(meeting, 60)}${heard ? ' (mic on)' : ''}` : clip(str(intent), 80);
  return { kind: meeting ? 'meeting' : 'focus', text: `${m.process} ${min} min${m.projectId ? ` on ${baseName(m.projectId)}` : ''}${what ? `: ${what}` : ''}` };
}

export interface TimelineEntry {
  /** Owner-time HH:MM. */
  at: string;
  /** ISO instant, for ordering and for a second read. */
  ts: string;
  kind: string;
  text: string;
  /** The row (or moment) behind the line; the first one when lines were folded. */
  id: string;
  /** How many rows this line stands for, when more than one. */
  n?: number;
}

export interface TimelineFilter {
  /** A project name or path fragment: rows whose own fields name it, moments attributed to it. Away/back lines always stay: they explain the gaps. */
  project?: string;
  /** Every name a person goes by (see `namesFor`): rows naming any of them. */
  people?: string[];
  /** Words a row must hold. */
  contains?: string;
}

/** A moment counts from this many minutes; a flick is in the raw log, not the story. */
const MOMENT_MIN_MS = 3 * 60_000;
/** Lines of one kind and one text this close together fold into one line with a count. */
const FOLD_MS = 15 * 60_000;

const lowerJson = (v: unknown): string => JSON.stringify(v).toLowerCase();

/** Whole-word test for a name in a haystack already lower-cased. */
export function namesAny(hay: string, names: readonly string[]): boolean {
  return names.some((n) => {
    const w = n.trim().toLowerCase();
    if (w.length < 3) return false;
    const at = hay.indexOf(w);
    if (at < 0) return false;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u');
    return re.test(hay);
  });
}

const AWAY_TYPES = new Set(['idle:start', 'idle:end', 'system:sleep-wake']);

/** Whether a row passes the filter: what the postmortem counts, and what the timeline shows. */
export function keepRow(row: LogRow, filter: TimelineFilter): boolean {
  return keep(lowerJson(row.data), filter, AWAY_TYPES.has(row.type));
}

function keep(hay: string, filter: TimelineFilter, isAway: boolean): boolean {
  if (filter.project && !isAway && !hay.includes(filter.project.trim().toLowerCase())) return false;
  if (filter.people && filter.people.length > 0 && !namesAny(hay, filter.people)) return false;
  if (filter.contains && filter.contains.trim() !== '' && !hay.includes(filter.contains.trim().toLowerCase())) return false;
  return true;
}

/**
 * The window's rows as one ordered story.
 *
 * Folded where the log repeats itself: a PR re-reported unchanged, a meeting
 * re-sent while it runs, an agent snapshot that shows the same state, the
 * same command run five times, twelve file saves in a row. Everything else is
 * one line per row, oldest first.
 */
export function buildTimeline(rows: readonly LogRow[], moments: readonly MomentRow[], zone: string, filter: TimelineFilter = {}): TimelineEntry[] {
  const raw: TimelineEntry[] = [];
  const push = (ts: string, id: string, line: { kind: string; text: string } | null) => {
    if (line) raw.push({ at: formatClock(ts, zone), ts, kind: line.kind, text: line.text, id });
  };
  const prSeen = new Map<string, string>();
  const meetingSeen = new Set<string>();
  const fleetSeen = new Set<string>();
  const lastUrl = { url: '', at: 0 };

  for (const row of rows) {
    if (row.type === 'agent:fleet') {
      // A fleet row is a snapshot of every session; a line is a session starting to WAIT for
      // the owner. Its working/tool flips are hundreds a day (479 on one live day) and say
      // nothing a reader of the story needs.
      for (const s of Array.isArray(row.data.sessions) ? (row.data.sessions as Record<string, unknown>[]) : []) {
        if (s.state !== 'waiting') continue;
        const since = str(s.since) || row.ts;
        const key = `${str(s.id)}|${str(s.state)}|${since}`;
        if (fleetSeen.has(key) || !keep(lowerJson(s), filter, false)) continue;
        fleetSeen.add(key);
        const who = clip(str(s.title) || baseName(str(s.cwd)) || 'agent', 50);
        // `since` can predate the window: the first snapshot in it only restates.
        if (since < (rows[0]?.ts ?? row.ts)) continue;
        push(since, row.id, { kind: 'agent', text: `agent ${who}: waiting for you` });
      }
      continue;
    }
    if (!keepRow(row, filter)) continue;
    if (row.type === 'git:pr-status') {
      const sig = `${str(row.data.state)}|${str(row.data.checkState)}|${str(row.data.reviewState)}`;
      const pr = `${str(row.data.cwd)}#${str(row.data.number)}`;
      if (prSeen.get(pr) === sig) continue;
      prSeen.set(pr, sig);
    }
    if (row.type === 'calendar:active') {
      const e = eventOf(row);
      if (!e || meetingSeen.has(e.id)) continue;
      meetingSeen.add(e.id);
    }
    if (row.type === 'browser:tab') {
      const url = `${str(row.data.host)}${str(row.data.path)}`;
      const at = Date.parse(row.ts);
      if (url === lastUrl.url && at - lastUrl.at < FOLD_MS) continue;
      lastUrl.url = url;
      lastUrl.at = at;
    }
    push(row.ts, row.id, describeRow(row, zone));
  }
  for (const m of moments) {
    if (Date.parse(m.end) - Date.parse(m.start) < MOMENT_MIN_MS) continue;
    const hay = `${(m.projectId ?? '').toLowerCase()} ${lowerJson({ intent: m.data.intent, meetingTitle: m.data.meetingTitle, meetingAttendees: m.data.meetingAttendees, gitBranch: m.data.gitBranch })}`;
    if (!keep(hay, filter, false)) continue;
    push(m.start, m.id, describeMoment(m));
  }

  raw.sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
  const out: (TimelineEntry & { names?: string[] })[] = [];
  for (const e of raw) {
    const prev = out.at(-1);
    const near = prev !== undefined && Date.parse(e.ts) - Date.parse(prev.ts) < FOLD_MS;
    const a = prev?.kind === 'edit' ? EDIT_LINE.exec(prev.text) : null;
    const b = e.kind === 'edit' ? EDIT_LINE.exec(e.text) : null;
    const sameEdit = a !== null && b !== null && a[1] === b[1];
    const sameAgentSteps = e.kind === 'agent' && prev?.kind === 'agent' && e.text.startsWith('agent used') && prev.text.startsWith('agent used');
    if (near && prev.kind === e.kind && (prev.text === e.text || sameEdit || sameAgentSteps)) {
      if (sameEdit && prev.text !== e.text) {
        const names = [...new Set([...(prev.names ?? a![2]!.split(', ')), ...b![2]!.split(', ')])].filter((x) => !x.startsWith('+'));
        prev.names = names;
        prev.text = editLine(a![1] ?? '', names);
      }
      if (sameAgentSteps && prev.text !== e.text) prev.text = 'agent used several tools';
      prev.n = (prev.n ?? 1) + 1;
      continue;
    }
    out.push({ ...e });
  }
  return out.map(({ names: _names, ...e }) => e);
}

/**
 * A postmortem skeleton from the window's rows: what happened, what went
 * wrong, what fixed it, and the three questions only the owner can answer.
 *
 * Deterministic on purpose. The chat model can word it for the reader; the
 * facts in it are the log's, with times, and none is inferred.
 */
export function postmortemDraft(rows: readonly LogRow[], timeline: readonly TimelineEntry[], zone: string, label: string): { lines: string[]; counts: Record<string, number> } {
  const at = (ts: string) => formatClock(ts, zone);
  const shell = rows.filter((r) => r.type === 'shell:command');
  const failed = shell.filter((r) => typeof r.data.exitCode === 'number' && r.data.exitCode !== 0 && r.data.exitCode !== 130);
  const commits = rows.filter((r) => r.type === 'git:commit');
  const pushes = rows.filter((r) => r.type === 'git:push' || (r.type === 'shell:command' && /\bgit\s+push\b/.test(str(r.data.command)) && r.data.exitCode === 0));
  const forced = shell.filter((r) => /\bgit\s+push\b.*(\s--force\b|\s-f\b|--force-with-lease)/.test(str(r.data.command)));
  const reverts = commits.filter((r) => /^revert\b/i.test(str(r.data.commitLine)));
  const prRows = rows.filter((r) => r.type === 'git:pr-status');
  const ciRed = prRows.filter((r) => r.data.checkState === 'failure');
  const merged = [...new Map(prRows.filter((r) => r.data.state === 'MERGED').map((r) => [str(r.data.number), r])).values()];
  const meetings = timeline.filter((e) => e.kind === 'meeting');

  // Each failing command, and the first time the same command passed after it.
  const byCommand = new Map<string, { first: LogRow; n: number; fixedAt: string | null }>();
  for (const f of failed) {
    const cmd = str(f.data.command).trim();
    const entry = byCommand.get(cmd) ?? { first: f, n: 0, fixedAt: null };
    entry.n++;
    byCommand.set(cmd, entry);
  }
  for (const [cmd, entry] of byCommand) {
    const pass = shell.find((r) => str(r.data.command).trim() === cmd && r.data.exitCode === 0 && r.ts > entry.first.ts);
    entry.fixedAt = pass ? pass.ts : null;
  }
  const worst = [...byCommand.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 3);

  // Time away inside the window: idle start to the next idle end.
  let awayMs = 0;
  let idleFrom: string | null = null;
  for (const r of rows) {
    if (r.type === 'idle:start') idleFrom = r.ts;
    if (r.type === 'idle:end' && idleFrom) {
      awayMs += Date.parse(r.ts) - Date.parse(idleFrom);
      idleFrom = null;
    }
  }

  const lines: string[] = [`Postmortem draft: ${label}.`];
  if (timeline.length === 0) {
    lines.push('Nothing in the record for this window, so there is nothing to write up.');
    return { lines, counts: { rows: rows.length } };
  }
  lines.push(`What happened: ${timeline.length} lines from ${timeline[0]!.at} to ${timeline.at(-1)!.at}: ${commits.length} commits, ${pushes.length} pushes, ${shell.length} commands (${failed.length} failed), ${meetings.length} meetings${awayMs > 0 ? `, ${Math.round(awayMs / 60_000)} min away` : ''}.`);
  const trouble: string[] = [];
  for (const [cmd, e] of worst) trouble.push(`\`${clip(cmd, 60)}\` failed ${e.n}× from ${at(e.first.ts)}${e.fixedAt ? `, passed at ${at(e.fixedAt)}` : ', never passed in this window'}`);
  if (ciRed.length > 0) {
    const prs = [...new Set(ciRed.map((r) => str(r.data.number)))];
    trouble.push(`CI failed on PR ${prs.map((p) => `#${p}`).join(', ')} (first at ${at(ciRed[0]!.ts)})`);
  }
  if (reverts.length > 0) trouble.push(`${reverts.length} revert commit${reverts.length === 1 ? '' : 's'} (first at ${at(reverts[0]!.ts)})`);
  if (forced.length > 0) trouble.push(`${forced.length} force push${forced.length === 1 ? '' : 'es'} (first at ${at(forced[0]!.ts)})`);
  lines.push(trouble.length > 0 ? `What went wrong: ${trouble.join('; ')}.` : 'What went wrong: the record shows no failing command, red CI, revert or force push in this window.');
  const fixes: string[] = [];
  for (const [cmd, e] of worst) if (e.fixedAt) fixes.push(`\`${clip(cmd, 60)}\` green at ${at(e.fixedAt)}`);
  for (const m of merged) fixes.push(`PR #${str(m.data.number)} merged by ${at(m.ts)}`);
  const lastCommit = commits.at(-1);
  if (lastCommit) fixes.push(`last commit ${at(lastCommit.ts)}: ${clip(str(lastCommit.data.commitLine), 70)}`);
  lines.push(fixes.length > 0 ? `What resolved it: ${fixes.join('; ')}.` : 'What resolved it: nothing in the record shows a fix yet.');
  if (meetings.length > 0) lines.push(`Meetings inside it: ${meetings.map((m) => `${m.at} ${m.text}`).slice(0, 4).join('; ')}.`);
  lines.push('For you to fill: the impact (who noticed, for how long), the root cause, and the one change that stops it happening again.');
  return {
    lines,
    counts: { lines: timeline.length, commits: commits.length, pushes: pushes.length, commands: shell.length, failed: failed.length, ciRed: ciRed.length, reverts: reverts.length, forcePushes: forced.length, merged: merged.length, meetings: meetings.length, awayMin: Math.round(awayMs / 60_000) },
  };
}
