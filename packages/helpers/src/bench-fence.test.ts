// The bench fence (lab/bench): the private-app list emptied only on the bench install whose marker asks for it. On the
// owner's install, or any other, the list is what it always was, whatever a marker in that folder says. Made-up folders only.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BENCH_LABEL, benchSetup } from './bench-guard.js';
import { applyPrivacyConfig, benchFence, DEFAULT_SENSITIVE_APPS, privacyConfig } from './privacy-config.js';
import { privateAppName, privateApps } from './redact/redact-policy.js';

const PLAIN = { redactionTier: 2 as const, extraSensitiveApps: ['puzzlebox'], extraHiddenApps: ['hidden-box'], extraShellRedactPatterns: [] };

function homeWith(dir: string, label: string, fence: boolean) {
  const home = mkdtempSync(join(tmpdir(), 'bench-fence-'));
  const at = join(home, dir);
  mkdirSync(at);
  writeFileSync(join(at, '.sundial-install.json'), JSON.stringify({ tool: 'sundial', home: at, label }));
  writeFileSync(join(at, 'bench.json'), JSON.stringify({ bench: true, home: at, label, fence }));
  return { home, at };
}
const fenceOf = (env: NodeJS.ProcessEnv, home: string) => benchFence(() => benchSetup({ env, home }));

afterEach(() => applyPrivacyConfig({ redactionTier: 2, extraSensitiveApps: [], extraHiddenApps: [], extraShellRedactPatterns: [] }, false));

describe('benchFence', () => {
  it('holds on the bench install whose marker says fence', () => {
    const { home, at } = homeWith('.sundial-bench', BENCH_LABEL, true);
    expect(fenceOf({ SUNDIAL_LABEL: BENCH_LABEL, SUNDIAL_HOME: at }, home)).toBe(true);
  });

  it('does not hold on the bench install as shipped (fence false)', () => {
    const { home, at } = homeWith('.sundial-bench', BENCH_LABEL, false);
    expect(fenceOf({ SUNDIAL_LABEL: BENCH_LABEL, SUNDIAL_HOME: at }, home)).toBe(false);
  });

  it("never holds on the owner's install, even with a fence marker in its folder or the bench label set by hand", () => {
    const { home, at } = homeWith('.sundial', BENCH_LABEL, true);
    expect(fenceOf({ SUNDIAL_LABEL: BENCH_LABEL, SUNDIAL_HOME: at }, home)).toBe(false);
    expect(fenceOf({ SUNDIAL_LABEL: 'dev.sundial.daemon', SUNDIAL_HOME: at }, home)).toBe(false);
    expect(fenceOf({}, home)).toBe(false);
  });

  it('never holds in this test process (not the bench): the default probe', () => {
    expect(benchFence()).toBe(false);
  });
});

describe('applyPrivacyConfig under the fence', () => {
  it('empties the sensitive and hidden lists, and keeps the shell patterns and private hosts', () => {
    applyPrivacyConfig(PLAIN, true);
    expect(privacyConfig.sensitiveApps).toEqual([]);
    expect(privacyConfig.hiddenApps).toEqual([]);
    expect(privateApps()).toEqual([]);
    expect(privateAppName('Notes')).toBe(false);
    expect(privacyConfig.shellRedactPatterns.length).toBeGreaterThan(0);
    expect(privacyConfig.privateHosts.length).toBeGreaterThan(0);
  });

  it("as shipped (the owner's default call): every default and the owner's own entries", () => {
    applyPrivacyConfig(PLAIN);
    for (const app of DEFAULT_SENSITIVE_APPS) expect(privacyConfig.sensitiveApps).toContain(app);
    expect(privacyConfig.sensitiveApps).toContain('puzzlebox');
    expect(privacyConfig.hiddenApps).toEqual(['hidden-box']);
    expect(privateAppName('Notes')).toBe(true);
  });
});
