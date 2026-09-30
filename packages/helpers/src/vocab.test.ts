import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ENTITY_KINDS, EXTRACTABLE_ENTITY_KINDS, ASSERTABLE_ENTITY_KINDS, CLAIMABLE_ENTITY_KINDS } from './vocab.js';

describe('vocab', () => {
  it('imports nothing, so the browser can load the compiled file as it is', () => {
    expect(readFileSync(new URL('./vocab.ts', import.meta.url), 'utf8')).not.toMatch(/^\s*import\b/m);
  });

  it('every narrower kind set is inside ENTITY_KINDS, and extraction still leaves out task', () => {
    for (const set of [EXTRACTABLE_ENTITY_KINDS, ASSERTABLE_ENTITY_KINDS, CLAIMABLE_ENTITY_KINDS]) for (const k of set) expect(ENTITY_KINDS).toContain(k);
    expect(EXTRACTABLE_ENTITY_KINDS).not.toContain('task');
    expect([...ASSERTABLE_ENTITY_KINDS].sort()).toEqual([...EXTRACTABLE_ENTITY_KINDS].sort());
  });
});
