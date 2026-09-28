import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The focus gate belongs to the history path only.
 *
 * The 2026-08-16 tooling audit found agent-run commands absent from
 * `gnomon_signals(shell)`. Two causes stacked: nothing wrote the hook file, and
 * even once written the sensor would not read it unless a TERMINAL was the
 * focused window — which it never is while an agent works and the owner watches
 * a browser. These tests pin the second half.
 */
let scratchDir: string;
let hookPath: string;

/** `getShellHookFilePath()` is resolved at import time by the sensor's own default, so point it at scratch. */
vi.mock('@sundial/helpers/sundial-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sundial/helpers/sundial-paths.js')>();
  return { ...actual, getShellHookFilePath: () => process.env.SUNDIAL_TEST_HOOK_PATH ?? '/nonexistent/hook.jsonl' };
});

const { ShellSensor } = await import('./index.js');

const BROWSER = 'Google Chrome';
const TERMINAL = 'Terminal';

function writeHookLine(command: string): void {
  fs.appendFileSync(hookPath, `${JSON.stringify({ c: command, d: '/repo', e: 0, t: new Date().toISOString() })}\n`);
}

beforeEach(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnomon-shell-sensor-'));
  hookPath = path.join(scratchDir, 'shell-events.jsonl');
  process.env.SUNDIAL_TEST_HOOK_PATH = hookPath;
});

afterEach(() => {
  delete process.env.SUNDIAL_TEST_HOOK_PATH;
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe('ShellSensor with a hook file', () => {
  it('reads commands while a BROWSER is focused — the regression the audit found', () => {
    fs.writeFileSync(hookPath, '');
    const sensor = new ShellSensor();
    sensor.poll(BROWSER);

    writeHookLine('npm test');
    const events = sensor.poll(BROWSER);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('shell:command');
    expect(events[0].payload.command).toBe('npm test');
    expect(events[0].payload.cwd).toBe('/repo');
    expect(events[0].payload.exitCode).toBe(0);
  });

  it('reads commands with NOTHING focused at all', () => {
    fs.writeFileSync(hookPath, '');
    const sensor = new ShellSensor();
    sensor.poll(null);

    writeHookLine('git status');
    expect(sensor.poll(null).map((e) => e.payload.command)).toEqual(['git status']);
  });

  it('adopts a hook file that appears AFTER boot, without losing its first command', () => {
    // No hook file at construction — the daemon routinely starts before the
    // first command of the day is ever run.
    const sensor = new ShellSensor();
    expect(sensor.poll(BROWSER)).toEqual([]);

    writeHookLine('first command of the day');
    expect(sensor.poll(BROWSER).map((e) => e.payload.command)).toEqual(['first command of the day']);
  });

  it('seeks past a pre-existing backlog at boot, so an old file is not replayed', () => {
    writeHookLine('yesterdays command');
    const sensor = new ShellSensor();

    expect(sensor.poll(BROWSER)).toEqual([]);

    writeHookLine('todays command');
    expect(sensor.poll(BROWSER).map((e) => e.payload.command)).toEqual(['todays command']);
  });

  it('does not re-emit a command on a later tick', () => {
    fs.writeFileSync(hookPath, '');
    const sensor = new ShellSensor();
    sensor.poll(BROWSER);

    writeHookLine('once');
    expect(sensor.poll(BROWSER)).toHaveLength(1);
    expect(sensor.poll(BROWSER)).toHaveLength(0);
  });
});

describe('ShellSensor with no hook file (history fallback)', () => {
  it('stays focus-gated — a history line carries no cwd, so the focused window is the only evidence', () => {
    const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnomon-home-'));
    const history = path.join(historyDir, '.zsh_history');
    fs.writeFileSync(history, '');

    // Point HOME at the scratch home so `detectHistoryFile` finds this file.
    const realHome = process.env.HOME;
    process.env.HOME = historyDir;
    try {
      const sensor = new ShellSensor();
      sensor.poll(TERMINAL); // init on the history path

      fs.appendFileSync(history, ': 1690000000:0;echo typed\n');
      expect(sensor.poll(BROWSER)).toEqual([]); // unfocused: nothing
      expect(sensor.poll(TERMINAL).map((e) => e.payload.command)).toEqual([]); // re-focus re-seeks past it

      fs.appendFileSync(history, ': 1690000001:0;echo after\n');
      expect(sensor.poll(TERMINAL).map((e) => e.payload.command)).toEqual(['echo after']);
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
      fs.rmSync(historyDir, { recursive: true, force: true });
    }
  });
});
