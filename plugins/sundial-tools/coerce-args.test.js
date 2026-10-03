// The four argument shapes the chat model sent on the demo record, each of
// which dsh rejected, now fit — and a real mistake still reaches dsh as sent.
import { describe, it, expect } from 'vitest';
import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { coerceArgs } from './coerce-args.js';

const tool = defineTool({
  name: 'probe',
  description: 'probe',
  parameters: {
    weeks: { type: 'integer' },
    share: { type: 'number' },
    expandable: { type: 'boolean' },
    queries: { type: 'array', items: { type: 'string' } },
    nested: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer' } } },
    name: { type: 'string' },
  },
  output: { schema: { type: 'json' }, render: () => [] },
  execute: async () => null,
});
const fits = (args) => validateJsonSchemaValue(tool.parameters, args, '').length === 0;

describe('coerceArgs', () => {
  it('turns the strings the model sent into the declared types', () => {
    const args = { weeks: '2', share: '0.5', expandable: 'true', queries: '["a", "b"]', nested: '{"limit": "30"}' };
    expect(fits(args)).toBe(false);
    const fixed = coerceArgs(tool.parameters, args);
    expect(fixed).toEqual({ weeks: 2, share: 0.5, expandable: true, queries: ['a', 'b'], nested: { limit: 30 } });
    expect(fits(fixed)).toBe(true);
  });

  it('returns the same object when nothing needed changing', () => {
    const args = Object.freeze({ weeks: 2, queries: Object.freeze(['a']), name: '7' });
    expect(coerceArgs(tool.parameters, args)).toBe(args);
  });

  it('leaves a string that is not the declared type for dsh to reject', () => {
    const fixed = coerceArgs(tool.parameters, { weeks: 'two', expandable: 'yes', queries: 'a, b', share: '1.2.3' });
    expect(fixed).toEqual({ weeks: 'two', expandable: 'yes', queries: 'a, b', share: '1.2.3' });
    expect(fits(fixed)).toBe(false);
  });

  it('never turns a string property into a number', () => {
    expect(coerceArgs(tool.parameters, { name: '42' })).toEqual({ name: '42' });
  });

  it('copes with no schema and no arguments', () => {
    expect(coerceArgs(undefined, { a: '1' })).toEqual({ a: '1' });
    expect(coerceArgs(tool.parameters, undefined)).toBeUndefined();
  });
});
