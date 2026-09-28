import { getRedactionTier, type RedactionTier } from './redaction-tier.js';

/**
 * URL/path rewriting, tier-aware. Every function takes an optional explicit
 * `tier` (tests, callers with a pinned policy); omitted, the configured tier
 * applies. Tier semantics:
 *
 * - Tier 1: identity — full paths and URLs pass through.
 * - Tier 2: historical behavior (strip query/fragment, `~` home rewrite).
 * - Tier 3: aggressive — URLs to origin/host only, deep paths collapsed.
 */

/**
 * Strip query params and fragments from URLs to prevent token/session leakage
 * (tier 3: also drops the pathname — origin only). `file://` URIs are
 * returned unchanged — `URL.origin` is `"null"` for them and would corrupt
 * the path. Use {@link sanitizeLocalFilePath} for local-path rewriting.
 */
export function stripUrlQuery(url: string, tier: RedactionTier = getRedactionTier()): string {
  if (typeof url === 'string' && url.startsWith('file://')) return url;
  if (tier === 1) return url;
  try {
    const parsed = new URL(url);
    return tier === 3 ? parsed.origin : parsed.origin + parsed.pathname;
  } catch {
    // Tier is already >1 here (tier 1 returned above). A URL malformed enough
    // to throw — a truncated paste, an odd scheme — must NOT pass through with
    // its query/fragment (where a token or session id lives) intact; that's
    // the exact leak this function prevents for well-formed URLs. Redact whole.
    return '[redacted-url]';
  }
}

const HOME_PREFIX_RE = /^(?:file:\/\/)?\/(?:Users|home)\/[^/]+(\/|$)/;

/**
 * Rewrite local filesystem references so they leak neither the username nor
 * the absolute prefix when shared via MCP, sync, or exports.
 *
 * - `file:///Users/<name>/Projects/x` -> `~/Projects/x`
 * - `/Users/<name>/Projects/x` -> `~/Projects/x`
 * - `/home/<name>/Projects/x` -> `~/Projects/x`
 * - non-local URLs (`http(s)://`, etc.) and already-anonymized paths pass through.
 *
 * Tier 1 returns the value untouched. Tier 3 additionally collapses deep
 * `~`-rooted paths to `~/<first>/.../<basename>` so directory structure
 * beyond the top-level area doesn't egress.
 */
export function sanitizeLocalFilePath(value: string, tier: RedactionTier = getRedactionTier()): string {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (tier === 1) return value;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !value.startsWith('file://')) {
    return value;
  }
  const stripped = value.startsWith('file://') ? value.slice('file://'.length) : value;
  const home = stripped.replace(HOME_PREFIX_RE, '~$1');
  if (tier === 3 && home.startsWith('~/')) {
    const segments = home.slice(2).split('/').filter(Boolean);
    if (segments.length > 3) {
      const trailingSlash = home.endsWith('/') ? '/' : '';
      return `~/${segments[0]}/…/${segments[segments.length - 1]}${trailingSlash}`;
    }
  }
  return home;
}

/**
 * Canonical IDENTITY form of a project root — ALWAYS collapses the home prefix
 * to `~`, independent of the redaction tier. Distinct from
 * {@link sanitizeLocalFilePath}, which is tier-gated (tier 1 leaves paths
 * absolute): project/organization identity keys must be stable across a
 * redaction-tier change, or a Settings toggle forks every project into a
 * second `projects` row (an absolute-path twin of the `~`-form id). This is
 * identity normalization, not privacy redaction, so it is deliberately
 * tier-independent. Trailing slash is stripped so `~/x` and `~/x/` are one id.
 */
export function canonicalProjectRoot(value: string): string {
  if (typeof value !== 'string' || value.length === 0) return value;
  const stripped = value.startsWith('file://') ? value.slice('file://'.length) : value;
  const home = stripped.replace(HOME_PREFIX_RE, '~$1');
  return home.length > 1 && home.endsWith('/') ? home.slice(0, -1) : home;
}

/**
 * Strip query strings and fragments from URLs embedded inside a free-text
 * string. Two URL shapes are handled:
 *
 * 1. Schemed:        `(https://example.com/path?q=secret&token=xyz)`
 * 2. Scheme-less:    `google.com/search?q=secret`   (Chrome address-bar form)
 *
 * Anything from the first `?` or `#` onward is stripped; host + path are
 * preserved so the narrative value ("what page was open") survives.
 *
 * Tier 1 returns the text untouched. Tier 3 reduces embedded URLs to
 * scheme + host — the path goes too, even without a `?`/`#`.
 */
const EMBEDDED_URL_RE = /(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s)\]]*[?#][^\s)\]]*/gi;

/** Tier-3 variant: any embedded URL with a path, query or not. */
const EMBEDDED_URL_WITH_PATH_RE = /((?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+)\/[^\s)\]]*/gi;

export function stripEmbeddedUrlQueries(text: string, tier: RedactionTier = getRedactionTier()): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (tier === 1) return text;
  if (tier === 3) {
    return text.replace(EMBEDDED_URL_WITH_PATH_RE, '$1');
  }
  return text.replace(EMBEDDED_URL_RE, (match) => {
    const cut = match.search(/[?#]/);
    return cut >= 0 ? match.slice(0, cut) : match;
  });
}
