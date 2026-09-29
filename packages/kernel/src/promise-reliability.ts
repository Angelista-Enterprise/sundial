/**
 * UC1 (U1-F40 F41) — how the owner keeps promises, counted from the ledger's
 * own rows. Every figure carries its n, and no rate is claimed below
 * `CLAIM_AT` closed promises: a verdict carries its sample.
 */

/** Closed promises needed before a rate is stated. */
export const CLAIM_AT = 20;

export interface PromiseRowLike {
  closedAt: string | null;
  closedBecause: string | null;
  promise: { direction?: unknown; counterparty?: unknown; due?: unknown } | null;
}

export interface Tally {
  /** Closed promises counted — the n every rate below is over. */
  n: number;
  kept: number;
  /** Kept by the due date. */
  onTime: number;
  broken: number;
  dropped: number;
  wentQuiet: number;
  /** kept / n, only from `CLAIM_AT` closed promises; null before. */
  keptRate: number | null;
}

export interface PersonLedger {
  who: string;
  /** Open promises the owner owes this person, and they owe the owner. */
  youOwe: number;
  theyOwe: number;
  /** Closed promises the owner made to them. */
  toThem: Tally;
}

function tally(rows: PromiseRowLike[]): Tally {
  const closed = rows.filter((r) => r.closedAt !== null && r.closedBecause !== 'owner');
  const kept = closed.filter((r) => r.closedBecause === 'kept' || r.closedBecause === 'seen-done');
  const onTime = kept.filter((r) => typeof r.promise?.due === 'string' && r.closedAt! <= (r.promise.due as string)).length;
  const n = closed.length;
  return {
    n,
    kept: kept.length,
    onTime,
    broken: closed.filter((r) => r.closedBecause === 'broken').length,
    dropped: closed.filter((r) => r.closedBecause === 'dropped').length,
    wentQuiet: closed.filter((r) => r.closedBecause === 'went-quiet').length,
    keptRate: n >= CLAIM_AT ? Math.round((kept.length / n) * 100) / 100 : null,
  };
}

const owed = (r: PromiseRowLike) => r.promise?.direction !== 'awaiting';

/** The owner's own record, and one ledger per person, most promises first. `name` maps a hash to the name the owner gave it. */
export function promiseReliability(rows: PromiseRowLike[], name: (who: string) => string | null = (w) => w): { overall: Tally; byPerson: PersonLedger[]; note: string } {
  const mine = rows.filter(owed);
  const people = new Map<string, PromiseRowLike[]>();
  for (const r of rows) {
    const raw = typeof r.promise?.counterparty === 'string' ? r.promise.counterparty : null;
    const who = raw ? name(raw) : null;
    if (!who) continue;
    people.set(who, [...(people.get(who) ?? []), r]);
  }
  const byPerson = [...people.entries()]
    .map(([who, list]) => ({ who, youOwe: list.filter((r) => r.closedAt === null && owed(r)).length, theyOwe: list.filter((r) => r.closedAt === null && !owed(r)).length, toThem: tally(list.filter(owed)) }))
    .sort((a, b) => b.youOwe + b.theyOwe + b.toThem.n - (a.youOwe + a.theyOwe + a.toThem.n));
  const overall = tally(mine);
  return { overall, byPerson, note: overall.keptRate === null ? `No rate yet: ${overall.n} closed promise(s), a rate is stated from ${CLAIM_AT}. Quote the counts with their n.` : `Rates over n = ${overall.n} closed promises. Quote the n with the rate.` };
}
