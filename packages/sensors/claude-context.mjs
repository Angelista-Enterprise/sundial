#!/usr/bin/env node
// Sundial's Claude Code SessionStart context hook (#11). It ADDS CONTEXT:
// Claude Code puts a SessionStart hook's stdout into the new session. The
// owner approved that for SessionStart only (2026-09-29); every other Sundial
// hook stays report-only (claude-hook.mjs).
//
// It prints at most five short lines about the session's folder: the project,
// the open ticket its branch names, open promises on the project, the last
// failure there, and the last "where was I" line. Nothing when the folder is
// no known project, when Sundial is not running (the newest kernel snapshot is
// stale), when `privacy.claudeContext` is false in config.json, or on any
// error or after HARD_MS. Read-only: one `sqlite3 -readonly` read of the
// newest kernel snapshot. No secret, no port, no write. Every value printed is
// already sanitized at ingest; nothing is redacted again here.
//
// Usage: node claude-context.mjs <SUNDIAL_HOME>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MAX_LINES = 5;
export const MAX_LINE_CHARS = 160;
/** The whole hook gives up (and prints nothing) after this. */
export const HARD_MS = 450;
/** A snapshot is written every minute while Sundial runs; older than this means it does not. */
export const STALE_MS = 10 * 60_000;
/** A "where was I" line older than this is not where the owner was. */
export const RESUME_FRESH_MS = 12 * 3_600_000;

const clip = (s, max = MAX_LINE_CHARS) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);
const within = (p, root) => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);

/** The repository's main root and the checked-out branch, from `.git` alone (a worktree's `.git` file names its main repository). */
export function gitOf(cwd) {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    let stat;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      if (path.dirname(dir) === dir) return null;
      continue;
    }
    let gitDir = dotGit;
    let root = dir;
    if (stat.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (!m) return null;
      gitDir = path.resolve(dir, m[1].trim());
      const i = gitDir.indexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
      if (i > 0) root = gitDir.slice(0, i);
    }
    let branch = null;
    try {
      branch = /^ref: refs\/heads\/(.+)$/m.exec(fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8'))?.[1]?.trim() ?? null;
    } catch {
      /* detached or unreadable: no branch */
    }
    return { root, branch };
  }
}

/** The known project the folder is in: the longest root that contains it, in either path form the record may hold. */
function projectFor(known, paths, home) {
  const forms = paths.flatMap((p) => (home && within(p, home) ? [p, `~${p.slice(home.length)}`] : [p]));
  let best = null;
  for (const root of Object.keys(known ?? {})) {
    if (forms.some((p) => within(p, root)) && (!best || root.length > best.length)) best = root;
  }
  return best;
}

function clock(iso, tz, withDay = false) {
  try {
    return new Intl.DateTimeFormat('en-GB', { ...(withDay ? { weekday: 'short', day: 'numeric', month: 'short' } : {}), hour: '2-digit', minute: '2-digit', hour12: false, ...(tz ? { timeZone: tz } : {}) }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16).replace('T', ' ');
  }
}

/** A person as the log holds them; a bare `person-<hash>` names nobody a reader knows. */
const who = (p) => (typeof p === 'string' && p !== '' && !p.startsWith('person-') ? p : null);

/**
 * The lines for one folder, from the snapshot's slices. Pure; exported for the
 * test. `snap` = { at, known, tickets, lastFailure, open, resume, fleet, tz }.
 */
export function contextLines(snap, cwd, { nowMs = Date.now(), home = os.homedir(), git = gitOf(cwd) } = {}) {
  if (!snap || typeof cwd !== 'string' || nowMs - Date.parse(snap.at) > STALE_MS) return [];
  const root = projectFor(snap.known, [cwd, ...(git?.root && git.root !== cwd ? [git.root] : [])], home);
  if (!root) return [];
  const known = snap.known[root] ?? {};
  const name = known.name ?? root.split('/').filter(Boolean).at(-1) ?? root;
  const tz = snap.tz ?? undefined;
  const lines = [];

  // The project, and the ticket the branch names once work on it got past `seen`.
  const branch = git?.branch ?? known.branch ?? null;
  // A whole key only (`box-48` is not `BOX-4`), the longest first.
  const names = (id) => new RegExp(`(^|[^a-z0-9])${String(id).toLowerCase().replace(/[^a-z0-9]/g, (c) => `\\${c}`)}(?![a-z0-9])`).test(branch.toLowerCase());
  const ticket = branch ? Object.values(snap.tickets ?? {}).filter((t) => t && t.stage !== 'seen' && names(t.id)).sort((a, b) => String(b.id).length - String(a.id).length)[0] : undefined;
  let head = `Gnomon (Sundial) — project: ${name}`;
  if (branch) head += ` · branch ${branch}`;
  if (ticket) {
    const pr = ticket.pr?.number ? `, PR #${ticket.pr.number}${ticket.pr.reviewState ? ` ${String(ticket.pr.reviewState).toLowerCase().replace(/_/g, ' ')}` : ticket.pr.state ? ` ${String(ticket.pr.state).toLowerCase()}` : ''}` : '';
    head += ` · open ticket ${ticket.id} (${ticket.stage}${pr})`;
  }
  lines.push(head);

  // Open promises on this project, the soonest due first.
  const promises = (snap.open ?? []).filter((c) => c?.promise && c.projectId === root).sort((a, b) => String(a.promise.due ?? '9').localeCompare(String(b.promise.due ?? '9')));
  if (promises.length > 0) {
    const p = promises[0].promise;
    const other = who(p.counterparty);
    const side = p.direction === 'awaiting' ? `owed to you${other ? ` by ${other}` : ''}` : `you owe${other ? ` ${other}` : ''}`;
    const due = p.due ? `, due ${clock(p.due, tz, true)}` : '';
    lines.push(`Open promises on ${name}: ${promises.length} — "${clip(p.deliverable ?? promises[0].name, 60)}" (${side}${due})`);
  }

  // The newest failure here that has not passed since: a command, or a Claude session that stopped on an error.
  // Here = this project, not a known project nested inside it.
  const here = (dir) => projectFor(snap.known, [dir], home) === root;
  const failure = Object.entries(snap.lastFailure ?? {}).filter(([dir]) => here(dir)).sort((a, b) => b[1].at.localeCompare(a[1].at))[0]?.[1];
  const agent = (snap.fleet ?? []).filter((s) => s?.state === 'failed' && typeof s.cwd === 'string' && here(s.cwd)).sort((a, b) => b.since.localeCompare(a.since))[0];
  if (failure && (!agent || failure.at >= agent.since)) lines.push(`Last failure here: \`${clip(failure.command, 60)}\` exited ${failure.exitCode} at ${clock(failure.at, tz)} and has not passed since`);
  else if (agent) lines.push(`Last failure here: a Claude session stopped on an error${agent.error ? ` (${agent.error})` : ''} at ${clock(agent.since, tz)}`);

  // Where the owner was, when the last return line was about this project.
  const last = snap.resume;
  if (last?.line && last.pieces?.project?.id === root && nowMs - Date.parse(last.at) <= RESUME_FRESH_MS) lines.push(`Where the owner was (${clock(last.at, tz)}): ${last.line}`);

  return lines.slice(0, MAX_LINES).map((l) => clip(l));
}

const SQL = `select json_object('at', created_at,
  'known', json_extract(state_json, '$.project.known'),
  'tickets', json_extract(state_json, '$.tickets'),
  'lastFailure', json_extract(state_json, '$.shell.lastFailure'),
  'open', json_extract(state_json, '$.commitments.open'),
  'resume', json_extract(state_json, '$.resume.last'),
  'fleet', json_extract(state_json, '$.agent.fleet'),
  'tz', json_extract(state_json, '$.config.timezone'))
from kernel_state_snapshots order by created_at desc limit 1;`;

/** The newest snapshot's slices, read-only, or null. */
export function readSnapshot(home, timeoutMs = HARD_MS - 100) {
  const db = path.join(home, 'sundial.db');
  if (!fs.existsSync(db)) return null;
  const bin = fs.existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3';
  const r = spawnSync(bin, ['-readonly', '-batch', '-noheader', db, SQL], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  return JSON.parse(r.stdout);
}

/** `privacy.claudeContext: false` in config.json keeps this hook silent. */
export function contextAllowed(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))?.privacy?.claudeContext !== false;
  } catch {
    return true; // a missing file is valid: every field is optional
  }
}

const isMain = (() => {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] ?? '');
  } catch {
    return false;
  }
})();

if (isMain) {
  setTimeout(() => process.exit(0), HARD_MS).unref();
  const home = process.argv[2];
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw);
      if (home && input?.hook_event_name === 'SessionStart' && typeof input.cwd === 'string' && contextAllowed(home)) {
        const lines = contextLines(readSnapshot(home), input.cwd);
        if (lines.length > 0) fs.writeSync(1, `${lines.join('\n')}\n`);
      }
    } catch {
      /* a hook must never fail Claude, and never print half a thought */
    }
    process.exit(0);
  });
}
