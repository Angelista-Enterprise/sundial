import { describe, it, expect, afterEach } from 'vitest';
import { applyPrivacyConfig, privacyConfig, DEFAULT_SENSITIVE_APPS } from './privacy-config.js';

const ORIGINAL = {
  redactionTier: privacyConfig.redactionTier,
  sensitiveApps: [...privacyConfig.sensitiveApps],
  hiddenApps: [...privacyConfig.hiddenApps],
  shellRedactPatterns: [...privacyConfig.shellRedactPatterns],
};

describe('applyPrivacyConfig', () => {
  afterEach(() => {
    // Restore the module singleton so other test files see the original defaults.
    privacyConfig.redactionTier = ORIGINAL.redactionTier;
    privacyConfig.sensitiveApps = [...ORIGINAL.sensitiveApps];
    privacyConfig.hiddenApps = [...ORIGINAL.hiddenApps];
    privacyConfig.shellRedactPatterns = [...ORIGINAL.shellRedactPatterns];
  });

  it('replaces redactionTier wholesale (a deliberate scalar override, not additive)', () => {
    applyPrivacyConfig({ redactionTier: 3, extraSensitiveApps: [], extraHiddenApps: [], extraShellRedactPatterns: [] });
    expect(privacyConfig.redactionTier).toBe(3);
  });

  it('adds to sensitiveApps without removing the built-in defaults', () => {
    applyPrivacyConfig({ redactionTier: 2, extraSensitiveApps: ['my-custom-app'], extraHiddenApps: [], extraShellRedactPatterns: [] });
    expect(privacyConfig.sensitiveApps).toContain('my-custom-app');
    for (const app of DEFAULT_SENSITIVE_APPS) {
      expect(privacyConfig.sensitiveApps).toContain(app);
    }
  });

  it('starts hiddenApps empty and adds only what the config specifies (no built-in default to preserve)', () => {
    applyPrivacyConfig({ redactionTier: 2, extraSensitiveApps: [], extraHiddenApps: ['SomeApp', 'OtherApp'], extraShellRedactPatterns: [] });
    expect(privacyConfig.hiddenApps).toEqual(['SomeApp', 'OtherApp']);
  });

  it('adds to shellRedactPatterns without removing the built-in secret-redaction patterns', () => {
    const before = privacyConfig.shellRedactPatterns.length;
    applyPrivacyConfig({ redactionTier: 2, extraSensitiveApps: [], extraHiddenApps: [], extraShellRedactPatterns: ['(?i)my-custom-secret\\s*=\\s*\\S+'] });
    expect(privacyConfig.shellRedactPatterns.length).toBe(before + 1);
    expect(privacyConfig.shellRedactPatterns.some((p) => p.includes('bearer'))).toBe(true);
    expect(privacyConfig.shellRedactPatterns).toContain('(?i)my-custom-secret\\s*=\\s*\\S+');
  });

  it('is idempotent — calling it twice with the same overrides does not duplicate entries', () => {
    const overrides = { redactionTier: 2 as const, extraSensitiveApps: ['dup-app'], extraHiddenApps: [], extraShellRedactPatterns: [] };
    applyPrivacyConfig(overrides);
    const firstLength = privacyConfig.sensitiveApps.length;
    applyPrivacyConfig(overrides);
    expect(privacyConfig.sensitiveApps.length).toBe(firstLength);
  });
});
