// Personal data in free text: emails, phone numbers, card numbers, IBANs, BSNs,
// private-key blocks and credentials inside URLs. Config-free, like the other
// primitives here; `redactWithPolicy` runs it after the secret patterns, so it
// applies once, at ingest, to every field that already gets the secret pass.
//
// A match becomes a typed placeholder (`[email]`, `[phone]`, ...) rather than
// `[REDACTED]`, so "sent the invoice to [email]" still says what happened.
//
// Number shapes are only removed when a checksum passes, and the BSN also needs
// a keyword just before it: a bare 9-digit number is far more often an order or
// row id. The checksum and brand tables follow screenpipe's redact crate
// (MIT, Copyright (c) 2024-2026 louis030195, commit 892199f7).

interface Detector {
  label: string;
  re: RegExp;
  valid?: (match: string) => boolean;
  /** Must match the 48 characters before the hit. */
  context?: RegExp;
}

const digits = (s: string): number[] => [...s].filter((c) => c >= '0' && c <= '9').map(Number);

function luhn(d: number[]): boolean {
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let x = d[d.length - 1 - i]!;
    if (i % 2 === 1) x = x * 2 > 9 ? x * 2 - 9 : x * 2;
    sum += x;
  }
  return sum % 10 === 0;
}

/** Luhn plus a real card brand's prefix and length: a Luhn-passing timestamp or hash has no brand. */
export function isCardNumber(s: string): boolean {
  const d = digits(s);
  const n = d.length;
  if (n < 12 || n > 19 || !luhn(d)) return false;
  const p = (k: number) => Number(d.slice(0, k).join(''));
  const visa = d[0] === 4 && [13, 16, 19].includes(n);
  const mc = ((p(2) >= 51 && p(2) <= 55) || (p(4) >= 2221 && p(4) <= 2720)) && n === 16;
  const amex = (p(2) === 34 || p(2) === 37) && n === 15;
  const discover = (p(4) === 6011 || p(2) === 65 || (p(3) >= 644 && p(3) <= 649)) && [16, 19].includes(n);
  const diners = (p(2) === 36 || p(2) === 38 || (p(3) >= 300 && p(3) <= 305)) && [14, 16].includes(n);
  const jcb = p(4) >= 3528 && p(4) <= 3589 && [16, 19].includes(n);
  const unionpay = p(2) === 62 && n >= 16;
  return visa || mc || amex || discover || diners || jcb || unionpay;
}

/** ISO 13616 mod-97. */
export function isIban(s: string): boolean {
  const c = s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (c.length < 15 || c.length > 34) return false;
  let rem = 0;
  for (const ch of c.slice(4) + c.slice(0, 4)) {
    const v = ch >= 'A' ? ch.charCodeAt(0) - 55 : Number(ch);
    rem = (rem * (v > 9 ? 100 : 10) + v) % 97;
  }
  return rem === 1;
}

/** The Dutch "elfproef". */
export function isBsn(s: string): boolean {
  const d = digits(s);
  if (d.length === 8) d.unshift(0);
  if (d.length !== 9) return false;
  const sum = d.reduce((acc, x, i) => acc + x * (i === 8 ? -1 : 9 - i), 0);
  return sum !== 0 && sum % 11 === 0;
}

// Order matters: a key block or a URL's credentials go before the email pass
// could take a piece of them.
const DETECTORS: Detector[] = [
  { label: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  // user:password in any scheme://user:password@host — the host stays.
  { label: 'credentials', re: /(?<=\b[a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+(?=@)/gi },
  // Not `icon@2x.png` (a file), not `git@github.com:org/repo` (a remote).
  {
    label: 'email',
    re: /\b[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+(?!(?:png|jpe?g|gif|svg|webp|ico|pdf|js|ts|tsx|jsx|json|md|txt|css|html?)\b)[A-Za-z]{2,}\b(?!:[\w~/])/g,
  },
  { label: 'iban', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g, valid: isIban },
  { label: 'card', re: /\b\d(?:[ -]?\d){11,18}\b/g, valid: isCardNumber },
  { label: 'bsn', re: /\b\d{8,9}\b/g, valid: isBsn, context: /\b(?:bsn|burgerservice|sofi)/i },
  // International (+31 6 1234 5678, +1 (415) 555-0100), Dutch national
  // (06-12345678, 020 123 4567), and North American with separators. A bare
  // run of digits is never a phone number here.
  { label: 'phone', re: /(?<![\w+])\+\d{1,3}(?:[ .-]?\(0\))?(?:[ .-]?\(?\d\)?){6,12}(?!\d)/g },
  { label: 'phone', re: /\b0(?:6[ -]?\d{8}|[1-9]\d{1,2}[ -]\d{3} ?\d{3,4})\b/g },
  { label: 'phone', re: /(?:\([2-9]\d{2}\) ?|\b[2-9]\d{2}[-.])\d{3}[-.]\d{4}\b/g },
];

export function redactPii(text: string): string {
  let out = text;
  for (const { label, re, valid, context } of DETECTORS) {
    out = out.replace(re, (match: string, ...rest: unknown[]) => {
      const offset = rest[rest.length - 2] as number;
      const whole = rest[rest.length - 1] as string;
      if (valid && !valid(match)) return match;
      if (context && !context.test(whole.slice(Math.max(0, offset - 48), offset))) return match;
      return `[${label}]`;
    });
  }
  return out;
}
