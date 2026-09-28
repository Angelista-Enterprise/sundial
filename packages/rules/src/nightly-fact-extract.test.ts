import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { nightlyFactExtract, parseExtractedFactCandidates, normalizePredicate, MAX_EXTRACTED_FACTS_PER_PASS } from './nightly-fact-extract.js';

function dayBoundary(ts: string): SanitizedEvent {
  return { id: 'e1', type: 'day:boundary', ts, payload: {}, sanitized: true };
}

describe('nightlyFactExtract', () => {
  it('drops a fact about itself', () => {
    // `project:sundial worksOn sundial` sat in the live record and rendered on
    // the entity card above the owner's own asserted facts. The prompt invites
    // it: every topic and tool owes a `relatesToProject` fact naming its
    // project verbatim, so a topic named after its project answers with its
    // own name.
    const got = parseExtractedFactCandidates(JSON.stringify([
      { entityKind: 'project', canonicalName: 'sundial', predicate: 'worksOn', object: 'sundial', confidence: 90 },
      { entityKind: 'topic', canonicalName: 'Gnomon', predicate: 'relatesToProject', object: 'gnomon', confidence: 80 },
      { entityKind: 'person', canonicalName: 'Noah', predicate: 'worksOn', object: 'hub', confidence: 70 },
    ]));
    expect(got.map((c) => `${c.canonicalName} ${c.predicate} ${c.object}`)).toEqual(['Noah worksOn hub']);
  });

  it('emits a RunFactExtraction effect and sets lastFactExtractAt', () => {
    const state = createInitialState('d1');
    const { state: next, effects } = nightlyFactExtract(state, dayBoundary('2026-07-19T00:00:00.000Z'));

    expect(effects).toEqual([{ type: 'RunFactExtraction', since: expect.any(String), ts: '2026-07-19T00:00:00.000Z' }]);
    expect(next.memory.lastFactExtractAt).toBe('2026-07-19T00:00:00.000Z');
  });

  it('falls back to 24h before the event when there is no prior lastFactExtractAt', () => {
    const state = createInitialState('d1');
    const { effects } = nightlyFactExtract(state, dayBoundary('2026-07-19T00:00:00.000Z'));
    expect((effects[0] as { since: string }).since).toBe('2026-07-18T00:00:00.000Z');
  });

  it('uses the prior lastFactExtractAt as `since` when one exists', () => {
    let state = createInitialState('d1');
    state = nightlyFactExtract(state, dayBoundary('2026-07-18T00:00:00.000Z')).state;
    const { effects } = nightlyFactExtract(state, dayBoundary('2026-07-19T00:00:00.000Z'));
    expect((effects[0] as { since: string }).since).toBe('2026-07-18T00:00:00.000Z');
  });

  it('ignores non-day:boundary events', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T00:00:00.000Z', payload: {}, sanitized: true };
    const { state: next, effects } = nightlyFactExtract(state, event);
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});

describe('parseExtractedFactCandidates', () => {
  it('parses a well-formed JSON array of candidates', () => {
    const text = JSON.stringify([
      { entityKind: 'topic', canonicalName: 'gnomon MCP tools', predicate: 'relatesToProject', object: 'gnomon', confidence: 55 },
      { entityKind: 'person', canonicalName: 'Sam', predicate: 'collaboratesOn', object: 'gnomon', confidence: 60 },
    ]);
    expect(parseExtractedFactCandidates(text)).toEqual([
      { entityKind: 'topic', canonicalName: 'gnomon MCP tools', predicate: 'relatesToProject', object: 'gnomon', confidence: 55 },
      { entityKind: 'person', canonicalName: 'Sam', predicate: 'collaboratesOn', object: 'gnomon', confidence: 60 },
    ]);
  });

  it('normalizes synonym predicates onto the controlled vocabulary so the same fact recurs', () => {
    const text = JSON.stringify([
      { entityKind: 'tool', canonicalName: 'vitest', predicate: 'used_for', object: 'gnomon', confidence: 50 },
      { entityKind: 'tool', canonicalName: 'vitest', predicate: 'usedFor', object: 'gnomon', confidence: 50 },
      { entityKind: 'topic', canonicalName: 'reducer', predicate: 'worked_on', object: 'gnomon', confidence: 50 },
    ]);
    const out = parseExtractedFactCandidates(text);
    expect(out.map((c) => c.predicate)).toEqual(['usesTool', 'usesTool', 'worksOn']);
  });

  it('strips markdown code fencing before parsing', () => {
    const text = '```json\n[{"entityKind":"tool","canonicalName":"vitest","predicate":"adoptedFor","object":"gnomon","confidence":50}]\n```';
    expect(parseExtractedFactCandidates(text)).toHaveLength(1);
  });

  it('drops entries with an invalid entityKind, missing fields, or a non-numeric confidence', () => {
    const text = JSON.stringify([
      { entityKind: 'not-a-kind', canonicalName: 'x', predicate: 'p', object: 'o', confidence: 50 },
      { entityKind: 'topic', canonicalName: '', predicate: 'p', object: 'o', confidence: 50 },
      { entityKind: 'topic', canonicalName: 'x', predicate: 'p', object: 'o', confidence: 'high' },
      { entityKind: 'topic', canonicalName: 'valid', predicate: 'p', object: 'o', confidence: 50 },
    ]);
    expect(parseExtractedFactCandidates(text)).toEqual([{ entityKind: 'topic', canonicalName: 'valid', predicate: 'p', object: 'o', confidence: 50 }]);
  });

  it('clamps confidence to [1, 100]', () => {
    const text = JSON.stringify([{ entityKind: 'topic', canonicalName: 'x', predicate: 'p', object: 'o', confidence: 500 }]);
    expect(parseExtractedFactCandidates(text)[0].confidence).toBe(100);
  });

  it('caps the number of candidates at MAX_EXTRACTED_FACTS_PER_PASS', () => {
    const many = Array.from({ length: MAX_EXTRACTED_FACTS_PER_PASS + 5 }, (_, i) => ({ entityKind: 'topic', canonicalName: `t${i}`, predicate: 'p', object: 'o', confidence: 50 }));
    expect(parseExtractedFactCandidates(JSON.stringify(many))).toHaveLength(MAX_EXTRACTED_FACTS_PER_PASS);
  });

  it('returns an empty array for malformed JSON or a non-array response', () => {
    expect(parseExtractedFactCandidates('not json')).toEqual([]);
    expect(parseExtractedFactCandidates('{"not": "an array"}')).toEqual([]);
  });
});

describe('normalizePredicate', () => {
  it('folds known synonyms onto the controlled vocabulary (case/punctuation-insensitive)', () => {
    expect(normalizePredicate('used_for')).toBe('usesTool');
    expect(normalizePredicate('UsedFor')).toBe('usesTool');
    expect(normalizePredicate('primaryTool')).toBe('usesTool');
    expect(normalizePredicate('worked on')).toBe('worksOn');
    expect(normalizePredicate('contributedTo')).toBe('collaboratesOn');
  });

  it('passes an unknown predicate through unchanged (original casing preserved)', () => {
    expect(normalizePredicate('adoptedFor')).toBe('adoptedFor');
    expect(normalizePredicate('reviewed')).toBe('reviewed');
  });
});
