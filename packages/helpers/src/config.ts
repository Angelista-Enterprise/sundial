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
 * `DATABASE_URL` overrides the default when set (a scratch DB for a one-off
 * verification script). Without that override, several "scratch DB" checks
 * once wrote into the real database the running process was using.
 */
export function getDbUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  return `file:${path.join(getSundialHome(), 'sundial.db')}`;
}
