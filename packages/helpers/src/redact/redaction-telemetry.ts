/**
 * In-process redaction telemetry — rolling 24h counters + audit tail.
 * Trimmed to what sanitize-at-ingest actually uses; WCS's `moment-sanitize`
 * counter is dropped (no moments concept exists until Phase 2).
 */

export type RedactionSurface = 'ingest' | 'persist' | 'egress';

export interface RedactionAuditEntry {
  timestamp: string;
  surface: RedactionSurface;
  kind: string;
  matchCount: number;
}

export interface EgressCounts24h {
  sensitiveAppRedactions: number;
  shellRegexRedactions: number;
}

const TAIL_MAX = 50;
const MS_24H = 24 * 60 * 60 * 1000;

const tail: RedactionAuditEntry[] = [];
const counters: EgressCounts24h = {
  sensitiveAppRedactions: 0,
  shellRegexRedactions: 0,
};

let counterWindowStart = Date.now();

function maybeResetCounters(): void {
  if (Date.now() - counterWindowStart >= MS_24H) {
    counters.sensitiveAppRedactions = 0;
    counters.shellRegexRedactions = 0;
    counterWindowStart = Date.now();
  }
}

export function recordRedaction(surface: RedactionSurface, kind: string, matchCount = 1): void {
  maybeResetCounters();
  const n = Math.max(1, matchCount);
  if (kind === 'sensitive-app') counters.sensitiveAppRedactions += n;
  else if (kind === 'shell-regex') counters.shellRegexRedactions += n;

  tail.unshift({ timestamp: new Date().toISOString(), surface, kind, matchCount: n });
  if (tail.length > TAIL_MAX) tail.length = TAIL_MAX;
}

export function noteShellRedaction(before: string, after: string, surface: RedactionSurface): void {
  if (before !== after) recordRedaction(surface, 'shell-regex');
}

export function noteSensitiveAppRedaction(surface: RedactionSurface): void {
  recordRedaction(surface, 'sensitive-app');
}

export function getRedactionCounters(): EgressCounts24h {
  maybeResetCounters();
  return { ...counters };
}

export function getRedactionAuditTail(): RedactionAuditEntry[] {
  return [...tail];
}
