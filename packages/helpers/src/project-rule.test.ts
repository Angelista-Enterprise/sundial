import { describe, expect, it } from 'vitest';
import { ruleForPlace, sanitizeProjectRule, unstableRuleReason } from './sundial-config.js';

/**
 * The one validator and the one builder. Three copies of this logic used to
 * exist — the config parser, the fold, the web route — and the fold's copy did
 * not know `meetingContains`, so an accepted meeting rule was written to disk
 * and silently dropped from the live state until the next boot.
 */
describe('sanitizeProjectRule', () => {
  it('keeps every matcher, including the meeting one the fold used to drop', () => {
    expect(sanitizeProjectRule({ meetingContains: 'Standup', project: 'puzzles' })).toEqual({ meetingContains: 'Standup', project: 'puzzles' });
    expect(sanitizeProjectRule({ urlContains: 'figma.com', titleContains: 'Dr. Denker', project: 'p', confidence: 'certain' })).toEqual({
      urlContains: 'figma.com',
      titleContains: 'Dr. Denker',
      project: 'p',
      confidence: 'certain',
    });
  });

  it('refuses a rule with no project or no matcher — the two shapes that would stamp every window', () => {
    expect(sanitizeProjectRule({ urlContains: 'x' })).toBeNull();
    expect(sanitizeProjectRule({ project: 'p' })).toBeNull();
    expect(sanitizeProjectRule({ project: '  ', urlContains: 'x' })).toBeNull();
    expect(sanitizeProjectRule('nope')).toBeNull();
  });
});

describe('unstableRuleReason', () => {
  it('names a port and a bare loopback host, the two shapes that stop matching', () => {
    expect(unstableRuleReason({ urlContains: 'localhost:8080', project: 'p' })).toMatch(/port/);
    expect(unstableRuleReason({ urlContains: 'localhost', project: 'p' })).toMatch(/loopback/);
    expect(unstableRuleReason({ urlContains: '127.0.0.1/puzzlez', project: 'p' })).toMatch(/loopback/);
  });

  it('passes a durable rule, and never judges a title or a meeting', () => {
    expect(unstableRuleReason({ urlContains: 'figma.com/file/abc', project: 'p' })).toBeNull();
    expect(unstableRuleReason({ titleContains: 'Hub:', project: 'p' })).toBeNull();
    expect(unstableRuleReason({ meetingContains: 'Standup', project: 'p' })).toBeNull();
  });
});

describe('ruleForPlace', () => {
  it('a call is named by its meeting alone — the matcher only fires in a call window, so the host adds nothing', () => {
    expect(ruleForPlace('host', 'meet.google.com', { kind: 'meeting', label: 'RRA: Kruiswoorden' }, 'puzzles')).toEqual({
      rule: { meetingContains: 'RRA: Kruiswoorden', project: 'puzzles' },
    });
  });

  it('a part narrows a host to one path or one page title', () => {
    expect(ruleForPlace('host', 'figma.com', { kind: 'title', label: 'Puzzel app' }, 'puzzles').rule).toEqual({
      urlContains: 'figma.com',
      titleContains: 'Puzzel app',
      project: 'puzzles',
    });
    expect(ruleForPlace('host', 'acme.atlassian.net', { kind: 'path', label: '/jira/software' }, 'p').rule).toEqual({
      urlContains: 'acme.atlassian.net/jira/software',
      project: 'p',
    });
  });

  it('never puts a port in the rule', () => {
    expect(ruleForPlace('host', 'pats-mac-mini.ts.net:8443', null, 'hub').rule).toEqual({ urlContains: 'pats-mac-mini.ts.net', project: 'hub' });
  });

  it('refuses a bare loopback host with a reason, and accepts one narrowed by a part', () => {
    const refused = ruleForPlace('host', 'localhost:8080', null, 'puzzles');
    expect(refused.rule).toBeNull();
    expect(refused.reason).toMatch(/every dev server/);
    expect(ruleForPlace('host', 'localhost:8080', { kind: 'path', label: '/puzzlez' }, 'puzzles').rule).toEqual({ urlContains: '/puzzlez', project: 'puzzles' });
    expect(ruleForPlace('host', '127.0.0.1:3927', { kind: 'title', label: 'CodeAlmanac' }, 'ca').rule).toEqual({ titleContains: 'CodeAlmanac', project: 'ca' });
  });

  it('an app claims its process, narrowed by a title or a meeting', () => {
    expect(ruleForPlace('app', 'Simulator', null, 'sundial').rule).toEqual({ processIs: 'Simulator', project: 'sundial' });
    expect(ruleForPlace('app', 'Code', { kind: 'title', label: '.gnomon' }, 'sundial').rule).toEqual({ processIs: 'Code', titleContains: '.gnomon', project: 'sundial' });
    expect(ruleForPlace('app', 'zoom.us', { kind: 'meeting', label: 'Standup' }, 'p').rule).toEqual({ processIs: 'zoom.us', meetingContains: 'Standup', project: 'p' });
  });
});

describe('a named subdomain of localhost is durable, not bare', () => {
  it('passes the rules this owner already relies on', () => {
    // `overture.localhost` names one project; bare `localhost` names them all.
    // The first guard matched both and would have refused a new one like these.
    expect(unstableRuleReason({ urlContains: 'overture.localhost', project: 'overture' })).toBeNull();
    expect(unstableRuleReason({ urlContains: 'playerone-preview.localhost', project: 'puzzlebox-studio' })).toBeNull();
    expect(unstableRuleReason({ urlContains: 'localhost', project: 'p' })).toMatch(/loopback/);
  });

  it('still names a port on a subdomain, which is the part that moves', () => {
    expect(unstableRuleReason({ urlContains: 'overture.localhost:5173', project: 'p' })).toMatch(/port/);
  });
});
