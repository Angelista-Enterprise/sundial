/**
 * A promise in the owner's words. Its deliverable is kept as said, so every
 * surface that names it reads its shape here instead of pasting it in.
 */

/** The verbs a deliverable can start with, and how "is not …" says them. EN + NL. */
export const PAST: Record<string, string> = { send: 'sent', stuur: 'sent', sturen: 'sent', share: 'shared', deel: 'shared', delen: 'shared', review: 'reviewed', fix: 'fixed', finish: 'finished', deliver: 'delivered', write: 'written', make: 'made', maak: 'made', check: 'checked', update: 'updated', book: 'booked', plan: 'planned', schedule: 'scheduled', call: 'called', bel: 'called' };

/** The Dutch verbs of `PAST`, as the English line says them. */
const ENGLISH: Record<string, string> = { stuur: 'send', sturen: 'send', deel: 'share', delen: 'share', maak: 'make', bel: 'call' };

/**
 * A deliverable as said is a thing ("the draft") or a deed ("send the deck").
 * "have the export fix to you" is the thing: the words around it only say it arrives.
 */
export function deliverableShape(deliverable: string): { verb: string | null; thing: string } {
  const said = deliverable.trim().replace(/\s+(?:to|for)\s+(?:you|u|je|jou)$/i, '');
  const had = said.match(/^(?:have|get)\s+(.+?)(?:\s+(?:over|back|ready))?$/i);
  if (had) return { verb: null, thing: had[1]! };
  const [first = '', ...rest] = said.split(/\s+/);
  const word = first.toLowerCase();
  return Object.hasOwn(PAST, word) && rest.length > 0 ? { verb: ENGLISH[word] ?? word, thing: rest.join(' ') } : { verb: null, thing: said };
}

/** "send the deck to Mira", "review the PR for Mira", "the draft for Mira", "Mira owes you the numbers". */
export function promisePhrase(direction: string, deliverable: string, who: string | null): string {
  const { verb, thing } = deliverableShape(deliverable);
  if (direction === 'awaiting') return verb ? `${who ?? 'someone'} is to ${verb} ${thing}` : `${who ?? 'someone'} owes you ${thing}`;
  if (!verb) return `${thing}${who ? ` for ${who}` : ''}`;
  return `${verb} ${thing}${who ? ` ${/^(send|share|deliver)$/.test(verb) ? 'to' : 'for'} ${who}` : ''}`;
}
