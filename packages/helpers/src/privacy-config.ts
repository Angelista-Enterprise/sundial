/**
 * Small, hardcoded-default privacy config — not WCS's ~800-line Zod-validated
 * monolith. Covers exactly what the redaction primitives need.
 *
 * C4 (docs/audit/production-proposal-and-enhancements.md, fixes A§6.1)
 * activates `~/.sundial/config.json` overrides via `applyPrivacyConfig`,
 * called once at daemon start (`sundial-config.ts`'s `loadSundialConfig` +
 * this function). Every consumer below (`redact-policy.ts`,
 * `redaction-tier.ts`) reads `privacyConfig.<field>` fresh at call time, not
 * a value captured at import time — mutating this object's fields in place
 * is what makes the override visible everywhere without threading a config
 * object through every redaction call site.
 */

export const STRICT_SENSITIVE_APPS = [
  '1password', 'bitwarden', 'keepassxc', 'lastpass', 'dashlane',
  'banking', 'venmo', 'paypal',
  'health', 'myfitnesspal',
] as const;

/** Full default sensitive-app list (tier >= 2). */
export const DEFAULT_SENSITIVE_APPS = [
  'whatsapp', 'messages', 'telegram', 'signal', 'messenger',
  'slack', 'discord',
  'mail', 'zoom', 'facetime',
  ...STRICT_SENSITIVE_APPS,
] as const;

export interface PrivacyConfig {
  shellRedactPatterns: string[];
  shellRedactReplacement: string;
  sensitiveApps: string[];
  hiddenApps: string[];
  blockedProcesses: string[];
  redactionTier: 1 | 2 | 3;
}

const DEFAULT_SHELL_REDACT_PATTERNS = [
  '(?i)(password|passwd|secret|token|api.?key|auth|credential)\\s*[=:]\\s*\\S+',
  '(?i)bearer\\s+\\S+',
  '(?i)--(password|token|secret|api-key|access-key|secret-key)[= ]\\S+',
  '(?i)-H\\s+["\']?Authorization:\\s*[^"\'\\s]+["\']?',
  '(?i)-H\\s+Authorization:\\s*\\S+',
  '(?i)curl[^\\n]*-u\\s+\\S+:\\S+',
  // Well-known token shapes, wherever they appear (release audit S13).
  '\\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}',
  '\\bsk-[A-Za-z0-9_-]{20,}',
  '\\bAKIA[0-9A-Z]{16}\\b',
  '\\bxox[abprs]-[A-Za-z0-9-]{10,}',
  '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}',
];

export const privacyConfig: PrivacyConfig = {
  shellRedactPatterns: [...DEFAULT_SHELL_REDACT_PATTERNS],
  shellRedactReplacement: '[REDACTED]',
  sensitiveApps: [...DEFAULT_SENSITIVE_APPS],
  hiddenApps: [],
  blockedProcesses: [],
  redactionTier: 2,
};

export interface PrivacyConfigOverrides {
  redactionTier: 1 | 2 | 3;
  extraSensitiveApps: string[];
  extraHiddenApps: string[];
  extraShellRedactPatterns: string[];
}

/**
 * Applies `~/.sundial/config.json`'s privacy overrides onto `privacyConfig`
 * in place — additive only for the three list fields (see the file-level
 * doc comment on `SundialConfigFile` for why an override can never remove
 * built-in redaction coverage, only add to it); `redactionTier` is a plain
 * scalar replacement, a deliberate all-or-nothing user choice. Idempotent:
 * safe to call more than once (e.g. a future config-reload) without
 * duplicate entries piling up across calls.
 */
export function applyPrivacyConfig(overrides: PrivacyConfigOverrides): void {
  privacyConfig.redactionTier = overrides.redactionTier;
  privacyConfig.sensitiveApps = [...new Set([...DEFAULT_SENSITIVE_APPS, ...overrides.extraSensitiveApps])];
  privacyConfig.hiddenApps = [...new Set(overrides.extraHiddenApps)];
  privacyConfig.shellRedactPatterns = [...new Set([...DEFAULT_SHELL_REDACT_PATTERNS, ...overrides.extraShellRedactPatterns])];
}
