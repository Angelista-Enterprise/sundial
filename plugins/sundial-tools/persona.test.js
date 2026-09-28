// GNOMON_PERSONA is authored twice on purpose — once in persona.js (built
// from the real ASK_SYSTEM_PROMPT export) and once restated verbatim in
// cordis.patch.yml (a patch row replaces config wholesale and YAML cannot
// import JS). This test pins the two copies together so they cannot drift:
// change one and this fails until the other matches.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASK_SYSTEM_PROMPT } from '@sundial/kernel/tools/ask-prompt.js';
import { GNOMON_PERSONA, HARNESS_NOTE } from './persona.js';
import { renderResultText, MAX_RESULT_BYTES } from './render.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Extract the `persona: |-` literal block from cordis.patch.yml without a
 * YAML dependency: take every line after the marker that is blank or indented
 * by the block's 6 spaces, strip the indent, and chomp the trailing newline
 * (the `|-` strip indicator).
 */
function personaFromPatchYml() {
  const text = fs.readFileSync(path.join(HERE, 'cordis.patch.yml'), 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === '    persona: |-');
  expect(start).toBeGreaterThan(-1);

  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (line.length === 0) {
      block.push('');
      continue;
    }
    if (!line.startsWith('      ')) break;
    block.push(line.slice(6));
  }
  while (block.length > 0 && block[block.length - 1] === '') block.pop();
  return block.join('\n');
}

describe('GNOMON_PERSONA', () => {
  it('is the ported ASK_SYSTEM_PROMPT plus the harness note', () => {
    expect(GNOMON_PERSONA).toBe(`${ASK_SYSTEM_PROMPT}\n\n${HARNESS_NOTE}`);
    expect(GNOMON_PERSONA).toContain('You are Gnomon');
    // The dsh system-prompt placeholders survive verbatim.
    expect(GNOMON_PERSONA).toContain('{{model}}');
    expect(GNOMON_PERSONA).toContain('{{cwd}}');
  });

  it('matches the persona restated in cordis.patch.yml exactly (no drift)', () => {
    expect(personaFromPatchYml()).toBe(GNOMON_PERSONA);
  });
});

describe('renderResultText (the old tool loop text projection)', () => {
  it('passes a small result through as plain JSON', () => {
    expect(renderResultText({ a: 1 })).toBe('{"a":1}');
    expect(renderResultText(undefined)).toBe('null');
  });

  it('truncates an oversized array loudly, keeping valid rows and saying how many were dropped', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ i, pad: 'x'.repeat(100) }));
    const text = renderResultText(rows);
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT_BYTES + 500);
    const parsed = JSON.parse(text);
    expect(parsed.truncated).toBe(true);
    expect(parsed.note).toContain(`of ${rows.length} rows`);
    expect(parsed.rows.length).toBeLessThan(rows.length);
    expect(parsed.rows[0]).toEqual(rows[0]);
  });

  it('reports an oversized non-array as too large with a preview rather than cutting JSON mid-structure', () => {
    const big = { blob: 'y'.repeat(MAX_RESULT_BYTES * 2) };
    const parsed = JSON.parse(renderResultText(big));
    expect(parsed.truncated).toBe(true);
    expect(parsed.note).toContain('narrow your query');
    expect(typeof parsed.preview).toBe('string');
  });
});
