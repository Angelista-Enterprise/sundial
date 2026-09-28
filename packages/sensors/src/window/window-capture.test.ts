import { describe, it, expect } from 'vitest';
import { normalizeWindowTitle } from './window-capture.js';

describe('normalizeWindowTitle', () => {
  it('strips a leading spinner glyph and the space after it', () => {
    expect(normalizeWindowTitle('⠐ gnomon-phase-0-2-implementation')).toBe('gnomon-phase-0-2-implementation');
    expect(normalizeWindowTitle('⠂ gnomon-phase-0-2-implementation')).toBe('gnomon-phase-0-2-implementation');
  });

  it('leaves titles with no spinner glyph untouched', () => {
    expect(normalizeWindowTitle('window-capture.ts — gnomon-base')).toBe('window-capture.ts — gnomon-base');
  });

  it('does not strip non-spinner leading characters', () => {
    expect(normalizeWindowTitle('~/Projects/gnomon')).toBe('~/Projects/gnomon');
  });
});
