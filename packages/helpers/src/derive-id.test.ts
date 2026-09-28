import { describe, it, expect } from 'vitest';
import { deriveId } from './derive-id.js';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('deriveId', () => {
  it('is deterministic: same inputs always produce the same id', () => {
    const a = deriveId('2026-07-18T09:00:00.000Z', 'evt1', 'moment-close');
    const b = deriveId('2026-07-18T09:00:00.000Z', 'evt1', 'moment-close');
    expect(a).toBe(b);
  });

  it('produces a well-formed ULID', () => {
    const id = deriveId('2026-07-18T09:00:00.000Z', 'evt1', 'moment-close');
    expect(id).toMatch(ULID_RE);
  });

  it('differs when parentId differs', () => {
    const a = deriveId('2026-07-18T09:00:00.000Z', 'evt1', 'moment-close');
    const b = deriveId('2026-07-18T09:00:00.000Z', 'evt2', 'moment-close');
    expect(a).not.toBe(b);
  });

  it('differs when discriminator parts differ', () => {
    const a = deriveId('2026-07-18T09:00:00.000Z', 'evt1', 'apply-llm-result', 'entry');
    const b = deriveId('2026-07-18T09:00:00.000Z', 'evt1', 'apply-llm-result', 'embed');
    expect(a).not.toBe(b);
  });

  it('sorts lexically by seedTs, like a real ULID sorts by its timestamp', () => {
    const earlier = deriveId('2026-07-18T09:00:00.000Z', 'evtA', 'r');
    const later = deriveId('2026-07-18T10:00:00.000Z', 'evtA', 'r');
    expect(earlier < later).toBe(true);
  });
});
