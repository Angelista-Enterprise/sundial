/**
 * Redaction tiers — `privacyConfig.redactionTier` (1-3) controls how
 * aggressively paths, URLs, and app identities are rewritten. Secret patterns
 * (`shellRedactPatterns`) are tier-independent and always apply.
 *
 * - Tier 1 (loose): paths/URLs pass through raw; only strictly sensitive
 *   defaults (password managers, finance, health) + user-added apps mask.
 * - Tier 2 (standard, default): the historical policy — `~` path rewrite,
 *   URL query stripping, full sensitive-app list.
 * - Tier 3 (aggressive): URLs -> origin/host, deep paths collapsed, and the
 *   sensitive-app list auto-grows: processes whose names look sensitive are
 *   persisted to `~/.sundial/.daemon/learned-sensitive-apps.json` and masked
 *   from then on (survives restarts, unioned with the configured list).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_SENSITIVE_APPS, STRICT_SENSITIVE_APPS, privacyConfig } from '../privacy-config.js';
import { getSundialHome } from '../config.js';
import { recordRedaction } from './redaction-telemetry.js';

export type RedactionTier = 1 | 2 | 3;

export function getRedactionTier(): RedactionTier {
  const t = privacyConfig.redactionTier;
  return t === 1 || t === 3 ? t : 2;
}

// ---------------------------------------------------------------------------
// Tier-3 learned sensitive apps
// ---------------------------------------------------------------------------

const SENSITIVE_NAME_HINTS = [
  'bank', 'wallet', 'crypto', 'coinbase', 'robinhood', 'finance',
  'password', 'vault', 'keychain', 'authenticator', 'otp', '2fa',
  'medical', 'clinic', 'pharmac', 'therap', 'psychiat',
  'dating', 'tinder', 'bumble', 'hinge',
  'diary', 'journal',
  'tax', 'insurance',
];

let learnedFile = path.join(getSundialHome(), '.daemon', 'learned-sensitive-apps.json');
let learnedCache: Set<string> | null = null;

function loadLearned(): Set<string> {
  if (learnedCache) return learnedCache;
  try {
    const raw = JSON.parse(fs.readFileSync(learnedFile, 'utf8'));
    learnedCache = new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    learnedCache = new Set();
  }
  return learnedCache;
}

function persistLearned(apps: Set<string>): void {
  try {
    fs.mkdirSync(path.dirname(learnedFile), { recursive: true });
    fs.writeFileSync(learnedFile, JSON.stringify([...apps].sort(), null, 2));
  } catch (error) {
    // Best-effort: the in-memory set still masks for this process lifetime —
    // but the learning is lost on restart, so surface the failure rather than
    // letting an app silently stop being treated as sensitive after a bounce.
    console.warn(`[gnomon] failed to persist learned sensitive apps to ${learnedFile} (masking this session only, lost on restart):`, error);
  }
}

export function getLearnedSensitiveApps(): string[] {
  return [...loadLearned()];
}

/**
 * Tier-3 auto-grow: if `processName` looks sensitive by name, record it in
 * the learned list (persisted) and report it as sensitive.
 */
export function detectAndLearnSensitiveApp(processName: string): boolean {
  const name = processName.trim().toLowerCase();
  if (!name || name.length > 64) return false;
  if (!SENSITIVE_NAME_HINTS.some((hint) => name.includes(hint))) return false;
  const learned = loadLearned();
  if (!learned.has(name)) {
    learned.add(name);
    persistLearned(learned);
    recordRedaction('ingest', 'sensitive-app-learned');
  }
  return true;
}

/**
 * The sensitive-app list in force for `tier`:
 * - 1: configured entries that are strictly sensitive defaults, plus every
 *   user-added entry (anything not on the default list — explicit intent).
 * - 2: the configured list as-is.
 * - 3: the configured list unioned with tier-3 learned apps.
 */
export function effectiveSensitiveApps(tier: RedactionTier = getRedactionTier()): string[] {
  const configured = privacyConfig.sensitiveApps;
  if (tier === 1) {
    const defaults = new Set<string>(DEFAULT_SENSITIVE_APPS);
    const strict = new Set<string>(STRICT_SENSITIVE_APPS);
    return configured.filter((app) => strict.has(app) || !defaults.has(app));
  }
  if (tier === 3) {
    return [...new Set([...configured, ...loadLearned()])];
  }
  return configured;
}

/** Test hook: point the learned-apps store at a scratch file and reset the cache. */
export function __setLearnedSensitiveAppsFileForTests(filePath: string): void {
  learnedFile = filePath;
  learnedCache = null;
}
