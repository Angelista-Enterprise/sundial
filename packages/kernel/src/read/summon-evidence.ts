// Plan 15 step 2: why the owner may have called the panel up, read off the state.
// The first sign is the guess, and its line is the one quiet line the panel shows.
import type { KernelState } from '../types.js';

export type SummonSign = 'knock' | 'return' | 'red';
export interface SummonEvidence {
  line: string | null;
  evidence: SummonSign[];
  guess: SummonSign | null;
}

export const BUILD_CMD_RE = /\b(tsc|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build|cargo\s+build|go\s+build|swift\s+build|xcodebuild|make)\b/;

const KNOCK_MS = 5 * 60_000;
const RETURN_MS = 30 * 60_000;
const RED_MS = 10 * 60_000;
/** `voice.typedAt` is written while `voiceKnock` is on; without it there is no burst to see. */
const TYPING_MS = 15_000;

const age = (at: string | null | undefined, now: string): number => (typeof at === 'string' ? Date.parse(now) - Date.parse(at) : Infinity);
const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n).trimEnd()}…` : text);
const newest = <T>(items: T[], at: (item: T) => string): T | undefined => items.reduce<T | undefined>((best, item) => (best === undefined || at(item) > at(best) ? item : best), undefined);

/** Every sign present now, in the order of the guess: a knock, a job that came back, a test or build that failed. */
export function summonSigns(state: KernelState, now: string): { sign: SummonSign; line: string }[] {
  const signs: { sign: SummonSign; line: string }[] = [];
  const within = (at: string | null | undefined, ms: number) => age(at, now) >= 0 && age(at, now) <= ms;

  const last = state.notices?.lastDelivered;
  const knocked = within(last?.at, KNOCK_MS) ? last?.items.find((item) => item.knock) : undefined;
  if (knocked) {
    const said = [...(state.notices.recentPhasic ?? [])].reverse().find((n) => n.noticeKey === knocked.key);
    signs.push({ sign: 'knock', line: said?.observation ? clip(said.observation, 160) : 'I knocked a moment ago.' });
  }

  const back = newest(
    [
      ...(state.workbench?.recent ?? []).filter((job) => job.outcome === 'shelved').map((job) => ({ at: job.closedAt, name: job.title ?? job.subject })),
      ...(state.nightShift?.recent ?? []).filter((job) => job.status === 'done' && typeof job.closedAt === 'string').map((job) => ({ at: job.closedAt as string, name: job.subject })),
    ].filter((job) => within(job.at, RETURN_MS)),
    (job) => job.at,
  );
  if (back) signs.push({ sign: 'return', line: `"${clip(back.name, 80)}" is back.` });

  const red = newest(
    [
      ...Object.values(state.lifeEvent?.failedTests ?? {}).map((t) => ({ at: t.failedAt, command: t.command })),
      ...Object.values(state.shell?.lastFailure ?? {}).filter((f) => BUILD_CMD_RE.test(f.command)).map((f) => ({ at: f.at, command: f.command })),
    ].filter((run) => within(run.at, RED_MS)),
    (run) => run.at,
  );
  if (red) {
    const min = Math.round(age(red.at, now) / 60_000);
    signs.push({ sign: 'red', line: `\`${clip(red.command, 60)}\` failed ${min < 1 ? 'just now' : `${min} min ago`}.` });
  }
  return signs;
}

/** The guess at a summon. In a typing burst there is no line and no guess: the owner is busy with their own words. */
export function summonEvidence(state: KernelState, now: string): SummonEvidence {
  const signs = summonSigns(state, now);
  const typing = age(state.voice?.typedAt, now) < TYPING_MS;
  const first = typing ? undefined : signs[0];
  return { line: first?.line ?? null, evidence: signs.map((s) => s.sign), guess: first?.sign ?? null };
}

/** The line for one summon: the guess the fold made for it, else (the page asked before the fold saw the summon) the guess now. */
export function summonLine(state: KernelState, now: string, summonId: string | null): { line: string | null; guess: string | null } {
  const open = state.overlay?.open;
  const guess = open && open.summonId === summonId ? open.guess : summonEvidence(state, now).guess;
  return { line: summonSigns(state, now).find((s) => s.sign === guess)?.line ?? null, guess };
}
