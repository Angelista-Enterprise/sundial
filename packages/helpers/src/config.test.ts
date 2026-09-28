import { afterEach, describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { getDbUrl, getSundialHome } from './config.js';

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
