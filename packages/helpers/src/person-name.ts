/**
 * Whether a string is plausibly a person's NAME.
 *
 * One definition, two readers: the rule that asks the owner who a hashed
 * attendee is (`peopleAsk`) and the route that names them from the calendar.
 * Both needed it for the same reason — the first answer the ask rule ever
 * received was "in which meeting where they?", and it filed that as the
 * person's name, so the record then held `person-c205ca11f2 knownAs "in which
 * meeting where they?"`. A copy of this test in each place would let one of
 * them drift and re-admit exactly that.
 *
 * Deliberately shallow: it rejects sentences and questions, not unusual names.
 * A name it wrongly rejects is asked about again; a question it wrongly accepts
 * becomes a durable false fact about a colleague.
 */
const OPENERS = /^(who|what|which|where|when|why|how|is|are|was|were|do|does|did|can|could|the|a|an|in|on|at|it|that|this|there|no|not|idk|dunno)\b/i;

export const PERSON_NAME_MAX_CHARS = 60;
export const PERSON_NAME_MAX_WORDS = 4;

/** A local part made of name-like words: letters only (any script), joined by `.`, `_` or `-`. */
const NAME_LOCAL_RE = /^\p{L}{2,}(?:[._-]\p{L}{2,}){0,3}$/u;

/**
 * Mailboxes that are a role, not a person. Name-shaped, so the regex above
 * admits them; a calendar invite from `noreply@` or `hr@` would otherwise mint
 * a colleague called "Noreply".
 */
const ROLE_MAILBOXES = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'info', 'hello', 'contact', 'support', 'help', 'sales', 'billing',
  'admin', 'administrator', 'postmaster', 'webmaster', 'hostmaster', 'mailer-daemon', 'calendar', 'invite', 'invites',
  'notifications', 'notification', 'alerts', 'team', 'office', 'hr', 'finance', 'legal', 'security', 'it', 'ops', 'dev',
  'marketing', 'press', 'jobs', 'careers', 'recruiting', 'events', 'newsletter', 'news', 'updates', 'system', 'bot', 'robot',
]);

/**
 * The display name an address carries, or null when it carries none.
 *
 * The owner's decision of 2026-09-07: EventKit hands Google attendees over as
 * bare addresses even though the calendar shows their names, so 7 of 16
 * colleagues on the live record were only ever `person-<hash>` and every
 * meeting question read "with person-c205ca11f2". `first.last@example.com` IS the
 * name the owner sees in their own calendar; the domain is dropped and only
 * the words survive, title-cased. A role mailbox, digits, or a one-letter
 * local part yield null and the caller aliases instead.
 *
 * Known trade, accepted with the decision: two different people with the same
 * name at two domains become one entity — exactly as they would if both
 * calendars showed the same display name.
 */
export function displayNameFromAddress(address: string): string | null {
  // NFC first, as the alias hash does: a decomposed accent is not a letter to
  // the regex, and the two forms of one address must yield one identity.
  const local = address.normalize('NFC').replace(/^mailto:/i, '').split('@')[0] ?? '';
  if (!NAME_LOCAL_RE.test(local)) return null;
  if (ROLE_MAILBOXES.has(local.toLowerCase())) return null;
  return local
    .split(/[._-]/)
    .map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1).toLocaleLowerCase())
    .join(' ');
}

export function looksLikePersonName(value: string): boolean {
  const name = value.trim();
  if (name.length < 2 || name.length > PERSON_NAME_MAX_CHARS) return false;
  // A question is never a name, however it is phrased.
  if (/[?]/.test(name)) return false;
  const words = name.split(/\s+/);
  if (words.length > PERSON_NAME_MAX_WORDS) return false;
  if (OPENERS.test(name)) return false;
  // At least one letter, and no sentence punctuation running through it.
  if (!/\p{L}/u.test(name)) return false;
  if (/[,;:!]|\.\s/u.test(name)) return false;
  return true;
}
