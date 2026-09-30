import { config as loadDotenv, parse } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { getSundialHome } from './config.js';

/** Single env file for all Sundial processes (web, sidecars, MCP, tests). */
export const SUNDIAL_ENV_FILE = path.join(getSundialHome(), '.env');

let loaded = false;

/**
 * Load `$SUNDIAL_HOME/.env` once. Existing `process.env` values win (shell
 * exports, test overrides). This is the only `.env` file Sundial reads.
 */
export function loadSundialEnv(): void {
  if (loaded) return;
  loaded = true;

  // dotenv no-ops when the file is missing — no existsSync needed.
  loadDotenv({ path: SUNDIAL_ENV_FILE, quiet: true });

  warnIfLegacyRepoEnv();
}

/**
 * W3: the one `.env` parser. `$SUNDIAL_HOME/.env` (or `file`) as a plain map,
 * by dotenv's own parser (quotes, `export`, comments), never merged into
 * `process.env`: the caller decides whether a shell export wins. A missing
 * file is an empty map. Resolved per call, so a test's `SUNDIAL_HOME` holds.
 */
export function readSundialEnvFile(file = path.join(getSundialHome(), '.env')): Record<string, string> {
  try {
    return parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function warnIfLegacyRepoEnv(): void {
  if (process.env.VITEST) return;
  const legacy = path.join(process.cwd(), '.env');
  if (!fs.existsSync(legacy) || fs.existsSync(SUNDIAL_ENV_FILE)) return;
  console.warn(`[sundial] Found a repo-root .env — Sundial only loads ${SUNDIAL_ENV_FILE}. Move secrets there.`);
}

// Eager load so importers of @sundial/helpers/config see env before config parse.
loadSundialEnv();
