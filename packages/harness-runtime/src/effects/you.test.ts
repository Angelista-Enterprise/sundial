import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { KernelRuntime } from '../runtime.js';
import { APP_COMMANDS } from '../app-channel.js';
import { EFFECT_HANDLERS } from './index.js';

const before = process.env.SUNDIAL_HOME;
afterEach(() => {
  if (before === undefined) delete process.env.SUNDIAL_HOME;
  else process.env.SUNDIAL_HOME = before;
});

describe('Speak and Mark (plan 15, 2.3)', () => {
  it('hand the app one command each, the voice from the owner config', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sundial-you-'));
    process.env.SUNDIAL_HOME = home;
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ voice: { engine: 'system', name: 'Ava' } }));
    const host = {} as KernelRuntime;
    EFFECT_HANDLERS.Speak(host, { type: 'Speak', text: 'Mira Bakker is waiting.', sound: 'knock', mode: 'knock-wait', noticeKey: 'pr:box-484' });
    EFFECT_HANDLERS.Mark(host, { type: 'Mark', marks: [] });
    const lines = fs.readFileSync(path.join(home, '.daemon', APP_COMMANDS), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toMatchObject([
      { type: 'speak', text: 'Mira Bakker is waiting.', sound: 'knock', mode: 'knock-wait', noticeKey: 'pr:box-484', voice: { engine: 'system', name: 'Ava' } },
      { type: 'marks', marks: [] },
    ]);
  });
});
