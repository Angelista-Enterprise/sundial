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
import { type BenchMarker, benchSetup } from './bench-guard.js';

/**
 * Matched as a case-insensitive substring of the process name AND, where a
 * sensor has one, the bundle id: display names follow the system language
 * (Passwords is "Wachtwoorden" in Dutch), the bundle id does not. So the
 * macOS entries are written as the part both share: `com.apple.Passwords`,
 * `com.apple.keychainaccess`, `com.apple.SecurityAgent` (the system password
 * dialog), `com.apple.loginwindow` (the lock screen).
 */
export const STRICT_SENSITIVE_APPS = [
  'passwords', 'keychain', 'securityagent', 'loginwindow',
  '1password', 'bitwarden', 'keepassxc', 'lastpass', 'dashlane',
  // S4 (Fable M3): the password managers the list missed.
  'proton pass', 'me.proton.pass', 'enpass', 'strongbox', 'keeper', 'nordpass',
  'banking', 'venmo', 'paypal',
  'health', 'myfitnesspal',
] as const;

/** Full default sensitive-app list (tier >= 2). */
export const DEFAULT_SENSITIVE_APPS = [
  'whatsapp', 'messages', 'telegram', 'signal', 'messenger',
  'slack', 'discord',
  'mail', 'zoom', 'facetime',
  // S4 (Fable M3): the owner's standing rule, Notes, Calendar, Reminders and Messages. Notes and Calendar by bundle id only: a bare
  // 'notes' or 'calendar' made every notes.txt, release notes and calendar helper private (57 tests, the rig's own fixture among them).
  'com.apple.notes', 'com.apple.ical', 'reminders', 'mobilesms', 'berichten',
  ...STRICT_SENSITIVE_APPS,
] as const;

/**
 * Owner decision 2026-11-17: the names an entry above goes by, in the system languages the owner may run (en, nl, de, fr, es, pt,
 * it), matched WHOLE and case-insensitively (`privateAppName`): a renamed or localized Notes ("Notities") is as private as its
 * bundle id. Never a substring, so "Notes Plus", "Agenda Pro" or a notes.txt are only what the substring entries make them.
 * A name counts only while its entry is in force (the tier, the owner's own list).
 */
export const PRIVATE_APP_NAMES: Readonly<Record<string, readonly string[]>> = {
  'com.apple.notes': ['notes', 'notities', 'notizen', 'notas', 'note'],
  'com.apple.ical': ['calendar', 'agenda', 'kalender', 'calendrier', 'calendario', 'calendário'],
  reminders: ['reminders', 'herinneringen', 'erinnerungen', 'rappels', 'recordatorios', 'lembretes', 'promemoria'],
  messages: ['messages', 'berichten', 'nachrichten', 'mensajes', 'mensagens', 'messaggi'],
  mail: ['mail'],
  facetime: ['facetime'],
  passwords: ['passwords', 'wachtwoorden', 'passwörter', 'mots de passe', 'contraseñas', 'senhas', 'password'],
  keychain: ['keychain access', 'sleutelhangertoegang', 'schlüsselbundverwaltung', "trousseaux d'accès", 'acceso a llaveros', 'acesso às chaves', 'accesso portachiavi'],
};

/** S4 (Fable H3): web mail whose page text is never kept. Banks and the rest are the owner's to add (`privacy.privateHosts`). */
export const DEFAULT_PRIVATE_HOSTS = ['outlook.office.com', 'mail.proton.me'] as const;

export interface PrivacyConfig {
  shellRedactPatterns: string[];
  shellRedactReplacement: string;
  sensitiveApps: string[];
  hiddenApps: string[];
  blockedProcesses: string[];
  redactionTier: 1 | 2 | 3;
  /** Hosts (and their subdomains) whose page text is dropped. */
  privateHosts: string[];
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
  // S4 (Fable H2), long screen text: a quoted JSON secret ("db_password": "…"), and an env name ending in _PASS, _PWD, _KEY, _SECRET, _TOKEN.
  '(?i)"[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api_?key|client_?secret|private_?key|access_?key)[A-Za-z0-9_.-]*"[ \\t]*:[ \\t]*"[^"]*"',
  '\\b[A-Z][A-Z0-9_]*_(?:PASS|PWD|KEY|SECRET|TOKEN)\\b[ \\t]*[=:][ \\t]*["\']?[^\\s"\']+',
  // Pasted into coding-agent prompts (2026-10-05): env lines, more vendors' key shapes, signed URLs.
  '(?i)\\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Z0-9_]*[ \\t]*[=:][ \\t]*["\']?[^\\s"\']+',
  '\\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}',
  '\\bAIza[0-9A-Za-z_-]{35}',
  '\\b(?:npm_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{30,})',
  '(?i)[?&](?:x-amz-signature|x-amz-credential|x-amz-security-token|signature|sig|key|code|access_token)=[^&\\s]+',
];

export const privacyConfig: PrivacyConfig = {
  shellRedactPatterns: [...DEFAULT_SHELL_REDACT_PATTERNS],
  shellRedactReplacement: '[REDACTED]',
  sensitiveApps: [...DEFAULT_SENSITIVE_APPS],
  hiddenApps: [],
  blockedProcesses: [],
  redactionTier: 2,
  privateHosts: [...DEFAULT_PRIVATE_HOSTS],
};

export interface PrivacyConfigOverrides {
  redactionTier: 1 | 2 | 3;
  extraSensitiveApps: string[];
  extraHiddenApps: string[];
  extraShellRedactPatterns: string[];
  extraPrivateHosts?: string[];
}

/**
 * The bench fence (lab/bench, docs/release/27 section 4): the second setup a benchmark row is run in, the private-app list
 * emptied, for a VM guest that holds no owner data. True only when this install IS the bench (`benchSetup`, both markers,
 * label and home) and its marker says `fence: true`; on the owner's install, or any other, false whatever a file says.
 */
export const benchFence = (setup: () => BenchMarker | null = benchSetup): boolean => setup()?.fence === true;

/**
 * Applies `~/.sundial/config.json`'s privacy overrides onto `privacyConfig`
 * in place — additive only for the three list fields (see the file-level
 * doc comment on `SundialConfigFile` for why an override can never remove
 * built-in redaction coverage, only add to it); `redactionTier` is a plain
 * scalar replacement, a deliberate all-or-nothing user choice. Idempotent:
 * safe to call more than once (e.g. a future config-reload) without
 * duplicate entries piling up across calls. Under the bench fence (`benchFence`) the sensitive and hidden lists are
 * empty; the shell patterns and private hosts stay.
 */
export function applyPrivacyConfig(overrides: PrivacyConfigOverrides, fence: boolean = benchFence()): void {
  privacyConfig.redactionTier = overrides.redactionTier;
  privacyConfig.sensitiveApps = fence ? [] : [...new Set([...DEFAULT_SENSITIVE_APPS, ...overrides.extraSensitiveApps])];
  privacyConfig.hiddenApps = fence ? [] : [...new Set(overrides.extraHiddenApps)];
  privacyConfig.shellRedactPatterns = [...new Set([...DEFAULT_SHELL_REDACT_PATTERNS, ...overrides.extraShellRedactPatterns])];
  privacyConfig.privateHosts = [...new Set([...DEFAULT_PRIVATE_HOSTS, ...(overrides.extraPrivateHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean)])];
}
