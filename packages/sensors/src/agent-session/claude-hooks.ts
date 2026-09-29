import fs from 'node:fs';
import path from 'node:path';
import { getSundialHome } from '@sundial/helpers/config.js';

/**
 * Claude Code's own hook events, as `packages/sensors/claude-hook.mjs` appends
 * them to `$SUNDIAL_HOME/.daemon/claude-hooks.jsonl` (U3-F8).
 *
 * The hook script already whitelisted every line: event name, session id8,
 * cwd, a notification/failure/start/end TYPE, the tool name, an edited file's
 * path inside the cwd. This sensor only tails the file and turns each line into
 * one `agent:hook` event at the line's own time.
 *
 * Starts at the end of the file: lines from before a restart are not replayed
 * (the registry poll already says what state each session is in now). A
 * shorter file than the last offset is a rotation, read from the start.
 */
export interface AgentHookEvent {
  type: 'agent:hook';
  payload: { timestamp: string; event: string; session: string; cwd?: string; detail?: string; tool?: string; file?: string; subagent?: boolean };
  ts: string;
}

const MAX_READ = 256 * 1024;

export function parseHookLine(line: string): AgentHookEvent | null {
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof r.ts !== 'string' || Number.isNaN(Date.parse(r.ts)) || typeof r.event !== 'string' || typeof r.session !== 'string') return null;
  const str = (k: string) => (typeof r[k] === 'string' ? { [k]: r[k] as string } : {});
  return {
    type: 'agent:hook',
    ts: r.ts,
    payload: { timestamp: r.ts, event: r.event, session: r.session, ...str('cwd'), ...str('detail'), ...str('tool'), ...str('file'), ...(r.subagent === true ? { subagent: true } : {}) },
  };
}

export class ClaudeHookSensor {
  private offset: number | null = null;

  constructor(private readonly file: string = path.join(getSundialHome(), '.daemon', 'claude-hooks.jsonl')) {}

  poll(): AgentHookEvent[] {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      this.offset ??= 0;
      return [];
    }
    if (this.offset === null) {
      this.offset = size;
      return [];
    }
    if (size < this.offset) this.offset = 0;
    if (size === this.offset) return [];
    const length = Math.min(size - this.offset, MAX_READ);
    const buf = Buffer.alloc(length);
    const fd = fs.openSync(this.file, 'r');
    try {
      fs.readSync(fd, buf, 0, length, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    const text = buf.toString('utf8');
    // Only whole lines; a half-written last line waits for the next poll.
    const end = text.lastIndexOf('\n');
    if (end < 0) return [];
    this.offset += Buffer.byteLength(text.slice(0, end + 1));
    return text
      .slice(0, end)
      .split('\n')
      .map(parseHookLine)
      .filter((e): e is AgentHookEvent => e !== null);
  }
}
