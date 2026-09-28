// Single config-bound facade for redaction. All callers should use these
// helpers instead of reading `privacyConfig` directly, so the policy lives
// in exactly one place.

import { privacyConfig } from '../privacy-config.js';
import { isSensitiveProcessName, redact, redactLines, truncate } from './redact.js';
import { noteShellRedaction } from './redaction-telemetry.js';
import { redactPii } from './redact-pii.js';
import { stripEmbeddedUrlQueries } from './redact-url.js';
import { detectAndLearnSensitiveApp, effectiveSensitiveApps, getRedactionTier } from './redaction-tier.js';

export function redactWithPolicy(text: string, surface: 'ingest' | 'persist' | 'egress' = 'ingest'): string {
  const out = redactPii(redact(text, privacyConfig.shellRedactPatterns, privacyConfig.shellRedactReplacement));
  if (out !== text) noteShellRedaction(text, out, surface);
  return out;
}

export function redactLinesWithPolicy(lines: string[]): string[] {
  return redactLines(lines, privacyConfig.shellRedactPatterns, privacyConfig.shellRedactReplacement);
}

/**
 * Tier-aware sensitive-app check: tier 1 masks only strictly sensitive
 * defaults + user-added entries; tier 2 uses the configured list; tier 3
 * adds learned apps and auto-learns processes whose names look sensitive.
 */
export function isSensitiveProcess(processName: string): boolean {
  const tier = getRedactionTier();
  if (isSensitiveProcessName(processName, effectiveSensitiveApps(tier))) return true;
  return tier === 3 && detectAndLearnSensitiveApp(processName);
}

/**
 * Hidden-app check — stricter than sensitive. When true, every LLM-visible
 * surface strips the process entirely (name + duration + derived content).
 * The log still stores raw values; only downstream read boundaries apply
 * this filter (see docs/design/01-events-and-log.md's sanitize-at-ingest,
 * which applies this at write time already for the fields it touches).
 */
export function isHiddenProcess(processName: string): boolean {
  const list = privacyConfig.hiddenApps;
  if (!list || list.length === 0) return false;
  return isSensitiveProcessName(processName, list);
}

/**
 * `[private]` for sensitive apps; otherwise the title with any embedded
 * `http(s)://…` URL query strings stripped per the redaction tier.
 */
export function windowTitleForEgress(processName: string, windowTitle: string): string {
  if (isSensitiveProcess(processName)) return '[private]';
  return stripEmbeddedUrlQueries(windowTitle);
}

/** Redact, then optionally truncate with ellipsis. */
export function redactAndTruncate(text: string, max: number): string {
  return truncate(redactWithPolicy(text), max);
}

/**
 * E3 (docs/audit/production-proposal-and-enhancements.md, fixes A§6.3) —
 * the two placeholder strings `sanitizeAtIngest` ever writes in place of
 * real content (`windowTitleForEgress` above, and the hidden-process
 * blanking in `sanitize-at-ingest.ts`). Centralized here so a rule
 * deciding "is there anything real to analyze/embed/extract from this
 * value" checks the same two strings sanitize-at-ingest actually produces,
 * rather than each call site hardcoding its own copy.
 */
export function isRedactedPlaceholder(value: string): boolean {
  return value === '[private]' || value === '[hidden]';
}

export { truncate } from './redact.js';
