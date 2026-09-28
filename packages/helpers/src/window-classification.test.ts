import { describe, expect, it } from 'vitest';
import { type ActivityTaxonomy, browserProfileFromTitle, classifyActivity, hostFromTitle, cleanWindowTitle, hostOf, isConferencingHost } from './window-classification.js';

/**
 * Every fixture here is a real window title or domain from the 23-day reference
 * corpus, including the three that a hand-written classifier gets wrong.
 */
const TAXONOMY: ActivityTaxonomy = {
  browserProfiles: { 'Pat (Acme)': 'work', 'Pat (Ent)': 'personal', 'Pat (Private)': 'personal', 'Pat (sounds.example)': 'personal-work' },
  domainOverrides: {
    work: ['github.com', '*.atlassian.net', 'claude.ai', 'localhost*', 'orchestra-site.nl', 'dribbble.com', 'puzzlez.daily.nl', 'daily.nl'],
    personal: ['ns.nl', 'netflix.com'],
  },
  processes: { work: ['Claude', 'Code', 'Warp'], personal: ['TV', 'WhatsApp'], ambient: ['Spotify'] },
  excluded: ['*.edr-agent.example', 'accounts.google.com'],
};

const chrome = (page: string, profile: string, url?: string): string => `${page} - Google Chrome - ${profile}${url ? ` (${url})` : ''}`;

describe('browserProfileFromTitle', () => {
  it('reads the profile out of a real Chrome title', () => {
    expect(browserProfileFromTitle(chrome('GitHub', 'Pat (Acme)', 'https://github.com/'))).toBe('Pat (Acme)');
  });

  it('reads it when no URL is appended', () => {
    expect(browserProfileFromTitle(chrome('Untitled', 'Pat (Acme)'))).toBe('Pat (Acme)');
  });

  it('handles the devtools and chrome:// schemes', () => {
    expect(browserProfileFromTitle(chrome('New Tab', 'Pat (Ent)', 'chrome://newtab/'))).toBe('Pat (Ent)');
    expect(browserProfileFromTitle(chrome('DevTools', 'Pat (Acme)', 'devtools://devtools/bundled/devtools_app.html?panel=elements'))).toBe('Pat (Acme)');
  });

  it('returns null for a non-browser title', () => {
    expect(browserProfileFromTitle('index.ts — gnomon')).toBeNull();
  });

  it('refuses to invent a profile when the last parenthesised group is a filename', () => {
    // 9 of 6,707 browser titles in the corpus did exactly this. Yielding
    // `Pat (Acme).pdf)` as a profile would create a phantom that matches nothing
    // and silently classifies the window `unknown` for the wrong reason.
    expect(browserProfileFromTitle('report (Acme).pdf - Google Chrome - Pat (Acme).pdf')).toBeNull();
  });
});

describe('hostFromTitle', () => {
  it('strips www and lowercases', () => {
    expect(hostFromTitle(chrome('GitHub', 'x', 'https://WWW.GitHub.com/Acme'))).toBe('github.com');
  });

  it('takes the last URL, which is the one the title is actually about', () => {
    expect(hostFromTitle('a - Google Chrome - x (https://google.com/search) (https://dribbble.com/shots/1)')).toBe('dribbble.com');
  });

  it('returns null when there is no URL', () => {
    expect(hostFromTitle('Xcode')).toBeNull();
  });
});

describe('classifyActivity', () => {
  it('classifies the work profile as work', () => {
    expect(classifyActivity('Google Chrome', chrome('Acme/overture', 'Pat (Acme)', 'https://github.com/Acme/overture'), TAXONOMY)).toBe('work');
  });

  it('classifies YouTube in the entertainment profile as personal', () => {
    // The measurement that put the profile ahead of the domain: 202 of 213
    // youtube.com visits in the corpus sat in this one profile.
    expect(classifyActivity('Google Chrome', chrome('Some video', 'Pat (Ent)', 'https://youtube.com/watch?v=x'), TAXONOMY)).toBe('personal');
  });

  it('lets a domain override beat the profile it sits in', () => {
    // The leisure profile still contained claude.ai and localhost:3000, so a profile
    // is a prior and never a verdict.
    expect(classifyActivity('Google Chrome', chrome('Claude', 'Pat (Ent)', 'https://claude.ai/chat'), TAXONOMY)).toBe('work');
    expect(classifyActivity('Google Chrome', chrome('Overture Local', 'Pat (Ent)', 'http://localhost:3000/'), TAXONOMY)).toBe('work');
  });

  it('keeps the two domains that look like leisure and are work', () => {
    // Overture is classical-concert client work, and the dribbble visits were
    // searches for "agentic UI". A naive list calls both downtime.
    expect(classifyActivity('Google Chrome', chrome('Orchestra-Site', 'Pat (Ent)', 'https://orchestra-site.nl/'), TAXONOMY)).toBe('work');
    expect(classifyActivity('Google Chrome', chrome('Agentic UI', 'Pat (Ent)', 'https://dribbble.com/shots/1'), TAXONOMY)).toBe('work');
  });

  it('keeps Daily and the puzzles as work', () => {
    expect(classifyActivity('Google Chrome', chrome('Daily', 'Pat (Ent)', 'https://daily.nl/'), TAXONOMY)).toBe('work');
    expect(classifyActivity('Google Chrome', chrome('Puzzlez', 'Pat (Ent)', 'https://puzzlez.daily.nl/'), TAXONOMY)).toBe('work');
  });

  it('never classifies machine traffic', () => {
    // The corporate security agent's 23 visits are not the owner doing anything.
    expect(classifyActivity('Google Chrome', chrome('Security console', 'Pat (Acme)', 'https://eu-1.edr-agent.example/'), TAXONOMY)).toBe('unknown');
    expect(classifyActivity('Google Chrome', chrome('Sign in', 'Pat (Ent)', 'https://accounts.google.com/signin'), TAXONOMY)).toBe('unknown');
  });

  it('treats music as ambient rather than personal', () => {
    // Coding with an album on is not rest. Calling it rest would mean the owner never
    // lacks downtime, which silently disables the detector that looks for its absence.
    expect(classifyActivity('Spotify', 'Spotify', TAXONOMY)).toBe('ambient');
  });

  it('falls back to the built-in predicates for anyone', () => {
    expect(classifyActivity('Cursor', 'main.rs — proj', TAXONOMY)).toBe('work');
    expect(classifyActivity('iTerm2', 'zsh', TAXONOMY)).toBe('work');
    expect(classifyActivity('zoom.us', 'Zoom Meeting', TAXONOMY)).toBe('work');
  });

  it('returns unknown — never personal — for anything unclassified', () => {
    // The asymmetry that sets the default: a false "you had downtime" silently
    // cancels a true "no downtime in eight days" and leaves no trace that it did.
    expect(classifyActivity('SomeNewApp', 'a window', TAXONOMY)).toBe('unknown');
    expect(classifyActivity('Google Chrome', chrome('Random', 'Pat (Unmapped)', 'https://example.com/'), TAXONOMY)).toBe('unknown');
  });

  it('lets a process override win over the browser path', () => {
    expect(classifyActivity('WhatsApp', chrome('anything', 'Pat (Acme)', 'https://github.com/'), TAXONOMY)).toBe('personal');
  });

  it('matches globs, not substrings', () => {
    expect(classifyActivity('Google Chrome', chrome('Jira', 'Pat (Ent)', 'https://acme.atlassian.net/browse/X-1'), TAXONOMY)).toBe('work');
    // `*.atlassian.net` must not match a lookalike host that merely contains it.
    expect(classifyActivity('Google Chrome', chrome('Phish', 'Pat (Unmapped)', 'https://acme.atlassian.net.evil.example/'), TAXONOMY)).toBe('unknown');
  });
});


describe('cleanWindowTitle', () => {
  it('strips the app suffix and the browser profile', () => {
    expect(cleanWindowTitle('Puzzlebox - Backlog - Jira - Google Chrome - Pat (Acme)', 'Google Chrome')).toBe('Puzzlebox - Backlog - Jira');
    expect(cleanWindowTitle('Acme - Obsidian 1.13.7', 'Obsidian')).toBe('Acme');
  });

  it('never truncates at a ticket key\'s own hyphen — the separator must be spaced', () => {
    // The first version matched any hyphen followed by a parenthesised tail, so
    // this read "BOX" and the owner was asked to attribute a truncated title.
    expect(cleanWindowTitle('BOX-484 (in review) - Google Chrome - Pat (Acme)', 'Google Chrome')).toBe('BOX-484 (in review)');
    expect(cleanWindowTitle('PR: fix login - review (WIP) - Google Chrome', 'Google Chrome')).toBe('PR: fix login - review (WIP)');
  });

  it('only strips a profile from a BROWSER title, never from an editor\'s', () => {
    expect(cleanWindowTitle('app.ts — sundial (Workspace)', 'Code')).toBe('app.ts — sundial (Workspace)');
  });
});

describe('hostOf', () => {
  it('names the host, keeps the port, drops www and browser-internal pages', () => {
    expect(hostOf('https://www.acme.atlassian.net/jira')).toBe('acme.atlassian.net');
    expect(hostOf('http://localhost:8080/hub')).toBe('localhost:8080');
    expect(hostOf('chrome://newtab/')).toBeNull();
    expect(hostOf('file:///Users/x/a.pdf')).toBeNull();
  });

  it('agrees with the conferencing test on a shouty URL — the matcher and the proposer share it', () => {
    expect(isConferencingHost(hostOf('HTTPS://WWW.Meet.Google.com/abc-defg-hij'))).toBe(true);
  });
});
