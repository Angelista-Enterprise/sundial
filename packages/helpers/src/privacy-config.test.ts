import { describe, it, expect, afterEach } from 'vitest';
import { applyPrivacyConfig, privacyConfig, DEFAULT_SENSITIVE_APPS } from './privacy-config.js';
import { isSensitiveProcess, privateAppName, redactWithPolicy } from './redact/redact-policy.js';

const ORIGINAL = {
  redactionTier: privacyConfig.redactionTier,
  sensitiveApps: [...privacyConfig.sensitiveApps],
  hiddenApps: [...privacyConfig.hiddenApps],
  shellRedactPatterns: [...privacyConfig.shellRedactPatterns],
};

describe('applyPrivacyConfig', () => {
  afterEach(() => {
    // Restore the module singleton so other test files see the original defaults.
    privacyConfig.redactionTier = ORIGINAL.redactionTier;
    privacyConfig.sensitiveApps = [...ORIGINAL.sensitiveApps];
    privacyConfig.hiddenApps = [...ORIGINAL.hiddenApps];
    privacyConfig.shellRedactPatterns = [...ORIGINAL.shellRedactPatterns];
  });

  it('replaces redactionTier wholesale (a deliberate scalar override, not additive)', () => {
    applyPrivacyConfig({ redactionTier: 3, extraSensitiveApps: [], extraHiddenApps: [], extraShellRedactPatterns: [] });
    expect(privacyConfig.redactionTier).toBe(3);
  });

  it('adds to sensitiveApps without removing the built-in defaults', () => {
    applyPrivacyConfig({ redactionTier: 2, extraSensitiveApps: ['my-custom-app'], extraHiddenApps: [], extraShellRedactPatterns: [] });
    expect(privacyConfig.sensitiveApps).toContain('my-custom-app');
    for (const app of DEFAULT_SENSITIVE_APPS) {
      expect(privacyConfig.sensitiveApps).toContain(app);
    }
  });

  it('starts hiddenApps empty and adds only what the config specifies (no built-in default to preserve)', () => {
    applyPrivacyConfig({ redactionTier: 2, extraSensitiveApps: [], extraHiddenApps: ['SomeApp', 'OtherApp'], extraShellRedactPatterns: [] });
    expect(privacyConfig.hiddenApps).toEqual(['SomeApp', 'OtherApp']);
  });

  it('adds to shellRedactPatterns without removing the built-in secret-redaction patterns', () => {
    const before = privacyConfig.shellRedactPatterns.length;
    applyPrivacyConfig({ redactionTier: 2, extraSensitiveApps: [], extraHiddenApps: [], extraShellRedactPatterns: ['(?i)my-custom-secret\\s*=\\s*\\S+'] });
    expect(privacyConfig.shellRedactPatterns.length).toBe(before + 1);
    expect(privacyConfig.shellRedactPatterns.some((p) => p.includes('bearer'))).toBe(true);
    expect(privacyConfig.shellRedactPatterns).toContain('(?i)my-custom-secret\\s*=\\s*\\S+');
  });

  it('is idempotent — calling it twice with the same overrides does not duplicate entries', () => {
    const overrides = { redactionTier: 2 as const, extraSensitiveApps: ['dup-app'], extraHiddenApps: [], extraShellRedactPatterns: [] };
    applyPrivacyConfig(overrides);
    const firstLength = privacyConfig.sensitiveApps.length;
    applyPrivacyConfig(overrides);
    expect(privacyConfig.sensitiveApps.length).toBe(firstLength);
  });
});

describe('S4 privacy defaults (Fable M3, H2, H3)', () => {
  afterEach(() => applyPrivacyConfig({ redactionTier: 2, extraSensitiveApps: [], extraHiddenApps: [], extraShellRedactPatterns: [] }));

  it('the owner\'s standing private apps and the password managers are private by default, by name or bundle id', () => {
    for (const app of ['com.apple.Notes', 'com.apple.iCal', 'Reminders', 'com.apple.reminders', 'com.apple.MobileSMS', 'Berichten', 'Mail', 'WhatsApp', 'Proton Pass', 'me.proton.pass', 'Enpass', 'Strongbox', 'Keeper Password Manager', 'NordPass']) {
      expect(isSensitiveProcess(app), app).toBe(true);
    }
    // Notes and Calendar by bundle id: a file or a command named notes is not an app.
    expect(isSensitiveProcess('Finder')).toBe(false);
    expect(isSensitiveProcess('release-notes.md')).toBe(false);
  });

  it('long screen text: a headless key body, a quoted JSON secret, an env name ending in _PASS/_PWD/_KEY/_SECRET/_TOKEN', () => {
    const body = ['A'.repeat(64), 'B'.repeat(64), 'C'.repeat(30)].join('\n');
    expect(redactWithPolicy(`id rsa\n${body}\n-----END OPENSSH PRIVATE KEY-----\nnext`)).toBe('id rsa\n[private-key]\nnext');
    expect(redactWithPolicy(`${'Q'.repeat(70)}\n${'R'.repeat(70)}\ndone`)).toBe('[private-key]\ndone');
    expect(redactWithPolicy(`one line ${'Q'.repeat(70)} stays`)).toBe(`one line ${'Q'.repeat(70)} stays`);
    expect(redactWithPolicy('{"db_password": "pz-made-up-1", "user": "mira"}')).not.toMatch(/pz-made-up-1/);
    expect(redactWithPolicy('{"Client_Secret":"pz-made-up-2"}')).not.toMatch(/pz-made-up-2/);
    expect(redactWithPolicy('{"stripeApiKey" : "pz-made-up-3"}')).not.toMatch(/pz-made-up-3/);
    expect(redactWithPolicy('{"user": "mira"}')).toBe('{"user": "mira"}');
    for (const line of ['DB_PASS=pz-made-up-4', 'MYSQL_PWD=pz-made-up-4', 'PUZZLE_SIGNING_KEY: pz-made-up-4', 'BOX_SECRET="pz-made-up-4"', 'GH_TOKEN=pz-made-up-4']) {
      expect(redactWithPolicy(line), line).not.toMatch(/pz-made-up-4/);
    }
    expect(redactWithPolicy('sort_key = name')).toBe('sort_key = name');
  });

  it('private hosts: the defaults, and the owner\'s added to them', () => {
    for (const host of ['outlook.office.com', 'mail.proton.me']) expect(privacyConfig.privateHosts).toContain(host);
    applyPrivacyConfig({ redactionTier: 2, extraSensitiveApps: [], extraHiddenApps: [], extraShellRedactPatterns: [], extraPrivateHosts: ['bank.example'] });
    expect(privacyConfig.privateHosts).toEqual(expect.arrayContaining(['bank.example', 'mail.proton.me']));
  });
});

describe('private apps by name as well as bundle id (owner decision 2026-11-17)', () => {
  afterEach(() => applyPrivacyConfig({ redactionTier: 2, extraSensitiveApps: [], extraHiddenApps: [], extraShellRedactPatterns: [] }));

  it('a localized or renamed Notes, Calendar, Reminders, Messages or Passwords is private, whole and in any case', () => {
    for (const name of ['Notes', 'Notities', 'NOTIZEN', 'Notas', 'Note', 'Calendar', 'Agenda', 'Kalender', 'Calendrier', 'Calendário', 'Herinneringen', 'Erinnerungen', 'Rappels', 'Promemoria', 'Berichten', 'Nachrichten', 'Mensajes', 'Messaggi', 'Mail', 'Wachtwoorden', 'Passwörter', 'Mots de passe', 'Schlüsselbundverwaltung', "Trousseaux d’accès", ' agenda ', 'Agenda.app']) {
      expect(privateAppName(name), name).toBe(true);
      expect(isSensitiveProcess(name), name).toBe(true);
    }
  });

  it('never a substring: a longer name, a file or a word holding one is not private by name', () => {
    for (const name of ['Notes Plus', 'Agenda Pro', 'Notesnook', 'release-notes.md', 'Kalender Sync', 'Notable', 'Agendas', '', '   ']) expect(privateAppName(name), name).toBe(false);
    expect(isSensitiveProcess('Agenda Pro')).toBe(false);
    expect(isSensitiveProcess('Notesnook')).toBe(false);
  });

  it('a name counts only while its entry is in force: tier 1 keeps the strict list, so Notes and Calendar names go with their entries', () => {
    applyPrivacyConfig({ redactionTier: 1, extraSensitiveApps: [], extraHiddenApps: [], extraShellRedactPatterns: [] });
    expect(privateAppName('Notities')).toBe(false);
    expect(privateAppName('Wachtwoorden')).toBe(true);
  });
});
