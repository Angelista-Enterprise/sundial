#!/usr/bin/env node
// Sundial's Claude Code hook: REPORT ONLY.
//
// `sundial install` registers this file in ~/.claude/settings.json for a few
// hook events (see CLAUDE_HOOK_EVENTS in bin/sundial). Claude runs it with the
// event as JSON on stdin; it appends ONE line to
// <SUNDIAL_HOME>/.daemon/claude-hooks.jsonl and exits 0 with no output, so it
// never approves, denies, blocks or adds context to anything. The agent-session
// sensor tails that file. A file, not HTTP: the web guard's internal token is
// memory-only, and a file keeps working while Sundial is down.
//
// Only named fields are copied (a whitelist, never a blacklist): the event
// name, the first 8 characters of the session id, the cwd, the notification or
// failure TYPE, and for an edit the file's path inside the cwd. Never the
// prompt, the assistant's message, a notification's text, or a tool's input.
//
// Usage: node claude-hook.mjs <SUNDIAL_HOME>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 1024 * 1024;
const token = (v) => (typeof v === 'string' && /^[A-Za-z_]{1,40}$/.test(v) ? v : undefined);

/** The line written for one hook payload, or null when there is nothing to report. Exported for the test. */
export function hookLine(input, now = new Date()) {
  if (!input || typeof input !== 'object' || typeof input.session_id !== 'string' || !token(input.hook_event_name)) return null;
  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  const line = { ts: now.toISOString(), event: input.hook_event_name, session: input.session_id.slice(0, 8), cwd };
  const detail = token(input.notification_type) ?? token(input.error_type) ?? token(input.source) ?? token(input.reason) ?? token(input.trigger);
  if (detail) line.detail = detail;
  if (input.agent_id) line.subagent = true;
  const tool = token(input.tool_name);
  if (tool) line.tool = tool;
  const file = input.tool_input && typeof input.tool_input.file_path === 'string' ? input.tool_input.file_path : null;
  if (file && cwd) {
    const rel = path.relative(cwd, path.resolve(cwd, file));
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) line.file = rel;
  }
  return line;
}

function append(home, line) {
  const dir = path.join(home, '.daemon');
  // No data folder, no Sundial: never create one from here.
  if (!fs.existsSync(dir)) return;
  const file = path.join(dir, 'claude-hooks.jsonl');
  try {
    if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    /* no file yet */
  }
  process.umask(0o077);
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

const isMain = (() => {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] ?? '');
  } catch {
    return false;
  }
})();

if (isMain) {
  const home = process.argv[2];
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', () => {
    try {
      const line = hookLine(JSON.parse(raw));
      if (home && line) append(home, line);
    } catch {
      /* a hook must never fail Claude */
    }
    process.exit(0);
  });
}
