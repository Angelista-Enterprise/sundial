import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getAllSignalsInRange } from '@sundial/db/index.js';
import { getSundialRuntimeDir } from '@sundial/helpers/sundial-paths.js';
import { ASSERTABLE_ENTITY_KINDS, VERDICTS } from '@sundial/helpers/vocab.js';
import { inletPayload, readInlets } from '@sundial/helpers/inlets.js';
import { executeGnomonTool, type GnomonTool, type ToolEnv } from '@sundial/kernel/tools/index.js';
import { validateWatchRule } from '@sundial/kernel/watch.js';
import { flowBefore, flowFrom, watchRoomFor } from '@sundial/kernel/watch-flow.js';

/**
 * The MCP server's writes: three granted 2026-10-05 (docs/decision-mods-may-act.md), and the
 * owner's answer to Gnomon's open question, granted 2026-10-05 for Track B4.
 *
 * This server is a separate process and the log has one writer, so a write is a request: one
 * file in `$SUNDIAL_HOME/.daemon/mcp-writes/`, which the running Sundial applies with the same
 * handler as `/gnomon/api/feedback` or `/gnomon/api/assert` (`plugins/sundial-theme/host/
 * mcp-writes.js`). A request made while Sundial is down is applied at its next boot. The shapes
 * here are the routes' own, checked with the same vocabulary; the handler checks them again.
 */

const NOTICE_LOOKBACK_MS = 7 * 86_400_000;

/** Writes one request file whole: a dot-file renamed into place, so the reader never sees half of one. */
export type WriteName = 'feedback' | 'assert' | 'answer' | 'adopt' | 'drop' | 'pause' | 'resume' | 'revoke' | 'ingest' | 'verdict';

export function requestWrite(write: WriteName, body: Record<string, unknown>, now = new Date()): void {
  const dir = path.join(getSundialRuntimeDir(), 'mcp-writes');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${now.getTime()}-${randomUUID().slice(0, 8)}.json`;
  const tmp = path.join(dir, `.${name}`);
  fs.writeFileSync(tmp, JSON.stringify({ write, at: now.toISOString(), body }), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, name));
}

const QUEUED = 'Queued for Sundial: it applies this within seconds while it runs, or at its next start.';

/**
 * The rule writes are the owner's own hand: in Gnomon's chat they are owner-turn-only (gate.js),
 * and here they go through only for a session opened with the owner host's token (`sundial mcp
 * --http --owner <name>`, http.ts). Any other host is told how to become one.
 */
export const OWNER_HOST_ONLY = { error: 'owner host only: run sundial mcp --http --owner <name> and use mcp-owner-token' };
const ownerHostOf = (env: ToolEnv): string | null => {
  const name = (env as ToolEnv & { ownerHost?: unknown }).ownerHost;
  return typeof name === 'string' ? name : null;
};

/** `{id}` or `{flow}`, exactly one: the rules a drop (pause, resume) names. */
function target(args: { id?: unknown; flow?: unknown }): { id: string } | { flow: string } | { error: string } {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const flow = typeof args.flow === 'string' ? args.flow.trim() : '';
  if ((id === '') === (flow === '')) return { error: 'Name one rule by id, or one flow by flow id.' };
  return id ? { id } : { flow };
}

export const WRITE_TOOLS: GnomonTool[] = [
  {
    name: 'gnomon_notice_seen',
    description: 'Mark one delivered Gnomon notice as seen by the owner, by its `id` from gnomon_notices. Use it when the owner read the notice with you, or said so.',
    schema: {
      id: z.string().min(6).max(64).describe('The notice id gnomon_notices gave'),
      surface: z.enum(['agent', 'mcp-app']).optional().describe('Where the owner saw it: an agent (default), or Sundial\'s notices page in a host'),
    },
    readOnly: false,
    handler: async (args, env) => {
      const { id, surface = 'agent' } = args as { id: string; surface?: 'agent' | 'mcp-app' };
      const from = new Date(env.now.getTime() - NOTICE_LOOKBACK_MS).toISOString();
      const row = (await getAllSignalsInRange(from, env.now.toISOString(), ['notice:delivered'])).find((r) => r.id === id);
      const key = typeof row?.data.noticeKey === 'string' ? row.data.noticeKey : null;
      if (key === null) return { error: `No notice ${id} delivered in the last 7 days. gnomon_notices lists them.` };
      requestWrite('feedback', { seen: true, artifactKind: 'notice', artifactId: key, surface }, env.now);
      return { queued: true, id, note: QUEUED };
    },
  },
  {
    name: 'gnomon_feedback',
    description:
      "The owner's verdict on something Gnomon produced: `useful`, `wrong` or `not-now`, with an optional note in their words. A `wrong` on a fact retracts it. Only for the owner's own verdict, never yours. artifactKind: notice (artifactId: its notice key), entity_fact, knowledge_entry, moment, ask_thread, owner_ask, routine (artifactId: its key; a `wrong` forgets it).",
    schema: {
      artifactKind: z.enum(['knowledge_entry', 'moment', 'entity_fact', 'ask_thread', 'notice', 'owner_ask', 'routine']),
      artifactId: z.string().min(1).max(300),
      verdict: z.enum(VERDICTS),
      note: z.string().max(500).optional().describe("What the owner said about it, in their words"),
    },
    readOnly: false,
    handler: async (args, env) => {
      requestWrite('feedback', args as Record<string, unknown>, env.now);
      return { queued: true, note: QUEUED };
    },
  },
  {
    name: 'gnomon_assert',
    description:
      "Record a fact the owner stated or corrected in their own words, as their assertion: it supersedes a conflicting belief at once. Never for something you inferred. entityKind: owner (the owner themselves), person (never the owner), project, tool, topic, or goal (predicate status = open|paused|done|dropped, targetDate, why). Prefer the established predicates: usesTool, worksOn, relatesToProject, collaboratesOn, deployedVia. The record's shape gate still decides whether the name is accepted.",
    schema: {
      entityKind: z.enum(ASSERTABLE_ENTITY_KINDS),
      canonicalName: z.string().min(1).max(200),
      predicate: z.string().min(1).max(100),
      object: z.string().min(1).max(1000),
    },
    readOnly: false,
    handler: async (args, env) => {
      requestWrite('assert', args as Record<string, unknown>, env.now);
      return { queued: true, note: QUEUED };
    },
  },
  {
    name: 'gnomon_owner_answer',
    description:
      "Record the owner's answer to the question Gnomon is waiting on (gnomon_open_ask gives its askId and choices). Only the owner's own answer, in their words or one of the choices; never yours. Sundial records it as the same fact a tap on its own page records, and a stale askId is ignored by the rule.",
    schema: {
      askId: z.string().min(1).max(120).describe('The askId gnomon_open_ask gave'),
      answer: z.string().min(1).max(2000).describe("The owner's answer: one of the choices, or their own words"),
    },
    readOnly: false,
    handler: async (args, env) => {
      const { askId, answer } = args as { askId: string; answer: string };
      requestWrite('answer', { askId: askId.trim(), answer: answer.trim() }, env.now);
      return { queued: true, askId, note: QUEUED };
    },
  },
  {
    name: 'gnomon_rule_verdict',
    description:
      "The owner's verdict on one fire of a watch rule: useful or not. Counted toward the rule's precision (what the gate weighs its notices by, once there are five) and kept, the last 50 with their time, so precision can be read over time. Only the owner's own verdict, never yours. `fireId` names the fire as the host knows it (the event it fired on).",
    schema: {
      id: z.string().min(1).max(60).describe('The rule id'),
      fireId: z.string().min(1).max(120).describe('Which fire'),
      useful: z.boolean(),
    },
    readOnly: false,
    handler: async (args, env) => {
      const { id, fireId, useful } = args as { id: string; fireId: string; useful: boolean };
      requestWrite('verdict', { id: id.trim(), fireId: fireId.trim(), useful }, env.now);
      return { queued: true, id, fireId, note: QUEUED };
    },
  },
  {
    name: 'gnomon_ingest',
    description:
      "Append one event from another system — a deploy, a webhook, a Shortcut, an agent — as `ext:<name>`, which watch rules can then watch like any sensor's. Only a type the owner declared in $SUNDIAL_HOME/inlets.json is taken ({\"ext:deploy\": {\"fields\": {\"service\": \"string\", \"ok\": \"boolean\"}}}), and only its declared fields of their declared kind; the rest is dropped and named in the answer. Sanitized at ingest like every sensor row. Never for the owner's own words or for something you inferred.",
    schema: {
      type: z.string().min(5).max(60).describe('ext:<name>, declared in inlets.json'),
      payload: z.record(z.string(), z.unknown()).describe('The event, as declared fields'),
    },
    readOnly: false,
    handler: async (args, env) => {
      const { type, payload } = args as { type: string; payload: unknown };
      const checked = inletPayload(type.trim(), payload, readInlets());
      if ('error' in checked) return checked;
      requestWrite('ingest', { type: type.trim(), payload: checked.payload }, env.now);
      return { queued: true, type: type.trim(), ...(checked.dropped.length ? { dropped: checked.dropped } : {}), note: QUEUED };
    },
  },
  {
    name: 'gnomon_adopt_rule',
    description:
      "Owner host only. Adopt a watch rule the owner said yes to, AFTER gnomon_test_rule showed them what it would have said: it is backtested again over 30 days and validated as Gnomon's own adopt does, then queued for Sundial, which appends `rule:adopted`. `flow: {id, title, step}` adopts it as one step of a flow (rules that hear each other's `emit`). The same id again is the rule's next version.",
    schema: {
      rule: z.any().describe('The same spec that was tested with gnomon_test_rule.'),
      flow: z.object({ id: z.string().min(1).max(40), title: z.string().min(1).max(80), step: z.number().int().min(1) }).optional().describe('The flow this rule is a step of'),
    },
    readOnly: false,
    handler: async (args, env) => {
      const host = ownerHostOf(env);
      if (host === null) return OWNER_HOST_ONLY;
      const { rule, flow: flowIn } = args as { rule: unknown; flow?: unknown };
      const flow = flowIn === undefined ? undefined : flowFrom(flowIn);
      if (flow !== undefined && 'error' in flow) return flow;
      // The test resolves a person to their aliases; what it tested is what is adopted.
      const tested = (await executeGnomonTool('gnomon_test_rule', { rule, days: 30 }, env)) as { valid?: boolean; error?: string; rule?: unknown; fired: number; days: number; gate: { phasic: number; tonic: number } };
      if (!tested?.valid) return { error: tested?.error ?? 'the rule could not be backtested' };
      const checked = validateWatchRule(tested.rule);
      if ('error' in checked) return { error: checked.error };
      const watch = (await env.state())?.watch;
      const full = watchRoomFor(watch, checked.rule.id, flow);
      if (full !== null) return { error: full };
      let predicted: { fired: number; days: number; heard: number } | undefined = { fired: tested.fired, days: tested.days, heard: tested.gate.phasic + tested.gate.tonic };
      const before = flow ? flowBefore(watch, checked.rule.id, flow) : [];
      if (before.length > 0) {
        // A later step hears the earlier ones: its rate is the joint replay's, not its own over a log that holds none of their emits.
        const joint = (await executeGnomonTool('gnomon_test_rule', { rule: [...before, checked.rule], days: 30 }, env)) as { valid?: boolean; error?: string; days: number; steps?: { fired?: number; heard?: number }[] };
        if (!joint?.valid) return { error: joint?.error ?? 'the flow could not be backtested' };
        const step = joint.steps!.at(-1)!;
        predicted = step.fired === undefined ? undefined : { fired: step.fired, days: joint.days, heard: step.heard! };
      }
      requestWrite('adopt', { rule: checked.rule, ...(predicted ? { predicted } : {}), ...(flow ? { flow } : {}), host }, env.now);
      return { queued: true, id: checked.rule.id, predicted, note: QUEUED };
    },
  },
  {
    name: 'gnomon_drop_rule',
    description: 'Owner host only. Stop a watch rule the owner no longer wants, by its `id`, or every step of a flow by its `flow` id (gnomon_test_rule with no rule lists them). Queued for Sundial, which appends `rule:dropped` per rule.',
    schema: {
      id: z.string().max(60).optional().describe('The rule id'),
      flow: z.string().max(60).optional().describe('A flow id: every rule adopted in it'),
    },
    readOnly: false,
    handler: async (args, env) => {
      const host = ownerHostOf(env);
      if (host === null) return OWNER_HOST_ONLY;
      const which = target(args as { id?: unknown; flow?: unknown });
      if ('error' in which) return which;
      requestWrite('drop', { ...which, host }, env.now);
      return { queued: true, ...which, note: QUEUED };
    },
  },
  {
    name: 'gnomon_reach_revoke',
    description: "Owner host only. Take back a rule's leave to run its reach alone (`rule:auto-revoked`): from then it asks before every act again, and its count of yeses starts over. Granting is never a tool: the day-boundary review offers it after five yeses in a row, and the owner's answer grants it.",
    schema: {
      id: z.string().min(1).max(60).describe('The rule id'),
      tool: z.string().min(1).max(100).describe('The reach tool, as the rule names it'),
    },
    readOnly: false,
    handler: async (args, env) => {
      const host = ownerHostOf(env);
      if (host === null) return OWNER_HOST_ONLY;
      const { id, tool } = args as { id: string; tool: string };
      requestWrite('revoke', { id: id.trim(), tool: tool.trim(), host }, env.now);
      return { queued: true, id, tool, note: QUEUED };
    },
  },
  ...(['pause', 'resume'] as const).map(
    (op): GnomonTool => ({
      name: `gnomon_${op}_rule`,
      description: `Owner host only. ${op === 'pause' ? 'Pause' : 'Resume'} a watch rule by its \`id\`, or every step of a flow by its \`flow\` id: ${op === 'pause' ? 'it is kept but not stepped, and says nothing' : 'it is stepped again from a fresh start'}. Queued for Sundial, which appends \`rule:${op}d\` per rule.`,
      schema: {
        id: z.string().max(60).optional().describe('The rule id'),
        flow: z.string().max(60).optional().describe('A flow id: every rule adopted in it'),
      },
      readOnly: false,
      handler: async (args, env) => {
        const host = ownerHostOf(env);
        if (host === null) return OWNER_HOST_ONLY;
        const which = target(args as { id?: unknown; flow?: unknown });
        if ('error' in which) return which;
        requestWrite(op, { ...which, host }, env.now);
        return { queued: true, ...which, note: QUEUED };
      },
    }),
  ),
];
