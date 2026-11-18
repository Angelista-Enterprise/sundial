// fallow-ignore-next-line unresolved-import
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TOOL_REGISTRY, toolEnv } from '@sundial/kernel/tools/index.js';
import type { ToolEnv } from '@sundial/kernel/tools/registry.js';
import { readTodayView, todayText } from './mcp-apps.js';

/**
 * Track B5: three prompts, which hosts show as slash commands (`/mcp__sundial__brief` in Claude
 * Code, `/mcp.sundial.brief` in VS Code). Each is the record read without a model, then one line
 * saying what to do with it: the host's model says it to the owner, as it is. A prompt argument
 * is a string by the protocol, so `days` arrives as text and is parsed here.
 */

const SAY = 'This is Sundial\'s record, read without a model. Say it to the owner as it is; add nothing the record does not say, and say plainly what is empty.';

const user = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });

/** The brief as lines, whichever shape gnomon_brief answered with. */
export function briefText(kind: string, out: Record<string, unknown>): string {
  if (typeof out.unavailable === 'string') return out.unavailable;
  if (typeof out.none === 'string') return out.none;
  const lines: string[] = [];
  const meeting = out.meeting as { title?: string; start?: string } | undefined;
  if (meeting?.title) lines.push(`Prep for "${meeting.title}" at ${meeting.start ?? '?'}:`);
  if (Array.isArray(out.lines)) lines.push(...out.lines.map(String));
  else lines.push(JSON.stringify(out, null, 2));
  if (typeof out.note === 'string') lines.push(out.note);
  return lines.length ? `${kind === 'week' ? 'The week in review' : kind === 'meeting' ? 'Meeting prep' : 'Standup'}\n${lines.join('\n')}` : 'Nothing on the record for this brief.';
}

export function registerPrompts(server: McpServer, env: () => ToolEnv = toolEnv): void {
  const tool = (name: string) => {
    const t = TOOL_REGISTRY.find((x) => x.name === name);
    if (!t) throw new Error(`The registry no longer holds ${name}.`);
    return t;
  };
  const brief = tool('gnomon_brief');
  const handoff = tool('gnomon_project_handoff');

  server.registerPrompt(
    'brief',
    {
      title: 'Brief',
      description: 'The standup lines, the prep for the next meeting with others, or the week in review, read from the record.',
      argsSchema: { kind: z.enum(['standup', 'meeting', 'week']).optional().describe('Which brief. Default standup.'), title: z.string().optional().describe('For meeting: part of the meeting title.') },
    },
    async ({ kind = 'standup', title }) => {
      const out = (await brief.handler({ kind, ...(title ? { title } : {}) } as never, env())) as Record<string, unknown>;
      return user(`${briefText(kind, out)}\n\n${SAY}`);
    },
  );

  server.registerPrompt(
    'today',
    { title: 'Today', description: "Today as Sundial shows it: the standup brief, the dial's claim, the projects, and the last two weeks' rhythm.", argsSchema: { date: z.string().optional().describe('YYYY-MM-DD in the owner timezone. Default today.') } },
    async ({ date }) => user(`${todayText(await readTodayView(env(), date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined))}\n\n${SAY}`),
  );

  server.registerPrompt(
    'handoff',
    { title: 'Handoff', description: 'The handoff for one project: where it stands, decisions, open threads, people, promises, agent sessions and risky files. Every line is a counted row in the record.', argsSchema: { project: z.string().describe('The project name or its root path'), days: z.string().optional().describe('How far back to look, in days. Default 30.') } },
    async ({ project, days }) => {
      const span = Number(days);
      const out = (await handoff.handler({ project, ...(Number.isInteger(span) && span > 0 ? { days: Math.min(90, span) } : {}) } as never, env())) as Record<string, unknown>;
      const text = typeof out.text === 'string' ? out.text : `${String(out.note ?? 'No handoff.')}${Array.isArray(out.known) && out.known.length ? `\nKnown projects: ${out.known.join(', ')}` : ''}`;
      return user(`${text}\n\n${SAY}`);
    },
  );
}
