import { describe, it, expect } from 'vitest';
import { attendanceOf } from './attendance.js';

const m = (o: Record<string, unknown> = {}) => ({ title: 'Design review', start: '2026-10-07T10:00:00.000Z', end: '2026-10-07T10:30:00.000Z', attendees: ['Mira Bakker'], askedAt: null, ...o });

describe('attendanceOf', () => {
  it('joined: a call app on the mic, or a room that talked at least once a minute', () => {
    expect(attendanceOf(m({ called: true }))).toBe('joined');
    expect(attendanceOf(m({ listened: true, heard: 40 }))).toBe('joined');
  });
  it('absent: hearing awake and almost nothing said; online and at the keys with no call; in person with the laptop at home', () => {
    expect(attendanceOf(m({ listened: true, heard: 5 }))).toBe('absent');
    expect(attendanceOf(m({ online: true, ticks: 25, active: 20 }))).toBe('absent');
    expect(attendanceOf(m({ ticks: 25, home: 25 }))).toBe('absent');
  });
  it('the owner\'s own word beats any sample', () => {
    expect(attendanceOf(m({ confirmed: 'yes', listened: true, heard: 2 }))).toBe('joined');
    expect(attendanceOf(m({ confirmed: 'no', called: true }))).toBe('absent');
  });
  it('unknown, never joined, when nothing says either way', () => {
    expect(attendanceOf(m())).toBe('unknown');
    expect(attendanceOf(m({ listened: true, heard: 0 }))).toBe('unknown'); // a dead transcriber hears nothing too
    expect(attendanceOf(m({ ticks: 25, active: 20 }))).toBe('unknown'); // in person with the laptop open
    expect(attendanceOf(m({ online: true, ticks: 2, active: 2 }))).toBe('unknown'); // too few samples
  });
});
