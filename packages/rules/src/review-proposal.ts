import type { ReviewProposal } from '@sundial/kernel/types.js';
import { goalName } from '@sundial/helpers/screen-routes.js';

// Round 5: a self-review's one proposal, read once for both its readers: `selfReview` holds it until the owner
// answers, and `workbench` writes on the shelf row, in words, what the owner's Keep will do.

const str = (v: unknown, n: number): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, n) : undefined);

/** A proposal as the job shelved it (`review` on `work:shelved`), about the job's own app, or null. */
export function proposalOf(raw: unknown, app: string): ReviewProposal | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.kind === 'drop-route' && str(r.routeKey, 300)) return { kind: 'drop-route', app, routeKey: str(r.routeKey, 300)! };
  if (r.kind === 'app-note' && str(r.line, 240)) return { kind: 'app-note', app, line: str(r.line, 240)! };
  const predicate = str(r.predicate, 40);
  if (r.kind === 'fact' && predicate && /^[a-z][A-Za-z]{2,39}$/.test(predicate) && str(r.object, 160)) return { kind: 'fact', app, predicate, object: str(r.object, 160)! };
  return null;
}

/** What Keep does, in the words the owner reads before pressing it. */
export function keepWords(p: ReviewProposal): string {
  switch (p.kind) {
    case 'drop-route':
      return `Keep drops the route "${p.routeKey}" in ${p.app}.`;
    case 'app-note':
      return `Keep adds this note for ${p.app}: ${p.line}`;
    case 'fact':
      return `Keep records: ${p.app} ${p.predicate} ${p.object}.`;
    case 'skill':
      return `Keep makes it the skill "${goalName(p.name) ?? p.name}" in ${p.app}.`;
    case 'drop-skill':
      return `Keep drops the skill "${goalName(p.name) ?? p.name}" in ${p.app}.`;
  }
}
