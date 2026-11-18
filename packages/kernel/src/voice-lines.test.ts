import { describe, expect, it } from 'vitest';
import { isEcho, pickLine, recoveryLine, refusalLine } from './voice-lines.js';

describe('voice lines (plan 15 step 3)', () => {
  it('picks the tool its own line, never one said lately', () => {
    expect(pickLine('gnomon_today_summary')).toBe('Let me look at the day.');
    expect(pickLine('gnomon_today_summary', ['Let me look at the day.'])).toBe('One moment, reading today.');
    expect(pickLine('some_other_tool', ['One moment.'])).toBe('Let me check.');
  });

  it('hearing its own reply inside a minute is an echo; other words, or later, are not', () => {
    const said = [{ text: 'Your next meeting is the Jonas Vermeer interview at three.', at: '2026-11-12T14:00:00.000Z' }];
    expect(isEcho('your next meeting is the Jonas Vermeer interview', said, '2026-11-12T14:00:05.000Z')).toBe(true);
    expect(isEcho('can you move the interview to four', said, '2026-11-12T14:00:05.000Z')).toBe(false);
    expect(isEcho('your next meeting is the Jonas Vermeer interview', said, '2026-11-12T14:02:00.000Z')).toBe(false);
    expect(isEcho('', said, '2026-11-12T14:00:05.000Z')).toBe(false);
  });

  it('Set 2 R1 item 5: a refused step said with the next step, one line from both; silent for a refusal not to narrate', () => {
    expect(refusalLine({ reason: 'not-found', name: 'Sort By' }, 'Open the View menu')).toBe('Sort By not found. Open the View menu.');
    expect(refusalLine({ reason: 'covered', name: 'View > Sort By' }, 'raise the Finder window.')).toBe('Sort By is covered. Raise the Finder window.');
    expect(refusalLine({ reason: 'ax-error', name: '' }, 'Click Size')).toBe('That step did not work. Click Size.');
    for (const reason of ['secure-field', 'sign-in', 'protected-app', 'owner-moved', 'secure-input', 'refused-key', 'unknown'])
      expect(refusalLine({ reason, name: 'Password' }, 'Open the View menu')).toBeNull();
    expect(refusalLine({ reason: 'not-found', name: 'Sort By' }, '  ')).toBeNull();
  });

  it('Set 4 R1: the slip names a refused step at once, from its own words and the reason, then the step that goes instead', () => {
    expect(recoveryLine({ reason: 'not-found', name: 'File > Save' }, 'Save the note.')).toBe('Save the note: not found. Trying another way.');
    expect(recoveryLine({ reason: 'not-found', name: 'File > Save' }, 'Save the note', 'press cmd+shift+s.')).toBe('Save the note: not found. Instead: Press cmd+shift+s.');
    expect(recoveryLine({ reason: 'secure-field', name: 'View > Sort By' }, '')).toBe('Sort By: refused (secure-field). Trying another way.');
    expect(recoveryLine({}, '  ')).toBe('That step: refused (no reason given). Trying another way.');
  });
});
