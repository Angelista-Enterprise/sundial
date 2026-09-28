import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getBrowserHelperPath } from './sundial-paths.js';

const saved = { home: process.env.SUNDIAL_HOME, app: process.env.SUNDIAL_APP_PATH };
afterEach(() => {
  for (const [key, value] of [['SUNDIAL_HOME', saved.home], ['SUNDIAL_APP_PATH', saved.app]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('getBrowserHelperPath', () => {
  const tail = path.join('SundialBrowserHelper.app', 'Contents', 'MacOS', 'sundial-browser-helper');

  it('uses the helper inside the app when the app carries one', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sundial-paths-'));
    const app = path.join(root, 'Sundial.app');
    const inside = path.join(app, 'Contents', 'Helpers', tail);
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    fs.writeFileSync(inside, '');
    process.env.SUNDIAL_HOME = path.join(root, 'home');
    process.env.SUNDIAL_APP_PATH = app;
    expect(getBrowserHelperPath()).toBe(inside);
  });

  it('falls back to the data folder for a checkout install', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sundial-paths-'));
    process.env.SUNDIAL_HOME = path.join(root, 'home');
    process.env.SUNDIAL_APP_PATH = path.join(root, 'Sundial.app');
    expect(getBrowserHelperPath()).toBe(path.join(root, 'home', tail));
  });
});
