import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSundialConfig, DEFAULT_SUNDIAL_CONFIG, canonicalProjectName, writeLocationLabel, resolveActionPolicy } from './sundial-config.js';

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
        apiPort: 9000,
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
    expect(config.apiPort).toBe(9000);
  });

  it('D4: rejects an out-of-range or non-integer apiPort and falls back to the default', () => {
    writeConfig(JSON.stringify({ apiPort: 70000 }));
    expect(loadSundialConfig().apiPort).toBe(DEFAULT_SUNDIAL_CONFIG.apiPort);

    writeConfig(JSON.stringify({ apiPort: 8080.5 }));
    expect(loadSundialConfig().apiPort).toBe(DEFAULT_SUNDIAL_CONFIG.apiPort);
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

describe('writeLocationLabel', () => {
  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnomon-config-test-'));
    process.env.SUNDIAL_HOME = scratchDir;
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
    process.env.SUNDIAL_HOME = ORIGINAL_GNOMON_DIR;
  });

  function readConfig(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(scratchDir, 'config.json'), 'utf-8')) as Record<string, unknown>;
  }

  it('creates the file and the map when neither exists yet', () => {
    expect(writeLocationLabel('net2_abc', 'office')).toEqual({ net2_abc: 'office' });
    expect(readConfig().locationLabels).toEqual({ net2_abc: 'office' });
  });

  /** This file is hand-edited by the owner; a label write must not be a rewrite. */
  it('preserves every other key in the file', () => {
    writeConfig(JSON.stringify({ ownerAliases: ['ada'], privacy: { redactionTier: 3 }, locationLabels: { net2_home: 'home' } }));

    writeLocationLabel('net2_abc', 'office');

    const config = readConfig();
    expect(config.ownerAliases).toEqual(['ada']);
    expect(config.privacy).toEqual({ redactionTier: 3 });
    expect(config.locationLabels).toEqual({ net2_home: 'home', net2_abc: 'office' });
  });

  it('renames in place rather than accumulating a second entry', () => {
    writeLocationLabel('net2_abc', 'офис');
    expect(writeLocationLabel('net2_abc', 'office')).toEqual({ net2_abc: 'office' });
  });

  /**
   * Blank is removal, not an empty name. `loadSundialConfig` drops empty values, so
   * storing one would produce a label that works until the next boot and then does
   * not — the worst of the three possible behaviours.
   */
  it('treats null and blank as removal', () => {
    writeLocationLabel('net2_abc', 'office');
    expect(writeLocationLabel('net2_abc', null)).toEqual({});

    writeLocationLabel('net2_abc', 'office');
    expect(writeLocationLabel('net2_abc', '   ')).toEqual({});
    expect(readConfig().locationLabels).toEqual({});
  });

  it('trims the stored name, matching what loadSundialConfig would have done on read', () => {
    expect(writeLocationLabel('net2_abc', '  office  ')).toEqual({ net2_abc: 'office' });
  });

  /**
   * Refuses rather than starting from `{}`, which would silently drop every other
   * setting in the owner's file to save one label.
   */
  it('refuses to write over a config file it could not parse', () => {
    writeConfig('{ not json');
    expect(() => writeLocationLabel('net2_abc', 'office')).toThrow(/unparseable/);
    expect(fs.readFileSync(path.join(scratchDir, 'config.json'), 'utf-8')).toBe('{ not json');
  });

  it('round-trips through loadSundialConfig', () => {
    writeLocationLabel('net2_abc', 'office');
    expect(loadSundialConfig().locationLabels).toEqual({ net2_abc: 'office' });
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
