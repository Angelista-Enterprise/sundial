import { describe, it, expect, vi } from 'vitest';
import { createBrowserSupervisor, headlessArgs, resolveChromePath, CHROME_CANDIDATES } from './launcher.js';

/** A spawn stand-in whose child never exits on its own. */
function fakeSpawn() {
  const calls = [];
  const spawnProcess = vi.fn((command, args) => {
    calls.push({ command, args });
    return { on: vi.fn(), kill: vi.fn() };
  });
  return { calls, spawnProcess };
}

function supervisorWith(overrides = {}) {
  const { spawnProcess, calls } = fakeSpawn();
  const supervisor = createBrowserSupervisor({
    chromePath: '/fake/Chrome',
    spawnProcess,
    startTimeoutMs: 500,
    ...overrides,
  });
  return { supervisor, spawnProcess, calls };
}

describe('resolveChromePath', () => {
  it('honors SUNDIAL_CHROME_PATH when it exists, and refuses it when it does not', () => {
    expect(resolveChromePath(CHROME_CANDIDATES, { SUNDIAL_CHROME_PATH: '/definitely/not/here' })).toBeNull();
  });

  it('returns null rather than guessing when nothing is installed', () => {
    expect(resolveChromePath(['/nope/a', '/nope/b'], {})).toBeNull();
  });
});

describe('headlessArgs', () => {
  it('sets the port, an isolated profile, and headless mode', () => {
    const args = headlessArgs(9223, '/tmp/profile');
    expect(args).toContain('--remote-debugging-port=9223');
    expect(args).toContain('--user-data-dir=/tmp/profile');
    expect(args).toContain('--headless=new');
  });

  it('carries no anti-detection flags — Gnomon does not disguise itself', () => {
    const joined = headlessArgs(9223, '/tmp/p').join(' ');
    for (const forbidden of ['--disable-blink-features=AutomationControlled', '--user-agent', 'excludeSwitches', '--disable-web-security']) {
      expect(joined).not.toContain(forbidden);
    }
  });
});

describe('createBrowserSupervisor', () => {
  it("attaches to the owner's own browser when one answers, and launches nothing", async () => {
    const { supervisor, spawnProcess } = supervisorWith({ probe: async (endpoint) => endpoint === 'http://127.0.0.1:9222' });

    expect(await supervisor.resolve()).toEqual({ endpoint: 'http://127.0.0.1:9222', managed: false });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('launches a managed headless browser when nothing is listening', async () => {
    let launched = false;
    const { supervisor, calls } = supervisorWith({
      probe: async (endpoint) => launched && endpoint === 'http://127.0.0.1:9223',
      spawnProcess: vi.fn((command, args) => {
        launched = true;
        calls?.push?.({ command, args });
        return { on: vi.fn(), kill: vi.fn() };
      }),
    });

    const resolved = await supervisor.resolve();
    expect(resolved).toEqual({ endpoint: 'http://127.0.0.1:9223', managed: true });
  });

  it('launches ONCE for concurrent requests', async () => {
    let launched = false;
    const spawnProcess = vi.fn(() => {
      launched = true;
      return { on: vi.fn(), kill: vi.fn() };
    });
    const supervisor = createBrowserSupervisor({
      chromePath: '/fake/Chrome',
      spawnProcess,
      probe: async (endpoint) => launched && endpoint.endsWith('9223'),
      startTimeoutMs: 500,
    });

    await Promise.all([supervisor.resolve(), supervisor.resolve(), supervisor.resolve()]);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it('never kills a browser it did not start', async () => {
    const { supervisor, spawnProcess } = supervisorWith({ probe: async (e) => e.endsWith('9222') });
    await supervisor.resolve();
    supervisor.stop();
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(supervisor.isManaging).toBe(false);
  });

  it('kills the browser it did start', async () => {
    let launched = false;
    const kill = vi.fn();
    const supervisor = createBrowserSupervisor({
      chromePath: '/fake/Chrome',
      spawnProcess: vi.fn(() => {
        launched = true;
        return { on: vi.fn(), kill };
      }),
      probe: async (e) => launched && e.endsWith('9223'),
      startTimeoutMs: 500,
    });

    await supervisor.resolve();
    expect(supervisor.isManaging).toBe(true);
    supervisor.stop();
    expect(kill).toHaveBeenCalled();
  });

  it('explains what to do when no browser exists to launch', async () => {
    const supervisor = createBrowserSupervisor({ chromePath: null, probe: async () => false, startTimeoutMs: 200 });
    await expect(supervisor.resolve()).rejects.toThrow(/SUNDIAL_CHROME_PATH|install one/);
  });

  it('with launching disabled, names the port and the exact command to run', async () => {
    const { supervisor } = supervisorWith({ allowLaunch: false, probe: async () => false });
    await expect(supervisor.resolve()).rejects.toThrow(/remote-debugging-port=9222/);
  });
});
