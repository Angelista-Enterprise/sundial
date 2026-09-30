// Which tools reach the prompt, and the two properties the deferral must keep:
// the registered set never changes shape, and nothing gated slips through the
// dispatcher (it re-enters dsh's pipeline under the inner tool's own name).
import { describe, it, expect, vi } from 'vitest';
import { ASK_TOOL_REGISTRY } from '@sundial/kernel/tools/index.js';
import { toolDefinitions } from '@sundial/kernel/tools/registry.js';
import { DISCOVER_TOOL_NAME, DISPATCH_TOOL_NAME, HOT_TOOL_NAMES, MENU_CONTEXT_NAME, hideColdTools, layerTools, menuOf, menuText, oneLine, splitByHeat } from './layers.js';

// dsh's REAL defineTool, not a stand-in. A fake one passed these tests while
// the harness refused to boot: dsh's schema compiler rejects
// `required: false` on an optional parameter (the key must be omitted), and
// only the real compiler says so.
import { defineTool } from '@deepseek-ai/dsh-tools';

// What dsh's registry would hand back: the read tools, an action tool, a dsh built-in, the two fixed entries.
const SCHEMAS = [
  ...toolDefinitions(ASK_TOOL_REGISTRY),
  { name: 'gnomon_draft', description: 'Write a draft for the owner to send. It never sends.', parameters: { type: 'object', properties: {} } },
  { name: 'todo_write', description: 'Write the plan.', parameters: { type: 'object', properties: {} } },
  { name: DISCOVER_TOOL_NAME, description: 'discover', parameters: {} },
  { name: DISPATCH_TOOL_NAME, description: 'dispatch', parameters: {} },
];

function build(result = { isError: false, value: { ok: true } }) {
  const tools = { schemas: vi.fn(() => SCHEMAS), execute: vi.fn(async () => result) };
  return { tools, ...layerTools({ tools, defineTool }) };
}

const exec = { callId: 'call-1', rootCallId: 'call-1', agent: { id: 'gnomon-companion' }, token: 'tok', signal: new AbortController().signal };

describe('splitByHeat', () => {
  it('shows the hot tools and the two fixed entries, defers the rest', () => {
    const { hot, cold } = splitByHeat(SCHEMAS);
    expect(hot.map((t) => t.name)).toEqual(expect.arrayContaining(['todo_write', DISCOVER_TOOL_NAME, DISPATCH_TOOL_NAME]));
    for (const t of hot) expect(HOT_TOOL_NAMES.includes(t.name) || t.name === DISCOVER_TOOL_NAME || t.name === DISPATCH_TOOL_NAME).toBe(true);
    expect(cold.map((t) => t.name)).toContain('gnomon_draft');
    expect(hot.length + cold.length).toBe(SCHEMAS.length);
  });

  it('ignores a hot name that is not registered, rather than failing to boot', () => {
    const { hot } = splitByHeat(SCHEMAS, ['gnomon_signals', 'gnomon_no_longer_exists']);
    expect(hot.map((t) => t.name)).toEqual(['gnomon_signals', DISCOVER_TOOL_NAME, DISPATCH_TOOL_NAME]);
  });
});

describe('the menu', () => {
  it('names every deferred tool, so the model cannot forget one exists', () => {
    const { cold } = splitByHeat(SCHEMAS);
    const text = menuText(cold);
    for (const tool of cold) expect(text).toContain(tool.name);
    expect(text).toContain(DISCOVER_TOOL_NAME);
    expect(text).toContain(DISPATCH_TOOL_NAME);
  });

  it('groups by purpose, and a tool nobody filed lands in More', () => {
    const groups = menuOf([{ name: 'gnomon_draft', description: 'x' }, { name: 'gnomon_brand_new', description: 'y' }]);
    expect(groups.map((g) => g.group)).toEqual(['Act for the owner (needs their yes)', 'More']);
  });

  it('is a menu, not a second copy of every schema', () => {
    const { cold } = splitByHeat(SCHEMAS);
    expect(menuText(cold).length).toBeLessThan(JSON.stringify(cold).length / 10);
  });
});

describe('hideColdTools', () => {
  async function assemble(assembly) {
    let listener;
    hideColdTools({ on: (event, fn) => { expect(event).toBe('system-prompt/assemble'); listener = fn; return () => {}; } });
    return listener(null, {}, async () => assembly);
  }

  it('sends only the hot tools, and puts the menu in their place', async () => {
    const out = await assemble({ tools: SCHEMAS, contexts: [{ name: 'clock', text: 'now' }, { name: 'sandbox:policy', text: 'file policy' }], sections: [] });
    expect(out.tools.map((t) => t.name)).not.toContain('gnomon_draft');
    expect(out.tools.map((t) => t.name)).toContain(DISPATCH_TOOL_NAME);
    expect(out.contexts.map((c) => c.name)).toEqual(['clock', MENU_CONTEXT_NAME]);
    expect(out.contexts[1].text).toContain('gnomon_draft');
  });

  it('adds the menu once, however often the prompt is assembled', async () => {
    const once = await assemble({ tools: SCHEMAS, contexts: [], sections: [] });
    const twice = await assemble({ ...once, tools: SCHEMAS });
    expect(twice.contexts.filter((c) => c.name === MENU_CONTEXT_NAME)).toHaveLength(1);
  });

  it('leaves an assembly with nothing to hide alone', async () => {
    const assembly = { tools: [SCHEMAS.find((t) => t.name === 'todo_write')], contexts: [] };
    expect(await assemble(assembly)).toBe(assembly);
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
  it('returns the grouped menu when asked for no particular tool', async () => {
    const { discover } = build();
    const out = await discover.execute({}, exec);
    expect(out.menu.flatMap((g) => g.tools.map((t) => t.name))).toContain('gnomon_draft');
  });

  it('returns a real schema for a named tool — an action tool as well as a read tool', async () => {
    const { discover } = build();
    const ledger = await discover.execute({ name: 'gnomon_llm_ledger' }, exec);
    expect(JSON.stringify(ledger.parameters)).toContain('groupBy');
    expect((await discover.execute({ name: 'gnomon_draft' }, exec)).name).toBe('gnomon_draft');
  });

  it('returns plain JSON for every deferred tool — dsh rejects anything else as "not lossless JSON"', async () => {
    const { discover } = build();
    for (const tool of splitByHeat(SCHEMAS).cold) {
      const { parameters } = await discover.execute({ name: tool.name }, exec);
      expect(Reflect.ownKeys(parameters), tool.name).toEqual(Object.keys(parameters));
    }
  });

  it('answers a wrong name with the list rather than an error the model must recover from', async () => {
    const { discover } = build();
    const out = await discover.execute({ name: 'gnomon_not_a_tool' }, exec);
    expect(out.available).toContain('gnomon_llm_ledger');
  });
});

describe('gnomon_call (dispatch)', () => {
  it("re-enters dsh's pipeline under the inner tool's own name, so the gate judges the real tool", async () => {
    const { tools, dispatch } = build();
    await dispatch.execute({ name: 'gnomon_draft', args: { to: 'Mira' } }, exec);
    expect(tools.execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'gnomon_draft', arguments: { to: 'Mira' }, agent: exec.agent, rootCallId: 'call-1', parent: 'tok', signal: exec.signal }));
  });

  it('returns what the tool returned', async () => {
    const { dispatch } = build({ isError: false, value: { rows: 3 } });
    expect(await dispatch.execute({ name: 'gnomon_llm_ledger' }, exec)).toEqual({ rows: 3 });
  });

  it('turns a failed or refused call into an error the model can read', async () => {
    const { dispatch } = build({ isError: true, error: { code: 'DENIED', message: 'The owner said no.' } });
    expect(await dispatch.execute({ name: 'gnomon_draft' }, exec)).toEqual({ error: 'The owner said no.' });
  });

  it('defaults missing args to an empty object', async () => {
    const { tools, dispatch } = build();
    await dispatch.execute({ name: 'gnomon_llm_ledger' }, exec);
    expect(tools.execute.mock.calls[0][0].arguments).toEqual({});
  });

  it('refuses an unknown name and itself, and says what is available', async () => {
    const { tools, dispatch } = build();
    expect((await dispatch.execute({ name: 'gnomon_not_a_tool' }, exec)).available).toContain('gnomon_draft');
    expect((await dispatch.execute({ name: DISPATCH_TOOL_NAME }, exec)).error).toMatch(/directly/);
    expect(tools.execute).not.toHaveBeenCalled();
  });
});
