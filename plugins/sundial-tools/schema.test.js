// The converter, proven against ALL 13 real gnomon tool schemas — every spec
// must be a valid dsh ParameterSchemaSpec (compiles, and the compiled JSON
// Schema passes dsh's own subset assertion), with the drops (numeric/string
// bounds) folded into descriptions rather than lost.
import { describe, it, expect } from 'vitest';
import {
  assertSupportedJsonSchema,
  parameterSchemaSpecToJsonSchema,
  validateArgs,
} from '@deepseek-ai/dsh-tools';
import { ASK_TOOL_REGISTRY } from '@sundial/kernel/tools/index.js';
import { toolDefinitions } from '@sundial/kernel/tools/registry.js';
import { toParameterSchemaSpec, toValueSchemaSpec } from './schema.js';
import { toDshTool } from './to-dsh-tool.js';

/** name → { spec, wire } for every tool, converted once. */
function convertAll() {
  const out = new Map();
  for (const tool of ASK_TOOL_REGISTRY) {
    const [definition] = toolDefinitions([tool]);
    out.set(tool.name, { wire: definition.parameters, spec: toParameterSchemaSpec(definition.parameters) });
  }
  return out;
}

describe('toParameterSchemaSpec over all 29 real tool schemas', () => {
  const converted = convertAll();

  it('covers the full ASK_TOOL_REGISTRY (the 29 shared tools; lane D added gnomon_project_handoff, lane C gnomon_drift and gnomon_agent_yield, lane B gnomon_brief, lane A gnomon_did_i, gnomon_timeline and gnomon_what_if, W5 gnomon_reliability, and gnomon_agent_sessions)', () => {
    expect(converted.size).toBe(29);
    expect([...converted.keys()]).toContain('gnomon_routines');
  });

  it('every converted spec compiles to a dsh-supported JSON schema', () => {
    for (const [name, { spec }] of converted) {
      // parameterSchemaSpecToJsonSchema throws on an invalid spec; the
      // assertion proves the projection stays inside dsh's enforced subset.
      const compiled = parameterSchemaSpecToJsonSchema(spec);
      expect(() => assertSupportedJsonSchema(compiled), name).not.toThrow();
      expect(compiled.type, name).toBe('object');
    }
  });

  it('preserves requiredness per property (compiled required matches the zod wire schema)', () => {
    for (const [name, { wire, spec }] of converted) {
      const compiled = parameterSchemaSpecToJsonSchema(spec);
      const expected = [...(wire.required ?? [])].sort();
      const actual = [...(compiled.required ?? [])].sort();
      expect(actual, name).toEqual(expected);
    }
  });

  it('preserves every property (none dropped in conversion)', () => {
    for (const [name, { wire, spec }] of converted) {
      expect(Object.keys(spec).sort(), name).toEqual(Object.keys(wire.properties ?? {}).sort());
    }
  });

  it('folds numeric bounds into the description instead of dropping them (gnomon_signals.limit)', () => {
    const { spec } = converted.get('gnomon_signals');
    expect(spec.limit.type).toBe('integer');
    expect(spec.limit.maximum).toBeUndefined();
    expect(spec.limit.exclusiveMinimum).toBeUndefined();
    expect(spec.limit.description).toContain('> 0');
    expect(spec.limit.description).toContain('<= 200');
    // The original zod .describe() text survives in front of the folded bounds.
    expect(spec.limit.description).toContain('Max rows for THIS page');
  });

  it('carries the offset param through, so the paging contract reaches the model', () => {
    // A `nextOffset` in a result is useless if the schema the model reads has
    // nowhere to put it. This pins the two halves together.
    const { spec } = converted.get('gnomon_signals');
    expect(spec.offset.type).toBe('integer');
    expect(spec.offset.description).toContain('nextOffset');
  });

  it('folds string bounds into the description (no real tool has one today)', () => {
    const spec = toParameterSchemaSpec({ type: 'object', properties: { because: { type: 'string', maxLength: 80, description: 'why' } } });
    expect(spec.because.maxLength).toBeUndefined();
    expect(spec.because.description).toContain('max length 80');
  });

  it('preserves enums verbatim (gnomon_compose_figure.kind)', () => {
    expect(converted.get('gnomon_compose_figure').spec.kind.enum).toEqual([
      'dial-slice',
      'trend-slice',
      'graph-neighborhood',
      'fact-chain',
      'commitment-thread',
      'census',
    ]);
  });

  it('an empty-schema tool (gnomon_current_context) converts to an empty parameter map', () => {
    expect(converted.get('gnomon_current_context').spec).toEqual({});
  });

  it('validateArgs accepts valid args and rejects missing/mistyped ones', () => {
    const momentDetail = converted.get('gnomon_moment_detail').spec;
    expect(validateArgs(momentDetail, { momentId: 'm1' })).toEqual([]);
    expect(validateArgs(momentDetail, {})).not.toEqual([]);

    const signals = converted.get('gnomon_signals').spec;
    expect(validateArgs(signals, {})).toEqual([]); // everything optional
    expect(validateArgs(signals, { limit: 'ten' })).not.toEqual([]);
    expect(validateArgs(signals, { limit: 2.5 })).not.toEqual([]); // integer, not number

    const figure = converted.get('gnomon_compose_figure').spec;
    expect(validateArgs(figure, { kind: 'census' })).toEqual([]);
    expect(validateArgs(figure, { kind: 'pie-chart' })).not.toEqual([]);
  });
});

describe('toValueSchemaSpec edge cases (shapes the live registry does not exercise)', () => {
  it('gives a nested object an EXPLICIT additionalProperties (dsh requires stated openness)', () => {
    const spec = toValueSchemaSpec({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    });
    expect(spec.additionalProperties).toBe(false);
    expect(spec.properties.a.required).toBe(true);
    // openness is preserved when the source said open
    expect(toValueSchemaSpec({ type: 'object', additionalProperties: true }).additionalProperties).toBe(true);
  });

  it('maps zod anyOf unions to dsh oneOf, collapsing a 1-branch union', () => {
    const union = toValueSchemaSpec({ anyOf: [{ type: 'string' }, { type: 'number' }] });
    expect(union.oneOf).toEqual([{ type: 'string' }, { type: 'number' }]);
    expect(toValueSchemaSpec({ anyOf: [{ type: 'string' }] })).toEqual({ type: 'string' });
  });

  it('converts arrays with and without items', () => {
    expect(toValueSchemaSpec({ type: 'array', items: { type: 'string', maxLength: 3 } })).toEqual({
      type: 'array',
      items: { type: 'string', description: '(max length 3)' },
    });
    expect(toValueSchemaSpec({ type: 'array' })).toEqual({ type: 'array' });
  });

  it('turns an annotation-only or unknown-typed node into unconstrained json', () => {
    expect(toValueSchemaSpec({ description: 'anything' })).toEqual({ type: 'json', description: 'anything' });
    expect(toValueSchemaSpec(undefined)).toEqual({ type: 'json' });
  });
});

describe('toDshTool definitions', () => {
  // Minimal VALID args per tool — defineTool's isConcurrencySafe wrapper
  // returns false outright for args that fail validation, so the readOnly
  // check below needs args that pass.
  const VALID_ARGS = {
    gnomon_moment_detail: { momentId: 'm1' },
    gnomon_project_status: { projectId: '/tmp/p' },
    gnomon_entity_history: { name: 'x' },
    gnomon_semantic_search: { query: 'q' },
    gnomon_compose_figure: { kind: 'census' },
    // lane D
    gnomon_project_handoff: { project: 'puzzlebox-studio' },
    // lane B
    gnomon_brief: { kind: 'standup' },
    // lane A
    gnomon_did_i: { what: 'reply to Mira' },
  };

  it('produces registry-ready definitions for all 13 (name, description, supported parameters, json output)', () => {
    for (const tool of ASK_TOOL_REGISTRY) {
      const definition = toDshTool(tool);
      expect(definition.name).toBe(tool.name);
      expect(definition.description).toBe(tool.description);
      expect(() => assertSupportedJsonSchema(definition.parameters)).not.toThrow();
      expect(() => assertSupportedJsonSchema(definition.output.schema)).not.toThrow();
      // readOnly → parallel-safe; the one write tool must not join a parallel group.
      expect(definition.isConcurrencySafe(VALID_ARGS[tool.name] ?? {}), tool.name).toBe(tool.readOnly);
    }
  });

  it('rejects invalid args before the gnomon handler runs (dsh-side validation)', async () => {
    const momentDetail = toDshTool(ASK_TOOL_REGISTRY.find((tool) => tool.name === 'gnomon_moment_detail'));
    await expect(momentDetail.execute({}, undefined)).rejects.toThrow();
  });
});
