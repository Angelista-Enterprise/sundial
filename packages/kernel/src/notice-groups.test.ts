// lane H (H4)
import { describe, expect, it } from 'vitest';
import { noticeTitle } from './notice-groups.js';

describe('noticeTitle', () => {
  it("titles a push by its group's label, a question and a reminder by name, anything else Gnomon", () => {
    expect(noticeTitle('agent-waiting')).toBe('Coding agents');
    expect(noticeTitle('promise-fading')).toBe('Promises');
    expect(noticeTitle('sensor-health')).toBe("Sundial's own health");
    expect(noticeTitle('owner-question')).toBe('Question');
    expect(noticeTitle('wakeup')).toBe('Reminder');
    expect(noticeTitle('something-new')).toBe('Gnomon');
  });
});
