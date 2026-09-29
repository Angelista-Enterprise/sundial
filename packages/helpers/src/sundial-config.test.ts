import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSundialConfig, DEFAULT_SUNDIAL_CONFIG, canonicalProjectName, resolveActionPolicy } from './sundial-config.js';

let scratchDir: string;
const ORIGINAL_GNOMON_DIR = process.env.SUNDIAL_HOME;
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
    process.env.SUNDIAL_HOME = ORIGINAL_GNOMON_DIR;
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

  // lane E (#12)
  it('jobs: the night shift is off unless enabled is exactly true, and a bad cap falls back', () => {
    const off = { enabled: false, maxUsdPerJob: 2, maxUsdPerNight: 5, maxJobsPerNight: 2, maxMinutes: 90 };
    expect(loadSundialConfig().jobs).toEqual(off);
    writeConfig(JSON.stringify({ jobs: { enabled: 'true', maxUsdPerJob: -1, maxMinutes: 'long' } }));
    expect(loadSundialConfig().jobs).toEqual(off);
    writeConfig(JSON.stringify({ jobs: { enabled: true, maxUsdPerJob: 0.5, maxJobsPerNight: 1.7 } }));
    expect(loadSundialConfig().jobs).toEqual({ ...off, enabled: true, maxUsdPerJob: 0.5, maxJobsPerNight: 1 });
  });

  it('hands: Claude is off unless it is exactly true, and a bad path or budget falls back', () => {
    expect(loadSundialConfig().hands).toEqual({ claude: false, claudePath: null, maxBudgetUsd: 1 });
    writeConfig(JSON.stringify({ hands: { claude: 'yes', claudePath: 'claude', maxBudgetUsd: -2 } }));
    expect(loadSundialConfig().hands).toEqual({ claude: false, claudePath: null, maxBudgetUsd: 1 });
    writeConfig(JSON.stringify({ hands: { claude: true, claudePath: '/opt/homebrew/bin/claude', maxBudgetUsd: 0.5 } }));
    expect(loadSundialConfig().hands).toEqual({ claude: true, claudePath: '/opt/homebrew/bin/claude', maxBudgetUsd: 0.5 });
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
    expect(loadSundialConfig().ocr).toEqual({ enabled: false, fullIntervalMs: 5000, cursorIntervalMs: 1500, cursorRegionPx: 480, retentionDays: 14, vision: { enabled: false, model: 'gemma4:e4b-mlx', intervalMs: 60_000 } });
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
    it('is safe by default: internal auto, outward off, no filesystem writes', () => {
      const { actions } = loadSundialConfig();
      expect(resolveActionPolicy(actions, 'internal', 'remember')).toBe('auto');
      expect(resolveActionPolicy(actions, 'outward', 'send_email')).toBe('off');
      expect(actions.filesystemAllow).toEqual([]);
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

    it('carries the filesystem allowlist through', () => {
      writeConfig(JSON.stringify({ actions: { filesystemAllow: ['~/Projects/sundial', '/tmp/gnomon'] } }));
      expect(loadSundialConfig().actions.filesystemAllow).toEqual(['~/Projects/sundial', '/tmp/gnomon']);
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
