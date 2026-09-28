// The cache is the whole plugin-side design: dsh resolves a context
// synchronously, the slice is built from the database, and the two meet in a
// string that is refreshed behind the turn. These pin that meeting.
import { describe, it, expect, vi } from 'vitest';
import { createAmbientContext, AMBIENT_CONTEXT_NAME, AMBIENT_CONTEXT_ORDER } from './ambient.js';

describe('createAmbientContext', () => {
  it('contributes nothing until the first refresh lands, then the built text', async () => {
    const ambient = createAmbientContext({ build: async () => 'About the owner: wakes at 06:30', refreshMs: 0 });
    expect(ambient.context.text()).toBe('');
    expect(ambient.refreshedAt()).toBeNull();
    await ambient.refresh();
    expect(ambient.context.text()).toBe('About the owner: wakes at 06:30');
    expect(ambient.refreshedAt()).not.toBeNull();
  });

  it('keeps the previous text when a refresh fails, and reports the error', async () => {
    let calls = 0;
    const onError = vi.fn();
    const ambient = createAmbientContext({
      build: async () => {
        calls += 1;
        if (calls === 2) throw new Error('database went away');
        return `slice ${calls}`;
      },
      onError,
      refreshMs: 0,
    });
    await ambient.refresh();
    await ambient.refresh();
    expect(ambient.context.text()).toBe('slice 1');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent refreshes into one build', async () => {
    let builds = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const ambient = createAmbientContext({
      build: async () => {
        builds += 1;
        await gate;
        return 'built';
      },
      refreshMs: 0,
    });
    const first = ambient.refresh();
    const second = ambient.refresh();
    expect(first).toBe(second);
    release();
    await first;
    expect(builds).toBe(1);
  });

  it('sits just after the clock and is torn down with its timer', () => {
    const setTimer = vi.fn(() => 'timer-handle');
    const clearTimer = vi.fn();
    const ambient = createAmbientContext({ build: async () => '', refreshMs: 1000, setTimer, clearTimer });
    expect(ambient.context).toMatchObject({ name: AMBIENT_CONTEXT_NAME, order: AMBIENT_CONTEXT_ORDER });
    expect(AMBIENT_CONTEXT_ORDER).toBeGreaterThan(-50);
    expect(AMBIENT_CONTEXT_ORDER).toBeLessThan(0);
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 1000);
    ambient.dispose();
    expect(clearTimer).toHaveBeenCalledWith('timer-handle');
  });
});
