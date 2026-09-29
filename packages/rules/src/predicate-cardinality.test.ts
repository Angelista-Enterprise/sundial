import { describe, it, expect } from 'vitest';
import { predicateCardinality } from './predicate-cardinality.js';

describe('predicateCardinality', () => {
  it('classifies explicit functional predicates', () => {
    expect(predicateCardinality('primaryTool')).toBe('functional');
    expect(predicateCardinality('primaryEditor')).toBe('functional');
    expect(predicateCardinality('currentEmployer')).toBe('functional');
  });

  it('classifies explicit set-valued predicates', () => {
    expect(predicateCardinality('collaboratesOn')).toBe('set');
    expect(predicateCardinality('relatesToProject')).toBe('set');
    expect(predicateCardinality('relatesToProject', 'person')).toBe('set');
    // lane Q: a task belongs to one project.
    expect(predicateCardinality('relatesToProject', 'task')).toBe('functional');
    expect(predicateCardinality('deployedVia')).toBe('set');
    expect(predicateCardinality('usesTool')).toBe('set');
  });

  it('owner-profile attributes hold one value, so a correction in chat replaces rather than adds', () => {
    // The live failure: both "~06:00" and "~22:00" stayed current for asleepBy.
    expect(predicateCardinality('asleepBy')).toBe('functional');
    expect(predicateCardinality('dayBeginsAt')).toBe('functional');
    expect(predicateCardinality('wakeAt')).toBe('functional');
    expect(predicateCardinality('occupation')).toBe('functional');
    expect(predicateCardinality('stayingAt')).toBe('functional');
  });

  it('heuristic: primary/current/main prefixes are functional', () => {
    expect(predicateCardinality('primaryLanguage')).toBe('functional');
    expect(predicateCardinality('currentFocus')).toBe('functional');
    expect(predicateCardinality('mainRepo')).toBe('functional');
  });

  it('heuristic: everything else (the common case for human knowledge) is set-valued', () => {
    expect(predicateCardinality('worksOn')).toBe('set');
    expect(predicateCardinality('knows')).toBe('set');
    expect(predicateCardinality('somethingLlmMadeUp')).toBe('set');
  });
});

describe("a goal's own predicates", () => {
  it('treats a checklist as one value, so an edit replaces the plan instead of joining it', () => {
    // `steps` holds the WHOLE list in one object and the goals card rewrites it
    // on every tick. Set-valued — the default this predicate would otherwise
    // fall through to — would file each edit as an additional fact and leave
    // five versions of the same plan all current at once, which is exactly the
    // bug `asleepBy` hit before it was listed here.
    expect(predicateCardinality('steps')).toBe('functional');
  });

  it('lets a goal have one parent', () => {
    expect(predicateCardinality('partOf')).toBe('functional');
  });
});
