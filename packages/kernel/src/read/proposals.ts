import { noteKey } from '@sundial/helpers/app-notes.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { goalName } from '@sundial/helpers/screen-routes.js';
import type { KernelState } from '../types.js';

/**
 * Set 5 R3: everything Gnomon's learners put to the owner, in one list, each with the count it stands on.
 *
 * Before this the learners wrote to five places (a notice, Today's "It suggested", a shelf row, the brief, nothing at
 * all), and every counter on the record read 0. One reader, one card section (`Left for you` → "Gnomon proposes"):
 *
 *   - `selfReview.proposed`: a route offered as a skill (no model), a kept skill to drop, and a review job's one fix
 *     (drop a route, an app note, a fact about the app). Answered with the routes they already had: a skill through
 *     `assistant:response` (its loop and notice settle too), the rest through `feedback:verdict` on the shelf row.
 *   - today's chore offer, while the gate holds it (`notices.offers`, kind `chore`): pressed like the slip's offer.
 *   - the owner's app notes (`appNotes.owner`), already in use: kept (off the card) or dropped (out of every brief).
 *   - a rule idea on the shelf (`watch.proposed`, a `rule-idea` job's tested rule): Keep adopts it, No drops it, both
 *     through `feedback:verdict` on the shelf row, as the shelf's own buttons do. `n`: the days of the chore that seeded it.
 *
 * Every item carries `n`, the count it stands on; a bar a learner uses is a default until `TRUST_N`. Pure: state and
 * the time asked.
 */
export const TRUST_N = 20;

export type ProposalVia = 'skill' | 'review' | 'chore' | 'app-note';
export interface Proposal {
  /** Stable while the proposal stands: the shelf id, `chore:<family>`, `app-note:<app>\n<note>`. */
  id: string;
  kind: 'skill' | 'drop-skill' | 'drop-route' | 'app-note' | 'fact' | 'chore' | 'learned' | 'rule';
  /** How an answer is written (the host maps each to its existing route). */
  via: ProposalVia;
  app: string | null;
  /** The proposal, one sentence, a question when it waits on a yes. */
  title: string;
  /** What it stands on, in words, with its count. */
  evidence: string;
  n: number;
  /** When it was put, when known. */
  at: string | null;
  /** The key an answer names: the notice key of a chore offer, the note key of an app note. */
  key?: string;
}

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
const times = (n: number) => `${n} time${n === 1 ? '' : 's'}`;
const named = (name: string) => goalName(name) ?? name;

export function readProposals(state: KernelState, nowIso: string): { items: Proposal[]; trustN: number } {
  const items: Proposal[] = [];
  const review = state.selfReview;
  for (const [id, p] of Object.entries(review?.proposed ?? {})) {
    if (p.kind === 'skill') {
      const route = review?.routes[`${p.app}\n${p.routeKey}`];
      const n = route?.clean ?? 0;
      items.push({ id, kind: 'skill', via: 'skill', app: p.app, title: `Keep "${named(p.name)}" in ${p.app} as a skill?`, evidence: `It ran clean ${times(n)}${route?.days?.length ? ` on ${days(route.days.length)}` : ''}, with no failed step.`, n, at: route?.offeredAt ?? null });
    } else if (p.kind === 'drop-skill') {
      const skill = review?.skills[p.name];
      const n = (skill && review?.routes[`${skill.app}\n${skill.routeKey}`]?.failed) ?? 0;
      items.push({ id, kind: 'drop-skill', via: 'review', app: p.app, title: `Drop the skill "${named(p.name)}" in ${p.app}?`, evidence: `Its route failed ${times(n)} since you kept it.`, n, at: null });
    } else {
      const n = p.n ?? 0;
      const title = p.kind === 'drop-route' ? `Drop a route in ${p.app} that keeps failing?` : p.kind === 'app-note' ? `Note for ${p.app}: ${p.line}` : `Record that ${p.app} ${p.predicate} ${p.object}?`;
      items.push({ id, kind: p.kind, via: 'review', app: p.app, title, evidence: `My own steps failed here ${times(n)}${p.cluster ? ` ("${p.cluster}")` : ''}; a review read them.`, n, at: null });
    }
  }
  // Rule ideas on the shelf, until the owner keeps or drops one.
  for (const [id, rule] of Object.entries(state.watch?.proposed ?? {})) {
    const from = state.watch?.proposedFrom?.[id];
    const n = from?.days ?? 0;
    const seed = from?.seed ? `Seeded by ${from.seed.replace(/^host:/, '')}, a chore on ${days(n)} in four weeks; ` : '';
    items.push({ id, kind: 'rule', via: 'review', app: null, title: `Watch for this from now on: ${rule.title}?`, evidence: `${seed}tested on 30 days of your record before it was shelved. It would say: "${rule.say}"`, n, at: from?.at ?? null });
  }
  // Today's chore offer, while the gate still holds it; one a day by the learner.
  const today = localDate(nowIso, state.config.timezone);
  for (const [key, offer] of Object.entries(state.notices.offers ?? {})) {
    if (offer.kind !== 'chore' || localDate(offer.at, state.config.timezone) !== today) continue;
    const n = offer.n ?? 0;
    items.push({ id: key, kind: 'chore', via: 'chore', app: null, title: `${offer.label}?`, evidence: offer.line ?? `A chore you did on ${days(n)} in four weeks.`, n, at: offer.at, key });
  }
  // App notes in use for the owner's chats, until the owner answers them.
  const answered = state.appNotes?.answered ?? {};
  for (const note of state.appNotes?.owner.notes ?? []) {
    const key = noteKey(note);
    if (answered[key]) continue;
    items.push({ id: `app-note:${key}`, kind: 'learned', via: 'app-note', app: note.app, title: `${note.app}: ${note.note}.`, evidence: `Learned from my own steps in ${note.n} tasks; I already use it there.`, n: note.n, at: note.lastAt, key });
  }
  return { items: items.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''))), trustN: TRUST_N };
}
