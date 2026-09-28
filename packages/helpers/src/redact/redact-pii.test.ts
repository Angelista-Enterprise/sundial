import { describe, it, expect } from 'vitest';
import { isBsn, isCardNumber, isIban, redactPii } from './redact-pii.js';

describe('redactPii', () => {
  it.each([
    ['mail anna.devries@example.nl today', 'mail [email] today'],
    ['call +31 6 1234 5678 now', 'call [phone] now'],
    ['call +31 (0)20 123 4567', 'call [phone]'],
    ['bel 06-12345678 of 0612345678', 'bel [phone] of [phone]'],
    ['kantoor 020-123 4567', 'kantoor [phone]'],
    ['office (415) 555-0100 or 415-555-0100', 'office [phone] or [phone]'],
    ['card 4111 1111 1111 1111 exp', 'card [card] exp'],
    ['amex 378282246310005', 'amex [card]'],
    ['iban NL91 ABNA 0417 1643 00 please', 'iban [iban] please'],
    ['IBAN NL91ABNA0417164300', 'IBAN [iban]'],
    ['mijn BSN is 111222333', 'mijn BSN is [bsn]'],
    ['psql postgres://admin:hunter2@db.local:5432/app', 'psql postgres://[credentials]@db.local:5432/app'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY----- done', '[private-key] done'], // gitleaks:allow — a stub, not a key
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk (cut off by OCR', '[private-key]'],
  ])('removes %j', (input, expected) => {
    expect(redactPii(input)).toBe(expected);
  });

  it.each([
    'git clone git@github.com:acme/app.git',
    'open icon@2x.png and logo@3x.webp',
    'pnpm add @sundial/helpers@workspace',
    'ssh root@100.101.102.103',
    'order 111222333 shipped', // elfproef passes, but no BSN keyword
    'row id 123456789 and 987654321',
    'ts 1790000000000 and 1790000000',
    'released 2026-09-26 at 10:42:13',
    'bump to v1.23.4567',
    'commit 354114bc50dc259a93bf76b869260fd2d404590c',
    'port 127.0.0.1:3080',
    'diff +1234 -56',
    'moved 4111 1111 1111 1112 rows', // fails Luhn
    'https://example.com/path?x=1',
  ])('keeps %j', (input) => {
    expect(redactPii(input)).toBe(input);
  });
});

describe('checksums', () => {
  it('card needs Luhn and a brand', () => {
    expect(isCardNumber('4111111111111111')).toBe(true);
    expect(isCardNumber('5555555555554444')).toBe(true);
    expect(isCardNumber('1234567812345670')).toBe(false); // Luhn ok, no brand
  });

  it('iban is mod-97', () => {
    expect(isIban('GB82WEST12345698765432')).toBe(true);
    expect(isIban('GB82WEST12345698765433')).toBe(false);
  });

  it('bsn is the elfproef', () => {
    expect(isBsn('111222333')).toBe(true);
    expect(isBsn('111222334')).toBe(false);
  });
});
