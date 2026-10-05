import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ASK_TOOL_REGISTRY, TOOL_REGISTRY, gnomonToolDefinitions } from './index.js';
import { ToolArgumentError, UnknownToolError, executeTool, type GnomonTool } from './registry.js';
import type { KernelState } from '../types.js';

describe('the tool registry', () => {
  it('has a unique name per tool', () => {
    const names = TOOL_REGISTRY.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * A snapshot rather than a count, so a rename shows up as a diff in review.
   * The MCP surface and `/ask` both read this list, and a tool silently
   * disappearing from it is the exact drift moving the registry here prevented.
   */
  it('exposes the expected tools, evidence-first', () => {
    expect(TOOL_REGISTRY.map((tool) => tool.name)).toEqual([
      'gnomon_code_activity',
      'gnomon_signals',
      'gnomon_current_context',
      'gnomon_tickets',
      'gnomon_test_rule',
      'gnomon_mine_rules',
      'gnomon_today_summary',
      'gnomon_moment_detail',
      'gnomon_recent_activity',
      'gnomon_project_status',
      'gnomon_open_commitments',
      'gnomon_routines',
      // What the owner's board is doing, and how much of it Gnomon caused.
      // Self-audit: a card placed and swept within a minute is clutter the
      // owner had to clear, and nothing measured that before.
      'gnomon_board_traffic',
      // What Gnomon's own thinking costs, and what its failures cost — the
      // ledger along one axis at a time, so a lens can card any of them.
      'gnomon_llm_ledger',
      // Every coding-agent session in one call, so an audit never reads raw transcripts with the shell (2026-10-05).
      'gnomon_agent_sessions',
      'gnomon_anomalies',
      // The roster, so "who do I work with" is answerable without the owner
      // naming anyone first. Before it, 18 of this record's 39 people were
      // reachable by no tool at all.
      // The owner's own goals: 5 on the live record, each with a real status
      // fact, and reachable by no tool at all before this. The write path
      // (`gnomon_assert` on kind 'goal') has always existed.
      'gnomon_goals',
      'gnomon_people',
      'gnomon_entity_history',
      'gnomon_semantic_search',
      // lane D — #20: a project's handoff, written from the record.
      'gnomon_project_handoff',
      // lane C: weekly trends in how the owner works, and what the agents cost and yielded.
      'gnomon_drift',
      'gnomon_agent_yield',
      // lane B: the standup draft, a meeting's prep and the week, on demand.
      'gnomon_brief',
      // lane A: "did I…?", the flight recorder, and the policy replay.
      'gnomon_did_i',
      'gnomon_timeline',
      'gnomon_what_if',
      // W5 step 9: Gnomon's own scorecard, every row with its n.
      'gnomon_reliability',
      // Last on purpose: a model shown the drawing tool early reaches for it
      // before it has anything to draw. See the ordering note in `index.ts`.
      'gnomon_compose_figure',
    ]);
  });

  /**
   * The SHARED registry stays read-only for good, and this is now a security
   * boundary rather than a description.
   *
   * `TOOL_REGISTRY` is what the MCP server advertises, and MCP runs in the same
   * user session as any other local client. A write tool reaching this list
   * would let a third party act through Gnomon's own credentials — moving the
   * owner's window while they were reading something else, say. This test is
   * what keeps that from quietly eroding.
   */
  it('advertises nothing that writes — the shared list is what MCP exposes to other local clients', () => {
    expect(TOOL_REGISTRY.every((tool) => tool.readOnly)).toBe(true);
    expect(ASK_TOOL_REGISTRY.every((tool) => tool.readOnly)).toBe(true);
  });

  it('derives a JSON Schema object for every tool', () => {
    for (const definition of gnomonToolDefinitions()) {
      expect(definition.parameters).toMatchObject({ type: 'object' });
      expect(definition.description.length).toBeGreaterThan(20);
    }
  });

  /**
   * Optional filters must not land in `required`. With the output-shaped
   * default, `z.toJSONSchema` marks every property required, and a model that
   * is told `projectRoot` is required invents one rather than omitting it —
   * turning "what did I edit today" into a query scoped to a project the owner
   * never named.
   */
  it('leaves optional arguments out of the required list', () => {
    const codeActivity = gnomonToolDefinitions().find((definition) => definition.name === 'gnomon_code_activity');
    expect(codeActivity?.parameters.required ?? []).toEqual([]);
  });

  it('keeps a genuinely required argument required', () => {
    const momentDetail = gnomonToolDefinitions().find((definition) => definition.name === 'gnomon_moment_detail');
    expect(momentDetail?.parameters.required).toEqual(['momentId']);
  });
});

describe('executeTool', () => {
  const stub: GnomonTool[] = [
    {
      name: 'echo',
      description: 'Echoes its argument back, for tests.',
      schema: { value: z.string(), count: z.number().int().optional() },
      readOnly: true,
      handler: async (args) => ({ echoed: args.value, count: args.count ?? 1 }),
    },
  ];

  it('validates and runs', async () => {
    await expect(executeTool(stub, 'echo', { value: 'hi' })).resolves.toEqual({ echoed: 'hi', count: 1 });
  });

  it('accepts missing arguments for a schema with no required fields', async () => {
    const noArgs: GnomonTool[] = [{ name: 'ping', description: 'x'.repeat(30), schema: {}, readOnly: true, handler: async () => 'pong' }];
    await expect(executeTool(noArgs, 'ping', undefined)).resolves.toBe('pong');
  });

  it('throws UnknownToolError for a name that is not registered', async () => {
    await expect(executeTool(stub, 'nope', {})).rejects.toBeInstanceOf(UnknownToolError);
  });

  it("names the offending field in a ToolArgumentError, so the model is told WHICH argument was wrong", async () => {
    await expect(executeTool(stub, 'echo', { value: 42 })).rejects.toThrow(/value:/);
    await expect(executeTool(stub, 'echo', { value: 42 })).rejects.toBeInstanceOf(ToolArgumentError);
  });

  it('lets a handler error propagate rather than swallowing it into a result', async () => {
    const boom: GnomonTool[] = [
      { name: 'boom', description: 'x'.repeat(30), schema: {}, readOnly: true, handler: async () => { throw new Error('the database is on fire'); } },
    ];
    await expect(executeTool(boom, 'boom', {})).rejects.toThrow('the database is on fire');
  });

  // W4 step 5: a tool reads its clock and its state from the call, never the wall or the snapshot itself.
  it('hands the call environment to the handler', async () => {
    const now = new Date('2026-03-04T09:00:00Z');
    const seen: GnomonTool[] = [{ name: 'when', description: 'x'.repeat(30), schema: {}, readOnly: true, handler: async (_args, env) => ({ at: env.now.toISOString(), state: await env.state() }) }];
    const state = { device: { id: 'd' } } as unknown as KernelState;
    await expect(executeTool(seen, 'when', {}, { now, state: async () => state })).resolves.toEqual({ at: '2026-03-04T09:00:00.000Z', state });
  });

  it('gnomon_tickets answers for the call instant and the live state it is given', async () => {
    const tickets = { 'BOX-484': { id: 'BOX-484', days: ['2026-03-03'], lastSeen: '2026-03-03T10:00:00Z', stage: 'seen', sources: {}, commits: 0, pr: null } };
    const state = { tickets } as unknown as KernelState;
    const at = (iso: string) => executeTool(TOOL_REGISTRY, 'gnomon_tickets', { days: 2 }, { now: new Date(iso), state: async () => state }) as Promise<{ count: number }>;
    expect((await at('2026-03-04T09:00:00Z')).count).toBe(1);
    expect((await at('2026-03-09T09:00:00Z')).count).toBe(0);
  });
});
