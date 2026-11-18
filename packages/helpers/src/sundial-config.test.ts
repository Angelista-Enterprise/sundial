import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSundialConfig, DEFAULT_SUNDIAL_CONFIG, canonicalProjectName, resolveActionPolicy, resolveSundialConfig } from './sundial-config.js';

let scratchDir: string;
const ORIGINAL_SUNDIAL_HOME = process.env.SUNDIAL_HOME;
const ORIGINAL_POLL_ENV = process.env.SUNDIAL_POLL_INTERVAL_MS;

function writeConfig(contents: string): void {
  fs.writeFileSync(path.join(scratchDir, 'config.json'), contents);
}

describe('loadSundialConfig', () => {
  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnomon-config-test-'));
    process.env.SUNDIAL_HOME = scratchDir;
    delete process.env.SUNDIAL_POLL_INTERVAL_MS;
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
    process.env.SUNDIAL_HOME = ORIGINAL_SUNDIAL_HOME;
    if (ORIGINAL_POLL_ENV === undefined) delete process.env.SUNDIAL_POLL_INTERVAL_MS;
    else process.env.SUNDIAL_POLL_INTERVAL_MS = ORIGINAL_POLL_ENV;
  });

  it('returns pure defaults when no config.json exists — not an error', () => {
    expect(loadSundialConfig()).toEqual(DEFAULT_SUNDIAL_CONFIG);
  });

  it('falls back to defaults and warns on malformed JSON, rather than throwing', () => {
    writeConfig('{ this is not valid json');
    expect(() => loadSundialConfig()).not.toThrow();
    expect(loadSundialConfig()).toEqual(DEFAULT_SUNDIAL_CONFIG);
  });

  it('ignores an old telegram block — the bridge is gone, the key is not an error', () => {
    writeConfig(JSON.stringify({ telegram: { token: 'made-up-token', chatId: 12345 } }));
    expect(loadSundialConfig()).toEqual(DEFAULT_SUNDIAL_CONFIG);
    expect('telegram' in loadSundialConfig()).toBe(false);
  });

  it('workdays: Monday to Friday unless a list of weekday numbers 0 to 6 says otherwise', () => {
    expect(loadSundialConfig().workdays).toEqual([1, 2, 3, 4, 5]);
    writeConfig(JSON.stringify({ workdays: [2, 3, 3, 6] }));
    expect(loadSundialConfig().workdays).toEqual([2, 3, 6]);
    writeConfig(JSON.stringify({ workdays: [1, 7] }));
    expect(loadSundialConfig().workdays).toEqual([1, 2, 3, 4, 5]);
  });

  it('choreDays: 3 unless a whole number 2 to 14 says otherwise', () => {
    expect(loadSundialConfig().choreDays).toBe(3);
    writeConfig(JSON.stringify({ choreDays: 5 }));
    expect(loadSundialConfig().choreDays).toBe(5);
    writeConfig(JSON.stringify({ choreDays: 1 }));
    expect(loadSundialConfig().choreDays).toBe(3);
  });

  it('offerBar (S6): the offers bar is 1 unless a number 0.1 to 4 says otherwise', () => {
    expect(loadSundialConfig().offerBar).toBe(1);
    expect(DEFAULT_SUNDIAL_CONFIG.offerBar).toBe(1);
    writeConfig(JSON.stringify({ offerBar: 0.7 }));
    expect(loadSundialConfig().offerBar).toBe(0.7);
    for (const bad of [0, 5, 'high', null]) {
      writeConfig(JSON.stringify({ offerBar: bad }));
      expect(loadSundialConfig().offerBar).toBe(1);
    }
  });

  // lane E (#12)
  it('jobs: the night shift is off unless enabled is exactly true, and a bad cap falls back', () => {
    const off = { enabled: false, maxUsdPerJob: 2, maxUsdPerNight: 5, maxJobsPerNight: 2, maxMinutes: 90 };
    expect(loadSundialConfig().jobs).toEqual(off);
    writeConfig(JSON.stringify({ jobs: { enabled: 'true', maxUsdPerJob: -1, maxMinutes: 'long' } }));
    expect(loadSundialConfig().jobs).toEqual(off);
    writeConfig(JSON.stringify({ jobs: { enabled: true, maxUsdPerJob: 0.5, maxJobsPerNight: 1.7 } }));
    expect(loadSundialConfig().jobs).toEqual({ ...off, enabled: true, maxUsdPerJob: 0.5, maxJobsPerNight: 1 });
  });

  it('llm.sources and llm.roles: shape-checked, a single string is a list of one, and the old hands keys alias into them', () => {
    expect(loadSundialConfig().llm).toMatchObject({ sources: {}, roles: {} });
    writeConfig(JSON.stringify({ llm: { sources: { claude: { access: 'runtime', path: 'claude' }, odd: { access: 'api' } }, roles: { background: 'claude:sonnet', judge: ['jev', 'nope!', 'claude:sonnet'], Jobs: ['claude'] } } }));
    expect(loadSundialConfig().llm).toMatchObject({ sources: { claude: { access: 'runtime', runtime: 'claude-cli', path: null } }, roles: { background: ['claude:sonnet'], judge: ['jev', 'claude:sonnet'] } });
    writeConfig(JSON.stringify({ hands: { claude: 'yes', claudePath: 'claude', maxBudgetUsd: -2 } }));
    expect(loadSundialConfig().llm).toMatchObject({ sources: {}, roles: {} });
    expect(loadSundialConfig().jobs.maxUsdPerJob).toBe(2);
    writeConfig(JSON.stringify({ hands: { claude: true, claudePath: '/opt/homebrew/bin/claude', maxBudgetUsd: 0.5 } }));
    expect(loadSundialConfig().llm).toMatchObject({ sources: { claude: { path: '/opt/homebrew/bin/claude' } }, roles: { jobs: ['claude'] } });
    expect(loadSundialConfig().jobs.maxUsdPerJob).toBe(0.5);
    writeConfig(JSON.stringify({ hands: { maxBudgetUsd: 0.5 }, jobs: { maxUsdPerJob: 3 } }));
    expect(loadSundialConfig().jobs.maxUsdPerJob).toBe(3);
  });

  it('llm.compactAt: a positive whole number of tokens, else unset', () => {
    writeConfig(JSON.stringify({ llm: { compactAt: 150000 } }));
    expect(loadSundialConfig().llm.compactAt).toBe(150000);
    writeConfig(JSON.stringify({ llm: { compactAt: '150k' } }));
    expect('compactAt' in loadSundialConfig().llm).toBe(false);
  });

  it('llm.compactKeepFront: true only when written true, else unset (off)', () => {
    writeConfig(JSON.stringify({ llm: { compactKeepFront: true } }));
    expect(loadSundialConfig().llm.compactKeepFront).toBe(true);
    writeConfig(JSON.stringify({ llm: { compactKeepFront: 'yes' } }));
    expect('compactKeepFront' in loadSundialConfig().llm).toBe(false);
  });

  it('llm.hedgeAfterMs: a whole number of ms, 0 kept (off), else unset', () => {
    writeConfig(JSON.stringify({ llm: { hedgeAfterMs: 0 } }));
    expect(loadSundialConfig().llm.hedgeAfterMs).toBe(0);
    writeConfig(JSON.stringify({ llm: { hedgeAfterMs: -1 } }));
    expect('hedgeAfterMs' in loadSundialConfig().llm).toBe(false);
  });

  it('llm.stallMs: a whole number of ms, 0 kept (off), else unset', () => {
    writeConfig(JSON.stringify({ llm: { stallMs: 0 } }));
    expect(loadSundialConfig().llm.stallMs).toBe(0);
    writeConfig(JSON.stringify({ llm: { stallMs: '20s' } }));
    expect('stallMs' in loadSundialConfig().llm).toBe(false);
  });

  it('llm.connectMs: a whole number of ms, clamped to 2000..30000, else unset (the plugin uses 7000)', () => {
    writeConfig(JSON.stringify({ llm: { connectMs: 15_000 } }));
    expect(loadSundialConfig().llm.connectMs).toBe(15_000);
    writeConfig(JSON.stringify({ llm: { connectMs: 500 } }));
    expect(loadSundialConfig().llm.connectMs).toBe(2_000);
    writeConfig(JSON.stringify({ llm: { connectMs: 120_000 } }));
    expect(loadSundialConfig().llm.connectMs).toBe(30_000);
    writeConfig(JSON.stringify({ llm: { connectMs: '7s' } }));
    expect('connectMs' in loadSundialConfig().llm).toBe(false);
  });

  it('filters non-string entries out of the privacy string arrays', () => {
    writeConfig(
      JSON.stringify({
        privacy: {
          sensitiveApps: ['RealApp', 123, { nope: true }, 'AnotherApp'],
          hiddenApps: ['Secret', null],
          shellRedactPatterns: [42, 'token=\\S+'],
        },
      }),
    );
    const config = loadSundialConfig();
    expect(config.privacy.extraSensitiveApps).toEqual(['RealApp', 'AnotherApp']);
    expect(config.privacy.extraHiddenApps).toEqual(['Secret']);
    expect(config.privacy.extraShellRedactPatterns).toEqual(['token=\\S+']);
  });

  it('reads a valid, fully-populated config.json', () => {
    writeConfig(
      JSON.stringify({
        privacy: { redactionTier: 3, sensitiveApps: ['my-app'], hiddenApps: ['SecretApp'], shellRedactPatterns: ['(?i)custom=\\S+'] },
        budgets: { intent: 500 },
        retentionDays: 90,
        decayFactor: 0.9,
        pollIntervalMs: 2000,
        clipboardEnabled: true,
      }),
    );

    const config = loadSundialConfig();
    expect(config.privacy.redactionTier).toBe(3);
    expect(config.privacy.extraSensitiveApps).toEqual(['my-app']);
    expect(config.privacy.extraHiddenApps).toEqual(['SecretApp']);
    expect(config.privacy.extraShellRedactPatterns).toEqual(['(?i)custom=\\S+']);
    expect(config.budgets).toEqual({ intent: 500 });
    expect(config.retentionDays).toBe(90);
    expect(config.decayFactor).toBe(0.9);
    expect(config.pollIntervalMs).toBe(2000);
    expect(config.clipboardEnabled).toBe(true);
  });

  it('falls back to defaults field-by-field for a partially-filled config.json', () => {
    writeConfig(JSON.stringify({ retentionDays: 30 }));
    const config = loadSundialConfig();
    expect(config.retentionDays).toBe(30);
    expect(config.decayFactor).toBe(DEFAULT_SUNDIAL_CONFIG.decayFactor);
    expect(config.privacy).toEqual(DEFAULT_SUNDIAL_CONFIG.privacy);
  });

  it('rejects an invalid redactionTier and falls back to the default', () => {
    writeConfig(JSON.stringify({ privacy: { redactionTier: 7 } }));
    expect(loadSundialConfig().privacy.redactionTier).toBe(2);
  });

  it('rejects a non-positive retentionDays/out-of-range decayFactor', () => {
    writeConfig(JSON.stringify({ retentionDays: -5, decayFactor: 1.5 }));
    const config = loadSundialConfig();
    expect(config.retentionDays).toBe(DEFAULT_SUNDIAL_CONFIG.retentionDays);
    expect(config.decayFactor).toBe(DEFAULT_SUNDIAL_CONFIG.decayFactor);
  });

  it('L6: floors pollIntervalMs at the minimum, even for a bogus small/negative file value', () => {
    writeConfig(JSON.stringify({ pollIntervalMs: 0 }));
    expect(loadSundialConfig().pollIntervalMs).toBeGreaterThanOrEqual(200);
  });

  it('the SUNDIAL_POLL_INTERVAL_MS env var takes precedence over config.json', () => {
    writeConfig(JSON.stringify({ pollIntervalMs: 5000 }));
    process.env.SUNDIAL_POLL_INTERVAL_MS = '3000';
    expect(loadSundialConfig().pollIntervalMs).toBe(3000);
  });

  it('P1: reads projectRules and drops malformed ones (no project, no matcher)', () => {
    writeConfig(
      JSON.stringify({
        projectRules: [
          { urlContains: 'localhost:3000', project: 'overture' },
          { titleContains: 'atlassian.net', project: 'jira', confidence: 'certain' },
          { project: 'no-matcher' }, // dropped — no matcher
          { urlContains: 'x' }, // dropped — no project
          'garbage', // dropped — not an object
        ],
      }),
    );
    const rules = loadSundialConfig().projectRules;
    expect(rules).toEqual([
      { urlContains: 'localhost:3000', project: 'overture' },
      { titleContains: 'atlassian.net', project: 'jira', confidence: 'certain' },
    ]);
  });

  it('accepts a processIs-only rule (a whole-app mapping is a legitimate owner intent)', () => {
    writeConfig(
      JSON.stringify({
        projectRules: [
          { processIs: 'Gnomon', project: 'gnomon' }, // kept — an app that IS one project
          { project: 'no-matcher' }, // still dropped — no matcher at all
        ],
      }),
    );
    expect(loadSundialConfig().projectRules).toEqual([{ processIs: 'Gnomon', project: 'gnomon' }]);
  });

  it('P1: reads projectAliases and ignores non-string values', () => {
    writeConfig(JSON.stringify({ projectAliases: { WCS: 'wcs', 'PB-Games': 'puzzlebox-studio', bad: 5 } }));
    expect(loadSundialConfig().projectAliases).toEqual({ WCS: 'wcs', 'PB-Games': 'puzzlebox-studio' });
  });

  it('P1: projectRules/projectAliases default to empty when absent', () => {
    writeConfig(JSON.stringify({ retentionDays: 30 }));
    const config = loadSundialConfig();
    expect(config.projectRules).toEqual([]);
    expect(config.projectAliases).toEqual({});
  });

  it('P7: ocr defaults to disabled with default intervals when absent', () => {
    writeConfig(JSON.stringify({ retentionDays: 30 }));
    expect(loadSundialConfig().ocr).toEqual({ enabled: false, fullIntervalMs: 5000, cursorIntervalMs: 1500, cursorRegionPx: 480, slowApps: ['claude'], slowIntervalMs: 60_000, retentionDays: 14, vision: { enabled: false, model: 'gemma4:e4b-mlx', intervalMs: 60_000 }, jev: { text: false, frames: false, framesPerHour: 12 } });
  });

  it('the screen to Jev: two consents, each given only by a literal true; frames at most 60 an hour', () => {
    writeConfig(JSON.stringify({ ocr: { enabled: true, jev: { text: 'yes', frames: true, framesPerHour: 500 } } }));
    expect(loadSundialConfig().ocr.jev).toEqual({ text: false, frames: true, framesPerHour: 60 });
    writeConfig(JSON.stringify({ ocr: { enabled: true, jev: { text: true } } }));
    expect(loadSundialConfig().ocr.jev).toEqual({ text: true, frames: false, framesPerHour: 12 });
  });

  it('P7: reads ocr overrides and floors the intervals', () => {
    writeConfig(JSON.stringify({ ocr: { enabled: true, fullIntervalMs: 3000, cursorIntervalMs: 100, cursorRegionPx: 640 } }));
    const ocr = loadSundialConfig().ocr;
    expect(ocr.enabled).toBe(true);
    expect(ocr.fullIntervalMs).toBe(3000);
    expect(ocr.cursorIntervalMs).toBe(500); // floored at MIN_OCR_INTERVAL_MS
    expect(ocr.cursorRegionPx).toBe(640);
  });

  describe('actions', () => {
    it('is safe by default: internal auto, outward off', () => {
      const { actions } = loadSundialConfig();
      expect(resolveActionPolicy(actions, 'internal', 'remember')).toBe('auto');
      expect(resolveActionPolicy(actions, 'outward', 'send_email')).toBe('off');
    });

    it('accepts a bare policy applied to a whole class', () => {
      writeConfig(JSON.stringify({ actions: { internal: 'ask', outward: 'ask' } }));
      const { actions } = loadSundialConfig();
      expect(resolveActionPolicy(actions, 'internal', 'remember')).toBe('ask');
      expect(resolveActionPolicy(actions, 'outward', 'send_email')).toBe('ask');
    });

    it('accepts a per-tool map with an `all` default', () => {
      writeConfig(JSON.stringify({ actions: { outward: { all: 'ask', run_shell: 'off', create_calendar_event: 'auto' } } }));
      const { actions } = loadSundialConfig();
      expect(resolveActionPolicy(actions, 'outward', 'draft_email')).toBe('ask'); // the class default
      expect(resolveActionPolicy(actions, 'outward', 'run_shell')).toBe('off'); // overridden
      expect(resolveActionPolicy(actions, 'outward', 'create_calendar_event')).toBe('auto');
    });

    it('drops an unknown policy value rather than coercing it — a typo cannot promote a tool', () => {
      writeConfig(JSON.stringify({ actions: { outward: { send_email: 'yes-please' } } }));
      const { actions } = loadSundialConfig();
      expect(resolveActionPolicy(actions, 'outward', 'send_email')).toBe('off'); // fell back to the safe default
    });

    it('reads earnAfter as an integer 1 to 100', () => {
      // Round 3: the ladder's k, default 10, an integer 1 to 100.
      expect([undefined, 12, 0, 'x', 500].map((earnAfter) => (writeConfig(JSON.stringify({ actions: { earnAfter } })), loadSundialConfig().actions.earnAfter))).toEqual([10, 12, 10, 10, 100]);
    });
  });
});

describe('canonicalProjectName', () => {
  it('lowercases and trims when no alias matches', () => {
    expect(canonicalProjectName('  Gnomon ', {})).toBe('gnomon');
  });

  it('applies an exact alias key', () => {
    expect(canonicalProjectName('PB-Games', { 'PB-Games': 'puzzlebox-studio' })).toBe('puzzlebox-studio');
  });

  it('applies an alias case-insensitively', () => {
    expect(canonicalProjectName('wcs', { WCS: 'wcs-canonical' })).toBe('wcs-canonical');
  });

  it('collapses casing variants to the same canonical form', () => {
    expect(canonicalProjectName('WCS', {})).toBe(canonicalProjectName('wcs', {}));
  });
});

describe('S4 browser.pageTextAx and privacy.privateHosts (Fable M5, H3)', () => {
  it('the Firefox Accessibility read is its own switch: off by default, never implied by pageText', () => {
    expect(DEFAULT_SUNDIAL_CONFIG.browser).toEqual({ pageText: false, pageTextAx: false });
    expect(resolveSundialConfig({ browser: { pageText: true } } as never).browser).toEqual({ pageText: true, pageTextAx: false });
    expect(resolveSundialConfig({ browser: { pageTextAx: true } } as never).browser).toEqual({ pageText: false, pageTextAx: true });
    expect(resolveSundialConfig({ browser: { pageTextAx: 'yes' } } as never).browser.pageTextAx).toBe(false);
  });

  it('privateHosts are the owner\'s, added to the defaults', () => {
    expect(resolveSundialConfig({ privacy: { privateHosts: ['bank.example', 7] } } as never).privacy.extraPrivateHosts).toEqual(['bank.example']);
    expect(DEFAULT_SUNDIAL_CONFIG.privacy.extraPrivateHosts).toEqual([]);
  });
});

describe('sensors.githubPrs', () => {
  it('on unless the file says false', () => {
    expect(DEFAULT_SUNDIAL_CONFIG.sensors).toEqual({ githubPrs: true });
    expect(resolveSundialConfig({} as never).sensors.githubPrs).toBe(true);
    expect(resolveSundialConfig({ sensors: { githubPrs: false } } as never).sensors.githubPrs).toBe(false);
  });
});

describe('atlas.libraries', () => {
  it('on unless the file says false', () => {
    expect(DEFAULT_SUNDIAL_CONFIG.atlas).toEqual({ libraries: true });
    expect(resolveSundialConfig({ atlas: { libraries: false } } as never).atlas.libraries).toBe(false);
  });
});

describe('audio.whisperUrl stays on this Mac', () => {
  it('a loopback URL is kept; any other host is refused for the default', () => {
    const url = (whisperUrl: unknown) => resolveSundialConfig({ audio: { whisperUrl } } as never).audio.whisperUrl;
    expect(url('http://127.0.0.1:9000/inference')).toBe('http://127.0.0.1:9000/inference');
    expect(url('http://localhost:8771/inference')).toBe('http://localhost:8771/inference');
    expect(url('http://[::1]:8771/inference')).toBe('http://[::1]:8771/inference');
    for (const away of ['https://whisper.example.com/inference', 'http://100.101.102.103:8771/inference', 'http://127.0.0.1.example.com/x', 'not a url']) expect(url(away)).toBe(DEFAULT_SUNDIAL_CONFIG.audio.whisperUrl);
  });
});
