import { afterEach, describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { getDbUrl, getSundialHome, withConfigLock, writeConfigAtomic } from './config.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('getSundialHome', () => {
  it('defaults to ~/.sundial', () => {
    delete process.env.SUNDIAL_HOME;
    expect(getSundialHome()).toBe(path.join(os.homedir(), '.sundial'));
  });

  it('honours SUNDIAL_HOME, read per call', () => {
    process.env.SUNDIAL_HOME = '/tmp/sundial-fixture';
    expect(getSundialHome()).toBe('/tmp/sundial-fixture');
  });
});

describe('getDbUrl', () => {
  it('uses DATABASE_URL when set, regardless of SUNDIAL_HOME', () => {
    process.env.DATABASE_URL = 'file:/tmp/some-scratch.db';
    process.env.SUNDIAL_HOME = '/tmp/should-be-ignored';
    expect(getDbUrl()).toBe('file:/tmp/some-scratch.db');
  });

  it('falls back to sundial.db in SUNDIAL_HOME when DATABASE_URL is unset', () => {
    delete process.env.DATABASE_URL;
    process.env.SUNDIAL_HOME = '/tmp/sundial-fixture';
    expect(getDbUrl()).toBe('file:/tmp/sundial-fixture/sundial.db');
  });
});

describe('writeConfigAtomic (hardening S7)', () => {
  it('replaces the file whole, 0600, and leaves no temp file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sundial-config-'));
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{"old":true}\n', { mode: 0o644 });
    await writeConfigAtomic(file, { llm: { providers: [] }, ownerAliases: ['Mira Bakker'] });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ llm: { providers: [] }, ownerAliases: ['Mira Bakker'] });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a failed write leaves the old file as it was and no temp file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sundial-config-'));
    const target = path.join(dir, 'config.json');
    fs.mkdirSync(target); // a rename over a folder fails
    await expect(writeConfigAtomic(target, { a: 1 })).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('withConfigLock', () => {
  it('runs read-modify-write cycles one at a time, so two concurrent changes both land', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-lock-')), 'config.json');
    fs.writeFileSync(file, '{}');
    const toggle = (key: string) =>
      withConfigLock(async () => {
        const config = JSON.parse(fs.readFileSync(file, 'utf8'));
        await new Promise((r) => setTimeout(r, 5));
        await writeConfigAtomic(file, { ...config, [key]: 1 });
      });
    await Promise.all([toggle('a'), toggle('b')]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 1, b: 1 });
    // A failed cycle does not jam the ones after it.
    await expect(withConfigLock(async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(withConfigLock(async () => 7)).resolves.toBe(7);
  });
});
