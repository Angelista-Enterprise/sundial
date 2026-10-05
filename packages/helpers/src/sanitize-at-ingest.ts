import { createHash } from 'node:crypto';
import { displayNameFromAddress, looksLikePersonName } from './person-name.js';
import {
  isHiddenProcess,
  isSensitiveProcess,
  redactWithPolicy,
  windowTitleForEgress,
} from './redact/redact-policy.js';
import { sanitizeLocalFilePath, stripUrlQuery } from './redact/redact-url.js';

/**
 * One event shape every sensor emits (docs/design/01-events-and-log.md).
 * `payload` is per-`type`, defined by the sensor.
 */
export interface Event {
  id: string;
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}

export interface SanitizedEvent extends Event {
  sanitized: true;
}

/**
 * Fields redacted with `redactWithPolicy` (shell-secret patterns) regardless
 * of process sensitivity — free text that might contain a pasted token.
 * `title` covers both a shell/media title AND a calendar event's title
 * (E1, docs/audit/production-proposal-and-enhancements.md, fixes A§6.2) —
 * the recursive walk below applies this by field name at any depth, so a
 * calendar event nested under `payload.event`/`payload.events[]` gets the
 * same pass a top-level `title` always did, with no separate field-path
 * needed for it.
 */
const SHELL_PATTERN_FIELDS = ['command', 'commitLine', 'lastCommit', 'query', 'track', 'artist', 'title', 'deviceName'];

/**
 * Free text from the sensors added after the field list above was written —
 * browser page text, mail subjects, message chat names, screen-vision facts,
 * vault note names, shelved work, a coding agent's last prompt and reply (and, as
 * `text`, every `agent:turn`) — which reached the log (and the page text a
 * remote model) with no secret-pattern pass at all (release audit S13).
 */
const FREE_TEXT_FIELDS = ['text', 'subject', 'chat', 'body', 'facts', 'notes', 'sources', 'pageExcerpt', 'lastPrompt', 'lastReply'];

/**
 * Fields treated as local file paths. `projectRoot`/`fromProjectRoot`/
 * `toProjectRoot` were added after a live-testing gap: the `project` sensor's
 * `project:detected`/`project:switched` events carried an absolute,
 * unredacted path (including the OS username) straight into the log and
 * (once Wave 3a's project-identity groundwork landed) into the durable
 * `projects` table — `cwd`/`documentPath` were covered, these weren't, since
 * they're a different field name for the same kind of value.
 */
const LOCAL_PATH_FIELDS = ['documentPath', 'cwd', 'projectRoot', 'fromProjectRoot', 'toProjectRoot', 'activeRoots'];

/** Free-text fields cleared entirely (not just pattern-redacted) for a sensitive process. */
const SENSITIVE_CLEARED_FIELDS = ['url', 'screenText', 'focusedValue', 'focusedTitle'];

/** Regex/pattern-redacted fields that are NOT process-gated (no `processName` in scope at all, e.g. calendar events) still get the same treatment via `PATTERN_FIELDS` below — see `sanitizeStringField`. */
const PATTERN_FIELDS = new Set([...SHELL_PATTERN_FIELDS, ...FREE_TEXT_FIELDS, ...SENSITIVE_CLEARED_FIELDS]);

/**
 * Arrays of person identifiers — calendar attendee lists, an organizer
 * field. E1 (fixes A§6.2) — an email-shaped entry is replaced with a
 * stable, deterministic alias derived from a hash of the lowercased email,
 * never the raw address itself; a plain display name passes through
 * unchanged (that's the whole point of `person:` entities being keyed on
 * display name, not email, per the design doc). Deterministic (not random)
 * so the same real person's email always aliases to the same string across
 * every calendar event they appear in — `entityExtract` needs that
 * stability to treat them as one entity, not a fresh one per meeting.
 */
const PERSON_LIST_FIELDS = new Set(['attendees']);
// `from` is a mail or message sender (J3.6). It reached the log as the raw
// address until 2026-09-24: the sensor's promise of `person-<hash>` had no
// field here to keep it. Other signals' `from` (a board span's date, a merged
// project's path) are not addresses and pass through unchanged.
const PERSON_STRING_FIELDS = new Set(['organizer', 'from', 'to', 'calendar']);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Fields holding a URL: query and credentials stripped, and a local file URL's user path. */
const URL_FIELDS = new Set(['url', 'finalUrl']);

/**
 * An attendee string, as the log keeps it: the person's NAME when the address
 * carries one (`displayNameFromAddress`), else a stable `person-<hash>` alias.
 *
 * The hash is taken over the string AS RECEIVED — `mailto:` prefix and all —
 * because that is how every alias already in the record was made; hashing a
 * normalized form would give the same colleague a second identity from today.
 * NFC-normalized, lowercased and trimmed, so the two Unicode forms of one
 * accented address stay one alias.
 *
 * The hash step is `personAliasFor` below, which is exported on its own — see
 * its comment for why the resolver needs that half and NOT this function.
 */
function aliasIfEmail(raw: string): string {
  const value = raw.replace(/^mailto:/i, '');
  if (!EMAIL_RE.test(value)) return raw;
  const name = displayNameFromAddress(value);
  if (name !== null) return name;
  return personAliasFor(raw);
}

/**
 * The alias a raw address hashes to, with no display-name shortcut in front.
 *
 * `identity-resolve` needs exactly this and never `aliasIfEmail`, and the
 * difference is not cosmetic. Since 2026-09-07 `aliasIfEmail` tries
 * `displayNameFromAddress` FIRST, so `alexm@example.com` now returns "Alexm" and
 * never reaches the hash — which means it can no longer reproduce
 * `person-c205ca11f2`, the alias that same address produced before that change.
 * A resolver built on `aliasIfEmail` would therefore match nothing at all, while
 * looking entirely correct.
 *
 * Every hashed alias in the record is a row from before that change, or an
 * address whose local part is not name-shaped. Both are reachable only through
 * the hash, so this is the function that inverts them — by running forwards over
 * a candidate address and comparing, never by inverting anything.
 *
 * One definition, two callers: `aliasIfEmail` for the ingest path and the
 * resolver for the recovery path. A second copy of this formula would silently
 * stop agreeing with the aliases already stored.
 */
export function personAliasFor(raw: string): string {
  const hash = createHash('sha256').update(raw.normalize('NFC').trim().toLowerCase()).digest('hex').slice(0, 10);
  return `person-${hash}`;
}

/** Whether a sanitized person field was REDACTED (aliased) rather than named. A name is not a scrub, and the audit should not count it as one. */
function isPersonAlias(value: string): boolean {
  return /^person-[0-9a-f]{10}$/.test(value);
}

interface RedactionCtx {
  hidden: boolean;
  sensitive: boolean;
  processName: string;
}

const NO_PROCESS_CTX: RedactionCtx = { hidden: false, sensitive: false, processName: '' };

/**
 * A nested object with its own `processName` (e.g. `window`/`previousWindow`
 * on a `window:changed` payload) gets its own freshly-computed hidden/
 * sensitive context — NOT the parent's. `previousWindow` can legitimately
 * be a different (possibly sensitive) app than the current `window`; using
 * the outer event's `processName` for both would silently under-redact
 * whichever one didn't match it.
 */
function ctxFor(obj: Record<string, unknown>, parent: RedactionCtx): RedactionCtx {
  const processName = typeof obj.processName === 'string' ? obj.processName : undefined;
  if (processName === undefined) return parent;
  return { hidden: isHiddenProcess(processName), sensitive: isSensitiveProcess(processName), processName };
}

/**
 * P4 (docs/design/07) — a per-property redaction tally threaded through the
 * walk. Each time a field's value is actually changed (cleared, aliased, or
 * pattern-redacted), its key is counted. The counts feed a queryable
 * `privacy:redacted` signal (see `sanitizeAtIngestWithAudit`) and the daily's
 * audit section — the structured trail WCS had that Gnomon's inline
 * `[private]`/`[hidden]` scrubbing lacked. Redaction POLICY is unchanged; this
 * only observes it.
 */
export type RedactionTally = Record<string, number>;

function bump(tally: RedactionTally | null, key: string): void {
  if (tally) tally[key] = (tally[key] ?? 0) + 1;
}

function sanitizeStringField(key: string, value: string, ctx: RedactionCtx, tally: RedactionTally | null): string {
  const result = sanitizeStringFieldValue(key, value, ctx);
  // A person field that became a NAME was not scrubbed; only an alias counts.
  if (result !== value && !(PERSON_STRING_FIELDS.has(key) && !isPersonAlias(result))) bump(tally, key);
  return result;
}

function sanitizeStringFieldValue(key: string, value: string, ctx: RedactionCtx): string {
  if (key === 'processName') return ctx.hidden ? '[hidden]' : value;
  if (key === 'windowTitle') return ctx.hidden ? '[hidden]' : windowTitleForEgress(ctx.processName, value);
  // P7 (docs/design/07) — screen-OCR text is handled BEFORE the generic `ctx.hidden` early-return
  // below (which returns other fields raw for a hidden app): OCR captures on-screen content, so a
  // hidden/sensitive app's screen text must be cleared, never passed through. Non-sensitive text
  // still gets the shell-secret pattern pass. This is the redaction-bypass gate for OCR.
  if (key === 'screenText') return ctx.hidden || ctx.sensitive ? '[private]' : redactWithPolicy(value);
  // Spoken text gets the secret-pattern pass like OCR, and deliberately NOT
  // OCR's sensitive/hidden-app clear. What a room sounds like has nothing to do
  // with which window happens to be focused: gating audio on the frontmost app
  // would blank a conversation about lunch because a password manager was open,
  // and would keep a conversation about a password because a text editor was.
  // The app is not evidence either way, so it is not consulted.
  if (key === 'spokenText') return redactWithPolicy(value);
  // A hidden app's free text, paths and URLs are gone, not passed raw — hiding
  // an app must never redact LESS than marking it sensitive (audit S14).
  if (ctx.hidden) return PATTERN_FIELDS.has(key) || LOCAL_PATH_FIELDS.includes(key) || URL_FIELDS.has(key) ? '[hidden]' : value;

  if (PERSON_STRING_FIELDS.has(key)) return aliasIfEmail(value);
  if (key === 'remote') return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1');
  if (URL_FIELDS.has(key)) return ctx.sensitive ? '[private]' : sanitizeLocalFilePath(stripUrlQuery(value));
  // A browser's `documentPath` is the page's web URL, and its query carried
  // sign-in tokens and keys into the log until 2026-10-05.
  if (LOCAL_PATH_FIELDS.includes(key)) return ctx.sensitive ? '[private]' : sanitizeLocalFilePath(/^https?:\/\//i.test(value) ? stripUrlQuery(value) : value);
  if (PATTERN_FIELDS.has(key)) return ctx.sensitive ? '[private]' : redactWithPolicy(value);
  return value;
}

function sanitizeValue(key: string, value: unknown, ctx: RedactionCtx, tally: RedactionTally | null): unknown {
  if (typeof value === 'string') return sanitizeStringField(key, value, ctx, tally);

  if (Array.isArray(value)) {
    if (PERSON_LIST_FIELDS.has(key)) {
      return value.map((item) => {
        if (typeof item !== 'string') return item;
        const aliased = aliasIfEmail(item);
        if (aliased !== item && isPersonAlias(aliased)) bump(tally, key);
        return aliased;
      });
    }
    // Strings inside an array get the field's own treatment (a list of facts, of
    // note names, of watched roots); they used to pass untouched.
    return value.map((item) =>
      typeof item === 'string' ? sanitizeStringField(key, item, ctx, tally) : typeof item === 'object' && item !== null ? sanitizeObject(item as Record<string, unknown>, ctx, tally) : item,
    );
  }

  if (typeof value === 'object' && value !== null) {
    return sanitizeObject(value as Record<string, unknown>, ctx, tally);
  }

  return value;
}

function sanitizeObject(obj: Record<string, unknown>, parentCtx: RedactionCtx, tally: RedactionTally | null): Record<string, unknown> {
  const ctx = ctxFor(obj, parentCtx);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = sanitizeValue(key, value, ctx, tally);
  }
  // M4 — a mail sender's display name. When it reads as a person's name it IS
  // the sender as the log keeps it: the address never lands, and no hash is
  // minted for someone Mail already names. Either way the field itself goes.
  // UC1: a sent mail's recipient (`to` + `toName`) is kept the same way.
  for (const [field, nameField] of [['from', 'fromName'], ['to', 'toName']] as const) {
    if (!(nameField in obj)) continue;
    const name = typeof obj[nameField] === 'string' ? (obj[nameField] as string).trim() : '';
    if (typeof obj[field] === 'string' && out[field] !== obj[field] && !name.includes('@') && looksLikePersonName(name)) out[field] = name;
    delete out[nameField];
  }
  return out;
}

/**
 * The one redaction pass every sensor's captured event flows through before
 * `insertSignal()`. Consolidates what WCS split across four call sites
 * (signal ingest, moment persist, MCP egress, context egress) into a single
 * function, per docs/design/01-events-and-log.md. Everything downstream
 * (log reads, LLM prompts, CLI output) reads an already-safe value and only
 * trims for presentation — it never re-derives redaction policy.
 *
 * E1 (docs/audit/production-proposal-and-enhancements.md, fixes A§6.2) —
 * walks the payload generically at any depth instead of only known
 * top-level fields plus a hardcoded `window`/`previousWindow` special case.
 * That special case is gone entirely now: `window`/`previousWindow` are
 * just nested objects the generic walk already covers, each evaluated
 * against its own `processName` (see `ctxFor`). This is what makes a
 * calendar event's `title`/`attendees` — nested under `payload.event`/
 * `payload.events[]`, previously invisible to every redaction rule — get
 * the same treatment a top-level field always did.
 */
export function sanitizeAtIngest(event: Event): SanitizedEvent {
  const out = sanitizeObject(event.payload, NO_PROCESS_CTX, null);
  return { ...event, payload: out, sanitized: true };
}

/**
 * P4 — same single redaction pass, but also returns a per-property tally of
 * what was scrubbed, so the ingest path can emit a queryable `privacy:redacted`
 * signal. The returned `event` is byte-identical to `sanitizeAtIngest(event)` —
 * the tally is pure observation, it never changes what gets redacted.
 */
export function sanitizeAtIngestWithAudit(event: Event): { event: SanitizedEvent; redactions: RedactionTally } {
  const redactions: RedactionTally = {};
  const out = sanitizeObject(event.payload, NO_PROCESS_CTX, redactions);
  return { event: { ...event, payload: out, sanitized: true }, redactions };
}
