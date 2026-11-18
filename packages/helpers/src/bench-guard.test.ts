// benchSetup: the bench marker only on the bench install (the refusals themselves: plugins/sundial-theme/host/bench-guard.test.js).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BENCH_LABEL, benchSetup } from './bench-guard.js';

function homeWith(dir: string, label: string) {
  const home = mkdtempSync(join(tmpdir(), 'bench-setup-'));
  const at = join(home, dir);
  mkdirSync(at);
  writeFileSync(join(at, '.sundial-install.json'), JSON.stringify({ tool: 'sundial', home: at, label }));
  writeFileSync(join(at, 'bench.json'), JSON.stringify({ bench: true, home: at, label, fence: true, holdClock: true }));
  return { home, at };
}

describe('benchSetup', () => {
  it('reads the marker on the bench install', () => {
    const { home, at } = homeWith('.sundial-bench', BENCH_LABEL);
    expect(benchSetup({ env: { SUNDIAL_LABEL: BENCH_LABEL, SUNDIAL_HOME: at }, home })).toMatchObject({ fence: true, holdClock: true });
  });

  it("is null on the owner's install, whatever its folder holds", () => {
    const { home, at } = homeWith('.sundial', BENCH_LABEL);
    expect(benchSetup({ env: { SUNDIAL_LABEL: BENCH_LABEL, SUNDIAL_HOME: at }, home })).toBeNull();
    expect(benchSetup({ env: { SUNDIAL_LABEL: 'dev.sundial.daemon', SUNDIAL_HOME: at }, home })).toBeNull();
    expect(benchSetup({ env: {}, home })).toBeNull();
  });
});
