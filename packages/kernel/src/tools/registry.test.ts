import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ASK_TOOL_REGISTRY, TOOL_REGISTRY, gnomonToolDefinitions } from './index.js';
import { ToolArgumentError, UnknownToolError, executeTool, type GnomonTool } from './registry.js';

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
   * would let a third party act through Gnomon's own credentials — for
   * `gnomon_show_view` specifically, moving the owner's window while they were
   * reading something else. The first write tool did land (2026-08-15); it went
   * into `ASK_TOOL_REGISTRY` instead, and this test is what keeps that split
   * from quietly eroding.
   */
  it('advertises nothing that writes — the shared list is what MCP exposes to other local clients', () => {
    expect(TOOL_REGISTRY.every((tool) => tool.readOnly)).toBe(true);
    expect(TOOL_REGISTRY.map((tool) => tool.name)).not.toContain('gnomon_show_view');
  });

  it("gives /ask the view tool the shared list withholds, and marks it as not a read", () => {
    const showView = ASK_TOOL_REGISTRY.find((tool) => tool.name === 'gnomon_show_view');
    expect(showView).toBeDefined();
    // The flag is the mechanical way the loop and the audit trail tell an
    // action from a query, rather than by parsing the name.
    expect(showView?.readOnly).toBe(false);
    // Everything else /ask can call is still a pure read.
    expect(ASK_TOOL_REGISTRY.filter((tool) => !tool.readOnly).map((tool) => tool.name)).toEqual(['gnomon_show_view']);
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
});
