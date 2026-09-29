import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Sundial's data folder — config.json, the database, .env, the sidecar
 * runtime dir, and the app bundle all live here. `SUNDIAL_HOME` moves it
 * (the installer's test runs and CI use a temp folder); the default is
 * `~/.sundial`. Resolved per call, not at import, so a test or a launcher can
 * set the variable after this module loads.
 *
 * An install from before the rename lives in `~/.sundial`; it is never read
 * implicitly. `sundial migrate` copies it here.
 */
export function getSundialHome(): string {
  return process.env.SUNDIAL_HOME || path.join(os.homedir(), '.sundial');
}

export function getSundialConfigPath(): string {
  return path.join(getSundialHome(), 'config.json');
}

/**
 * Write config.json whole or not at all: a temp file beside it, then a rename,
 * so a crash or a second writer never leaves half a file, which the next boot
 * would read as "no config" and run on every default. Mode 0600 on every
 * write, not only the first. The one writer for the web client's routes.
 */
/**
 * One read-modify-write of config.json at a time, in this process. The write is
 * atomic, but two requests that each read, change and write would still lose
 * one change; every writer runs its whole cycle inside this.
 */
let configChain: Promise<unknown> = Promise.resolve();
export function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = configChain.then(fn, fn);
  configChain = run.catch(() => undefined);
  return run;
}

export async function writeConfigAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/**
 * `DATABASE_URL` overrides the default when set (a scratch DB for a one-off
 * verification script). Without that override, several "scratch DB" checks
 * once wrote into the real database the running process was using.
 */
export function getDbUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  return `file:${path.join(getSundialHome(), 'sundial.db')}`;
}
