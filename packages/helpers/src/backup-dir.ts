// lane H (H6)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSundialHome } from './config.js';

/** Backups kept; older ones go. */
export const BACKUPS_KEPT = 7;
export const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}\.db$/;

/**
 * Where the daily copies go. The owner's install keeps them beside the
 * migration backups in `~/sundial-backups/daily`; any other home (a test
 * install, a test run) keeps them inside itself, so it never writes there.
 */
export function backupDir(home = getSundialHome()): string {
  return path.resolve(home) === path.join(os.homedir(), '.sundial') ? path.join(os.homedir(), 'sundial-backups', 'daily') : path.join(home, 'backups', 'daily');
}

/** The newest backup's date (`YYYY-MM-DD`), or null. For Settings. */
export function lastBackupDate(dir = backupDir()): string | null {
  try {
    const names = fs.readdirSync(dir).filter((n) => BACKUP_NAME.test(n)).sort();
    return names.length > 0 ? names[names.length - 1]!.slice(0, 10) : null;
  } catch {
    return null;
  }
}

