// Which tools reach the prompt, and the two properties the deferral must keep:
// the registered set never changes shape, and nothing gated slips through the
// dispatcher.
import { describe, it, expect, vi } from 'vitest';
import { ASK_TOOL_REGISTRY } from '@sundial/kernel/tools/index.js';
import { toolDefinitions } from '@sundial/kernel/tools/registry.js';
import { GNOMON_TOOLS as GATED_TOOLS } from '../sundial-actions/gate.js';
import { deferredToolsContext, DISCOVER_TOOL_NAME, DISPATCH_TOOL_NAME, HOT_TOOL_NAMES, layerTools, oneLine, splitByHeat } from './layers.js';

// dsh's REAL defineTool, not a stand-in. A fake one passed these tests while
// the harness refused to boot: dsh's schema compiler rejects
// `required: false` on an optional parameter (the key must be omitted), and
// only the real compiler says so.
import { defineTool } from '@deepseek-ai/dsh-tools';

function build(tools = ASK_TOOL_REGISTRY) {
  const { hot, cold } = splitByHeat(tools);
  const definitionsByName = new Map(
    tools.map((tool) => [tool.name, { name: tool.name, execute: vi.fn(async (args, exec) => ({ ran: tool.name, args, sawSession: exec?.agent?.id ?? null })) }]),
  );
  return { hot, cold, definitionsByName, ...layerTools({ coldTools: cold, definitionsByName, defineTool, toolDefinitions }) };
}

describe('splitByHeat', () => {
  it('keeps the measured-hot tools in the prompt and defers the rest', () => {
    const { hot, cold } = build();
    expect(hot.map((t) => t.name).sort()).toEqual([...HOT_TOOL_NAMES].sort());
    expect(cold.length).toBeGreaterThan(0);
    expect(hot.length + cold.length).toBe(ASK_TOOL_REGISTRY.length);
  });

  it('loses no tool — every one is either shown or reachable', () => {
    const { hot, cold } = build();
    const seen = new Set([...hot, ...cold].map((t) => t.name));
    for (const tool of ASK_TOOL_REGISTRY) expect(seen.has(tool.name)).toBe(true);
  });

  it('ignores a hot name that no longer exists, rather than failing to boot', () => {
    const { hot } = splitByHeat(ASK_TOOL_REGISTRY, ['gnomon_signals', 'gnomon_renamed_away']);
    expect(hot.map((t) => t.name)).toEqual(['gnomon_signals']);
  });
});

describe('the saving, measured the way it will actually be paid', () => {
  it('sends less schema than before, counting the name list it adds back', () => {
    const { hot, cold, discover, dispatch } = build();
    const before = JSON.stringify(toolDefinitions(ASK_TOOL_REGISTRY)).length;
    const after = JSON.stringify(toolDefinitions(hot)).length + deferredToolsContext(cold).text().length + JSON.stringify([discover, dispatch]).length;
    expect(after).toBeLessThan(before);
  });
});

describe('the deferred-tools note', () => {
  it('names every deferred tool, so the model cannot forget one exists', () => {
    const { cold } = build();
    const text = deferredToolsContext(cold).text();
    for (const tool of cold) expect(text).toContain(tool.name);
  });

  it('says how to reach them', () => {
    const { cold } = build();
    const text = deferredToolsContext(cold).text();
    expect(text).toContain(DISPATCH_TOOL_NAME);
    expect(text).toContain(DISCOVER_TOOL_NAME);
  });

  it('is a summary, not a second copy of every schema', () => {
    const { cold } = build();
    expect(deferredToolsContext(cold).text().length).toBeLessThan(JSON.stringify(toolDefinitions(cold)).length / 2);
  });
});

describe('oneLine', () => {
  it('takes the first sentence', () => {
    expect(oneLine('Does a thing. Then explains at length about other things.')).toBe('Does a thing.');
  });

  it('cuts a long first sentence rather than letting it run', () => {
    const out = oneLine(`${'x'.repeat(400)}. tail`, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith('…')).toBe(true);
  });

  it('survives a missing description', () => {
    expect(oneLine(undefined)).toBe('');
  });
});

describe('gnomon_tools (discovery)', () => {
  it('lists every deferred tool when asked for no particular one', async () => {
    const { cold, discover } = build();
    const out = await discover.execute({});
    expect(out.tools).toHaveLength(cold.length);
    expect(out.tools[0]).toHaveProperty('summary');
  });

  it('returns a real schema for a named tool', async () => {
    const { discover } = build();
    const out = await discover.execute({ name: 'gnomon_llm_ledger' });
    expect(out.name).toBe('gnomon_llm_ledger');
    expect(out.parameters).toBeDefined();
    expect(JSON.stringify(out.parameters)).toContain('groupBy');
  });

  it('returns plain JSON for every deferred tool — dsh rejects anything else as "not lossless JSON"', async () => {
    const { cold, discover } = build();
    for (const tool of cold) {
      const { parameters } = await discover.execute({ name: tool.name });
      // zod hangs a hidden `~standard` property (functions inside) on the
      // schema; dsh refuses any object with a non-enumerable own property.
      expect(Reflect.ownKeys(parameters), tool.name).toEqual(Object.keys(parameters));
    }
  });

  it('answers a wrong name with the list rather than an error the model must recover from', async () => {
    const { discover } = build();
    const out = await discover.execute({ name: 'gnomon_not_a_tool' });
    expect(out.available).toContain('gnomon_llm_ledger');
  });
});

describe('gnomon_call (dispatch)', () => {
  it('runs the real definition, so validation and the handles still apply', async () => {
    const { dispatch, definitionsByName } = build();
    const out = await dispatch.execute({ name: 'gnomon_llm_ledger', args: { days: 3 } }, { agent: { id: 'sess' } });
    expect(out.ran).toBe('gnomon_llm_ledger');
    expect(out.args).toEqual({ days: 3 });
    expect(definitionsByName.get('gnomon_llm_ledger').execute).toHaveBeenCalledTimes(1);
  });

  it('passes the execution context through, so per-session state keeps working', async () => {
    const { dispatch } = build();
    const out = await dispatch.execute({ name: 'gnomon_people', args: {} }, { agent: { id: 'sess-9' } });
    expect(out.sawSession).toBe('sess-9');
  });

  it('defaults missing args to an empty object', async () => {
    const { dispatch } = build();
    const out = await dispatch.execute({ name: 'gnomon_people' }, undefined);
    expect(out.args).toEqual({});
  });

  it('refuses an unknown name and says what is available', async () => {
    const { dispatch } = build();
    const out = await dispatch.execute({ name: 'rm_rf' }, undefined);
    expect(out.error).toContain('rm_rf');
    expect(Array.isArray(out.available)).toBe(true);
  });

  /**
   * The safety property. `sundial-actions` gates its write tools BY NAME at the
   * tools seam. A dispatcher that could invoke one of those by name would be a
   * hole straight through the permission gate, so the deferred set must never
   * contain a gated tool — today it cannot, because the gated tools live in a
   * different registry, and this test is what keeps that true.
   */
  it('cannot reach a permission-gated action tool', async () => {
    const { cold, definitionsByName, dispatch } = build();
    for (const gated of Object.keys(GATED_TOOLS)) {
      expect(cold.map((t) => t.name)).not.toContain(gated);
      expect(definitionsByName.has(gated)).toBe(false);
      const out = await dispatch.execute({ name: gated, args: {} }, undefined);
      expect(out.error).toBeDefined();
    }
  });

  it('is never dispatched in parallel: one flag covers whatever comes through the door', () => {
    const { dispatch } = build();
    expect(dispatch.isConcurrencySafe()).toBe(false);
  });
});
