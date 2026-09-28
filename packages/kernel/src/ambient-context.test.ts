import { describe, it, expect } from 'vitest';
import { composeAmbientContext, selectOwnerFacts, type AmbientInput } from './ambient-context.js';

const NOW = '2026-09-04T10:00:00.000Z';

function empty(): AmbientInput {
  return {
    now: NOW,
    ownerFacts: [],
    goals: [],
    today: null,
    commitments: [],
    wakeups: [],
    ownerAsk: null,
    researchGoal: null,
    recentKnowledge: [],
    assistant: null,
  };
}

describe('composeAmbientContext', () => {
  it('says nothing when there is nothing to say — dsh drops an empty context', () => {
    expect(composeAmbientContext(empty())).toBe('');
  });

  it('states owner facts with their provenance, the owner\'s word marked as such', () => {
    const text = composeAmbientContext({
      ...empty(),
      ownerFacts: [
        { predicate: 'wakeAt', object: '06:30', provenance: 'assertion', validFrom: '2026-08-20T00:00:00Z' },
        { predicate: 'usesTool', object: 'Cursor', provenance: 'inference', validFrom: '2026-08-21T00:00:00Z' },
      ],
    });
    expect(text).toContain('wakeAt: 06:30 (the owner said so)');
    expect(text).toContain('usesTool: Cursor (inferred)');
    expect(text).toContain('do not recite it back');
  });

  it('shows the newest value when a predicate carries two current rows', () => {
    const facts = selectOwnerFacts([
      { predicate: 'dayBeginsAt', object: '~20:00', provenance: 'assertion', validFrom: '2026-08-10T00:00:00Z' },
      { predicate: 'dayBeginsAt', object: '~08:00', provenance: 'assertion', validFrom: '2026-08-18T00:00:00Z' },
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0].object).toBe('~08:00');
  });

  it('flags a fact that names a day more than a week back, and keeps a fresh one clean', () => {
    const text = composeAmbientContext({
      ...empty(),
      ownerFacts: [
        { predicate: 'stayingAt', object: 'Elite Hotel, Stockholm (2026-08-18)', provenance: 'assertion', validFrom: '2026-08-18T00:00:00Z' },
        { predicate: 'visitingToday', object: 'the office (2026-09-04)', provenance: 'assertion', validFrom: '2026-09-04T00:00:00Z' },
      ],
    });
    expect(text).toContain('Stockholm (2026-08-18) (the owner said so; dated 2026-08-18, 17 days ago — probably no longer true)');
    expect(text).toContain('the office (2026-09-04) (the owner said so)');
  });

  it('says a repeated reflection title once', () => {
    const text = composeAmbientContext({
      ...empty(),
      recentKnowledge: [
        { kind: 'reflection', title: 'Claude-heavy afternoon' },
        { kind: 'reflection', title: 'Claude-heavy afternoon' },
        { kind: 'daily', title: 'A quiet Friday' },
      ],
    });
    expect(text.match(/Claude-heavy afternoon/g)).toHaveLength(1);
    expect(text).toContain('A quiet Friday');
  });

  it('lists the owner\'s goals with their facts', () => {
    const text = composeAmbientContext({ ...empty(), goals: [{ name: 'ship gnomon v1', facts: [{ predicate: 'status', object: 'open' }, { predicate: 'targetDate', object: '2026-10-01' }] }] });
    expect(text).toContain("The owner's goals");
    expect(text).toContain('- ship gnomon v1: status open, targetDate 2026-10-01');
  });

  it('caps owner facts, newest first', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      predicate: `p${i}`,
      object: `o${i}`,
      provenance: 'inference',
      validFrom: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z`,
    }));
    const picked = selectOwnerFacts(many);
    expect(picked).toHaveLength(15);
    expect(picked[0].validFrom >= picked[picked.length - 1].validFrom).toBe(true);
  });

  it('lists the most recently touched commitments with how quiet they have gone', () => {
    const text = composeAmbientContext({
      ...empty(),
      commitments: [
        { name: 'old-thread', projectName: 'gnomon', activeDays: 2, lastTouchedAt: '2026-08-25T10:00:00Z' },
        { name: 'BOX-508', projectName: null, activeDays: 1, lastTouchedAt: '2026-09-04T08:00:00Z' },
      ],
    });
    const oldIndex = text.indexOf('old-thread');
    const newIndex = text.indexOf('BOX-508');
    expect(newIndex).toBeGreaterThan(-1);
    expect(newIndex).toBeLessThan(oldIndex);
    expect(text).toContain('BOX-508: 1 active day, touched today');
    expect(text).toContain('old-thread in gnomon: 2 active days, last touched 10 days ago');
  });

  it('carries the open question, the wake-ups, the research goal and recent reflections', () => {
    const text = composeAmbientContext({
      ...empty(),
      wakeups: [
        { at: '2026-09-05T09:00:00Z', reason: 'standup prep' },
        { at: '2026-09-04T17:00:00Z', reason: 'check the deploy' },
      ],
      ownerAsk: { question: 'Which project is the "overture" branch for?' },
      researchGoal: { question: 'Does the weekend change when the day ends?' },
      recentKnowledge: [{ kind: 'daily', title: 'A day split between two projects' }],
    });
    // Soonest wake-up first.
    expect(text.indexOf('check the deploy')).toBeLessThan(text.indexOf('standup prep'));
    expect(text).toContain('waiting on the owner\'s answer to: "Which project');
    expect(text).toContain('gnomon_owner_answer');
    expect(text).toContain('Does the weekend change when the day ends?');
    expect(text).toContain('[daily] A day split between two projects');
  });

  it('states the track record only past ten resolutions, like buildContext', () => {
    const quiet = composeAmbientContext({ ...empty(), assistant: { acceptedCount: 4, rejectedCount: 1 } });
    expect(quiet).toBe('');
    const loud = composeAmbientContext({ ...empty(), assistant: { acceptedCount: 8, rejectedCount: 4 } });
    expect(loud).toContain('8 of 12 proposals accepted (67%)');
  });
});
