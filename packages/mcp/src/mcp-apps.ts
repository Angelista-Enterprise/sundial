// fallow-ignore-next-line unresolved-import
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// fallow-ignore-next-line unresolved-import
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import fs from 'node:fs';
import { z } from 'zod';
import { readGoals } from '@sundial/dsh-theme/host/read-goals.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { readOpenAsk } from '@sundial/kernel/read/open-ask.js';
import { readRhythm, type RhythmRead } from '@sundial/kernel/read/rhythm.js';
import { readToday, type TodayRead } from '@sundial/kernel/read/today.js';
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js';
import { TOOL_REGISTRY, toolEnv } from '@sundial/kernel/tools/index.js';
import type { ToolEnv } from '@sundial/kernel/tools/registry.js';
import { composeFigure } from '@sundial/kernel/tools/figure-tools.js';
import type { Figure } from '@sundial/kernel/types.js';
import { recordMcpCall } from './mcp-tools.js';
import { WRITE_TOOLS } from './mcp-writes.js';

/**
 * Track B2: Sundial's first MCP Apps, read-only — Today, a figure, the goals.
 * Track B3: the notices (Seen on the page) and the ledger table.
 * Track B4: the open question, answered on the page, through elicitation, or by text.
 *
 * An MCP App is a tool whose `_meta.ui.resourceUri` names an HTML resource; a host that
 * draws apps (VS Code, Cursor, Goose, Claude.ai, ChatGPT) shows that page in a sandboxed
 * iframe and hands it the tool's result. A host that does not (Claude Code) shows the
 * tool's text. So every tool here returns both: `content` text a model can read, and
 * `structuredContent` the page draws — and the Claude mod draws the same object in its
 * band, which is the one data contract this step is built around.
 *
 * The data is the web client's own: `gnomon_today` is gnomon_brief's standup, the
 * dial-slice figure, and the kernel's Today and Rhythm readers (the routes behind /gnomon/today
 * and /gnomon/rhythm); `gnomon_goals` is /gnomon/goals, read through the theme's own reader
 * because its logic is shared with the browser shell (shell/goals.js);
 * `gnomon_compose_figure` is the kernel's figure. The pages are the shell's own drawing
 * modules, bundled by `apps/build.mjs` into `apps/dist/`. Nothing here writes.
 */

const UI = (name: string) => `ui://sundial/${name}.html`;
const DIST = new URL('../apps/dist/', import.meta.url);

/** The page for an app, as built. A missing build is said plainly rather than served empty. */
export function appHtml(name: string): string {
  try {
    return fs.readFileSync(new URL(`${name}.html`, DIST), 'utf8');
  } catch {
    throw new Error(`The Sundial app "${name}" is not built: run \`pnpm --filter @sundial/mcp build\` (or \`sundial install\`).`);
  }
}

/** `2h 05m`, the way every other surface says a duration. */
const hm = (min: number) => (min >= 60 ? `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m` : `${Math.round(min)}m`);
const clock = (min: number, dayStartsAt: number) => {
  const m = (dayStartsAt * 60 + Math.round(min)) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** A figure as lines: the caption, then its numbers, so a host without apps still gets the drawing's claim. */
export function figureText(figure: Figure | { unavailable: string }): string {
  if ('unavailable' in figure) return figure.unavailable;
  const lines: string[] = [figure.caption];
  switch (figure.kind) {
    case 'dial-slice':
      lines.push(`Axis ${figure.fromHour}:00 to ${figure.toHour}:00; observed ${hm(figure.observedMin)} of ${hm(figure.wallClockMin)}${figure.nowHour !== null ? `; now at ${figure.nowHour.toFixed(1)}h` : ''}.`);
      if (figure.deepBlocks.length) lines.push(`Deep work: ${figure.deepBlocks.map((b) => `${b.startHour.toFixed(1)}–${b.endHour.toFixed(1)}h`).join(', ')}.`);
      if (figure.meetings.length) lines.push(`Meetings: ${figure.meetings.map((m) => `${m.startHour.toFixed(1)}–${m.endHour.toFixed(1)}h`).join(', ')}.`);
      lines.push(`Energy by hour: ${figure.curve.map((p) => `${p.hour}h ${Math.round(p.score)}`).join(', ')}.`);
      break;
    case 'trend-slice':
      for (const d of figure.days) lines.push(`${d.date}  ${d.observed ? hm(d.minutes) : 'not observed'}`);
      break;
    case 'graph-neighborhood':
      lines.push(`${figure.center.name} (${figure.center.kind})`);
      for (const e of figure.edges) lines.push(`  ${e.predicate} → ${e.toName} [${e.provenance}]`);
      break;
    case 'fact-chain':
      lines.push(`${figure.entityName} · ${figure.predicate}`);
      for (const l of figure.links) lines.push(`  ${l.at.slice(0, 10)}  ${l.object}  (${Math.round(l.confidence * 100)}%, ${l.provenance}${l.supersededAt ? `, superseded ${l.supersededAt.slice(0, 10)}` : ''})`);
      break;
    case 'commitment-thread':
      lines.push(`${figure.name}${figure.branch ? ` on ${figure.branch}` : ''}: opened ${figure.openedAt?.slice(0, 10) ?? '—'}, ${figure.activeDays} active days, ${figure.touches} touches.`);
      break;
    case 'census':
      for (const r of figure.rows) lines.push(`${r.label}  ${r.count}${r.total !== null ? ` of ${r.total}` : ''}`);
      break;
  }
  return lines.join('\n');
}

export interface TodayView {
  date: string;
  timeZone: string;
  brief: Record<string, unknown>;
  dial: Figure | { unavailable: string };
  today: TodayRead;
  rhythm: RhythmRead;
}

/** Today as lines: the brief, the dial's claim, the projects, the day's span and the rhythm's rows. */
export function todayText(view: TodayView): string {
  const lines: string[] = [`Today · ${view.date} (${view.timeZone})`];
  const brief = view.brief as { lines?: unknown; unavailable?: string; none?: string };
  if (Array.isArray(brief.lines) && brief.lines.length) lines.push(...brief.lines.map(String));
  else lines.push(brief.unavailable ?? brief.none ?? 'Nothing on the record for a standup yet.');
  lines.push('', 'unavailable' in view.dial ? view.dial.unavailable : view.dial.caption);
  const projects = view.today.projects ?? [];
  if (projects.length) lines.push(`Projects: ${projects.map((p) => `${p.name} ${hm(p.minutes)}${p.commits ? ` (${p.commits} commits)` : ''}`).join(', ')}.`);
  if (view.today.meetings) lines.push(`Meetings: ${view.today.meetings}.`);
  const start = view.rhythm.dayStartsAt ?? 4;
  const days = view.rhythm.days ?? [];
  if (days.length) {
    lines.push('', `Rhythm, ${days.length} days (first touch → last touch, hours seen):`);
    for (const d of [...days].reverse()) lines.push(`${d.date}  ${clock(d.firstMin, start)} → ${clock(d.lastMin, start)}${typeof d.observedHours === 'number' ? `  ${d.observedHours}h` : ''}`);
  }
  return lines.join('\n');
}

/** The one read behind `gnomon_today`: the web client's own four parts, for one date. */
export async function readTodayView(env: ToolEnv, date?: string): Promise<TodayView> {
  const state = await env.state();
  const timeZone = loadSundialConfig().timezone;
  const day = date ?? localDate(env.now.toISOString(), timeZone);
  const briefTool = TOOL_REGISTRY.find((t) => t.name === 'gnomon_brief');
  const [brief, dial, today, rhythm] = await Promise.all([
    briefTool ? (briefTool.handler({ kind: 'standup' } as never, env) as Promise<Record<string, unknown>>) : Promise.resolve({ unavailable: 'gnomon_brief is not in the registry.' }),
    composeFigure({ kind: 'dial-slice', date: day }, env.now),
    readToday({ state, date: day, timeZone, isToday: day === localDate(env.now.toISOString(), timeZone) }),
    // Two weeks ending on `day`, the same floor the web client's Rhythm card has.
    readRhythm({ until: day, days: 14, now: env.now.getTime(), timeZone }),
  ]);
  return { date: day, timeZone, brief, dial, today, rhythm };
}

/** Audited like every other call (`recordMcpCall`), never with its arguments. */
async function audited<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const out = await run();
    recordMcpCall(name, 'ok', started);
    return out;
  } catch (error) {
    recordMcpCall(name, 'failed', started);
    throw error;
  }
}

const text = (t: string) => [{ type: 'text' as const, text: t }];
const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

/** The registry tools these apps take over: `registerTools` skips them so each is registered once. */
export const APP_TOOL_NAMES = ['gnomon_compose_figure', 'gnomon_goals', 'gnomon_notices', 'gnomon_llm_ledger'] as const;

export interface OpenAskView {
  open: { askId: string; question: string; reason: string | null; choices: string[]; waiting: boolean; ts: string } | null;
  /** The owner answered through the host's elicitation form during this call; the write is queued. */
  answered?: { askId: string; answer: string };
  /** The owner declined or dismissed the host's form. */
  declined?: boolean;
}

/** The open question as text: the question, its reason, the choices, and how to answer it from here. */
export function openAskText(view: OpenAskView, canElicit: boolean): string {
  if (view.open === null) return 'Gnomon is not waiting on the owner for anything right now.';
  const lines = [`Gnomon asks: ${view.open.question}`];
  if (view.open.reason) lines.push(`Because: ${view.open.reason}`);
  if (view.open.choices.length) lines.push(`Choices: ${view.open.choices.join(' · ')}`);
  if (view.answered) lines.push(`The owner answered "${view.answered.answer}" (askId ${view.answered.askId}); Sundial records it within seconds.`);
  else if (view.declined) lines.push('The owner dismissed the question here. Do not answer for them.');
  else if (canElicit) lines.push(`Not answered. Call again with ask: true to put the question to the owner, or record what they say with gnomon_owner_answer (askId ${view.open.askId}).`);
  else lines.push(`Only the owner answers it: when they do, record it with gnomon_owner_answer (askId ${view.open.askId}). Never answer for them.`);
  return lines.join('\n');
}

export function registerApps(server: McpServer, env: () => ToolEnv = toolEnv): void {
  const figureTool = TOOL_REGISTRY.find((t) => t.name === 'gnomon_compose_figure');
  const goalsTool = TOOL_REGISTRY.find((t) => t.name === 'gnomon_goals');
  if (!figureTool || !goalsTool) throw new Error('The registry no longer holds gnomon_compose_figure or gnomon_goals.');

  // B3: the notices (with Seen on the page, onto the granted gnomon_notice_seen write) and the
  // ledger table. Their text is the registry's own JSON, unchanged: the Claude mod parses it.
  for (const [name, page, more] of [
    ['gnomon_notices', 'notices', 'Hosts that draw MCP Apps show the list with Seen on each notice.'],
    ['gnomon_llm_ledger', 'ledger', 'Hosts that draw MCP Apps show the rows as a sortable table.'],
  ] as const) {
    const tool = TOOL_REGISTRY.find((t) => t.name === name);
    if (!tool) throw new Error(`The registry no longer holds ${name}.`);
    registerAppTool(server, name, { description: `${tool.description} ${more}`, inputSchema: tool.schema, annotations: READ, _meta: { ui: { resourceUri: UI(page) } } }, async (args) =>
      audited(name, async () => {
        const out = (await tool.handler(args as never, env())) as Record<string, unknown>;
        return { content: text(JSON.stringify(out, null, 2)), structuredContent: out };
      }),
    );
  }

  registerAppTool(
    server,
    'gnomon_today',
    {
      description:
        "Today as Sundial shows it, in one call: the standup brief (gnomon_brief), today's dial (the dial-slice figure), the day's numbers per project (the same as the web client's Today), and the last two weeks' rhythm — first touch to last touch per day, with the hours Sundial was watching. A host that draws MCP Apps shows Sundial's own Today card; the text has the same lines. `date` (YYYY-MM-DD) asks for another day.",
      inputSchema: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD in the owner timezone, defaults to today') },
      annotations: READ,
      _meta: { ui: { resourceUri: UI('today') } },
    },
    async ({ date }) =>
      audited('gnomon_today', async () => {
        const view = await readTodayView(env(), date);
        return { content: text(todayText(view)), structuredContent: view as unknown as Record<string, unknown> };
      }),
  );

  registerAppTool(
    server,
    figureTool.name,
    { description: `${figureTool.description} Hosts that draw MCP Apps show the figure drawn; the text carries its numbers.`, inputSchema: figureTool.schema, annotations: READ, _meta: { ui: { resourceUri: UI('figure') } } },
    async (args) =>
      audited(figureTool.name, async () => {
        const figure = (await figureTool.handler(args as never, env())) as Figure | { unavailable: string };
        return { content: text(figureText(figure)), structuredContent: figure as unknown as Record<string, unknown> };
      }),
  );

  registerAppTool(
    server,
    goalsTool.name,
    { description: `${goalsTool.description} Hosts that draw MCP Apps show each goal on its trail.`, inputSchema: goalsTool.schema, annotations: READ, _meta: { ui: { resourceUri: UI('goals') } } },
    async (args) =>
      audited(goalsTool.name, async () => {
        const e = env();
        // The text is the registry's own answer, unchanged for every host that reads it today;
        // the page gets what the web client's Goals surface reads, trails and steps included.
        const [rows, view] = await Promise.all([goalsTool.handler(args as never, e), readGoals({ now: e.now.getTime() })]);
        return { content: text(JSON.stringify(rows, null, 2)), structuredContent: view };
      }),
  );

  // B4: the question Gnomon is waiting on. Three ways to answer it, by what the host has:
  // a host that draws apps gets the page with the choices as acts (onto gnomon_owner_answer);
  // a host that declared elicitation gets the question as a form when asked (`ask: true`), and
  // the answer is queued here; any other host gets the text and the askId for gnomon_owner_answer.
  // The 2026-07-28 `input_required` shape is in no SDK yet (see B1), so elicitation/create is the one form.
  const answerTool = WRITE_TOOLS.find((t) => t.name === 'gnomon_owner_answer');
  if (!answerTool) throw new Error('mcp-writes no longer holds gnomon_owner_answer.');
  registerAppTool(
    server,
    'gnomon_open_ask',
    {
      description:
        "The one question Gnomon is waiting on the owner for, with its reason and choices, or none. Use it before asking the owner something yourself: if Gnomon already asked, put that question to them. `ask: true` puts it to the owner through this host's own form when the host has one; their answer is recorded. Otherwise record what they said with gnomon_owner_answer. Never answer for the owner.",
      inputSchema: { ask: z.boolean().optional().describe("Put the question to the owner through the host's form, when the host has one. Default false.") },
      annotations: READ,
      _meta: { ui: { resourceUri: UI('ask') } },
    },
    async ({ ask }) =>
      audited('gnomon_open_ask', async () => {
        const e = env();
        const view: OpenAskView = readOpenAsk(await e.state());
        const canElicit = Boolean(server.server.getClientCapabilities()?.elicitation);
        if (ask === true && canElicit && view.open !== null) {
          const { question, reason, choices, askId } = view.open;
          const result = await server.server.elicitInput({
            mode: 'form',
            message: reason ? `${question}\n\n${reason}` : question,
            requestedSchema: { type: 'object', properties: { answer: choices.length ? { type: 'string', title: 'Answer', enum: choices } : { type: 'string', title: 'Answer', maxLength: 2000 } }, required: ['answer'] },
          });
          const answer = typeof result.content?.answer === 'string' ? result.content.answer.trim() : '';
          if (result.action === 'accept' && answer !== '') {
            await answerTool.handler({ askId, answer } as never, e);
            view.answered = { askId, answer };
          } else view.declined = true;
        }
        return { content: text(openAskText(view, canElicit)), structuredContent: view as unknown as Record<string, unknown> };
      }),
  );

  for (const name of ['today', 'figure', 'goals', 'notices', 'ledger', 'ask']) {
    registerAppResource(server, `Sundial ${name}`, UI(name), { description: `Sundial's ${name} card, drawn by the host beside the tool's answer.` }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: appHtml(name) }],
    }));
  }
}
