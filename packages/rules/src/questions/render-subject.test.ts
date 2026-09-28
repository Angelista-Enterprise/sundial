import { describe, expect, it } from 'vitest';
import { renderSubject, resolveSubject, subjectAvailable } from './render-subject.js';

const EV = { app: 'Code', project: '~/Projects/sundial', git_branch: 'lab/noticing-gate', meeting_title: null, window_titles: ['runtime.ts — sundial', 'types.ts'], shell_commands: ['npx vitest run'], heard_aloud: 'we should ship the judge' };

describe('renderSubject', () => {
  it('renders the four template subjects from the evidence and nothing else', () => {
    expect(renderSubject('project', EV)).toBe('Working on sundial (lab/noticing-gate)');
    expect(renderSubject('project', { ...EV, git_branch: 'main' })).toBe('Working on sundial');
    expect(renderSubject('branch', EV)).toBe('On lab/noticing-gate in sundial');
    expect(renderSubject('meeting', { ...EV, meeting_title: 'Standup' })).toBe('Meeting: Standup');
    expect(renderSubject('window', EV)).toBe('Code: runtime.ts — sundial');
    expect(renderSubject('app', EV)).toBe('In Code');
    expect(renderSubject('spoken', EV)).toBeNull();
    expect(renderSubject('commands', EV)).toBeNull();
  });
});

describe('resolveSubject', () => {
  it('keeps a pick whose field exists, and falls through a pick at a null field to the most specific available subject', () => {
    expect(resolveSubject('spoken', EV)).toBe('spoken');
    expect(resolveSubject('meeting', EV)).toBe('project');
    expect(resolveSubject('project', { app: 'Arc', window_titles: ['Hub'] })).toBe('window');
    expect(resolveSubject('branch', { app: 'Arc' })).toBe('app');
    expect(resolveSubject(null, { ...EV, meeting_title: 'Standup' })).toBe('meeting');
    expect(subjectAvailable('commands', { shell_commands: [] })).toBe(false);
  });
});
