// Plan 15 4.3: signs that the owner is stuck. One sign is a `stuck:sign` row; two different signs inside ten
// minutes make one `stuck` notice, which the gate knocks with at the next boundary. Hit rates are read from the log.
import { createHash } from 'node:crypto';
import { deriveId } from '@sundial/helpers/derive-id.js';
import { localDate } from '@sundial/helpers/local-day.js';
import type { Effect, KernelState, NoticeOffer, Rule } from '@sundial/kernel/types.js';

export type StuckSign = 'test-again' | 'error-again' | 'ping-pong' | 'idle-after-fail';
type Stuck = NonNullable<KernelState['stuck']>;

/** Two signs agree when they come inside this window. */
export const AGREE_MS = 10 * 60_000;
/** One stuck notice per this long, at most. */
export const NOTICE_GAP_MS = 30 * 60_000;
const PING_PONG_MS = 2 * 60_000;
const PING_PONG_MIN = 6;
const IDLE_AFTER_FAIL_MS = 2 * 60_000;
const ERROR_LINE = /\b(error|exception|failed|fatal|cannot|undefined is not|traceback)\b/i;
const EMPTY: Stuck = { signs: [], errors: [], noticedAt: null };

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const age = (from: string, to: string) => Date.parse(to) - Date.parse(from);

/** The sign this event shows, with the line that says it; null for none. Reads what the trackers before it folded. */
function signOf(state: KernelState, stuck: Stuck, type: string, ts: string, p: Record<string, unknown>): { sign: StuckSign; line: string; errors?: Stuck['errors'] } | null {
  if (type === 'shell:command') {
    const streak = state.shell.streak;
    return streak && streak.count >= 2 && streak.lastAt === ts ? { sign: 'test-again', line: `\`${streak.command.slice(0, 80)}\` failed ${streak.count} times in a row` } : null;
  }
  if (type === 'screen:ocr') {
    // "Again" means it went away and came back: a line that stays on screen is one error, not two.
    const line = String(p.screenText ?? '').split('\n').map((l) => l.trim()).find((l) => l.length >= 12 && ERROR_LINE.test(l));
    const key = line ? hash(line.toLowerCase().replace(/\d+/g, '#')) : null;
    const kept = stuck.errors.filter((e) => age(e.at, ts) <= AGREE_MS && e.key !== key).map((e) => ({ ...e, gone: true }));
    if (!line || !key) return kept.length === stuck.errors.length && kept.every((_, i) => stuck.errors[i]?.gone) ? null : { sign: 'error-again', line: '', errors: kept };
    const again = stuck.errors.some((e) => e.key === key && e.gone === true && age(e.at, ts) <= AGREE_MS);
    const errors = [...kept, { key, at: ts }].slice(-5);
    return again ? { sign: 'error-again', line: `the same error is on screen again: "${line.slice(0, 80)}"`, errors } : { sign: 'error-again', line: '', errors };
  }
  if (type === 'window:changed') {
    const recent = state.lifeEvent.recentSwitches.filter((s) => age(s.at, ts) <= PING_PONG_MS);
    const apps = new Set(recent.map((s) => s.process));
    return recent.length >= PING_PONG_MIN && apps.size === 2 ? { sign: 'ping-pong', line: `${recent.length} switches between ${[...apps].join(' and ')} in two minutes` } : null;
  }
  if (type === 'idle:start') {
    const failed = Object.values(state.shell.lastFailure ?? {}).find((f) => age(f.at, ts) >= 0 && age(f.at, ts) <= IDLE_AFTER_FAIL_MS);
    return failed ? { sign: 'idle-after-fail', line: `you stepped away right after \`${failed.command.slice(0, 60)}\` failed` } : null;
  }
  return null;
}

/**
 * Round 4: the one step the notice offers, "Pull it up": the failing command's own rows on the record
 * (`gnomon_signals`), when a command failed inside the window. Null when no command did: a switch
 * between two apps has nothing to pull up.
 */
export function pullUpOffer(state: KernelState, ts: string): NoticeOffer | null {
  const fresh = Object.values(state.shell.lastFailure ?? {}).filter((f) => age(f.at, ts) >= 0 && age(f.at, ts) <= AGREE_MS).sort((a, b) => age(a.at, b.at))[0];
  if (!fresh) return null;
  return { tool: 'gnomon_signals', args: { date: localDate(fresh.at, state.config.timezone), signalType: 'shell', contains: fresh.command.slice(0, 60), limit: 5 }, label: 'Pull it up' };
}

/** Single writer of `state.stuck`. After the shell, screen and switch trackers; before the gate. */
export const stuckSigns: Rule = (state, event) => {
  const stuck = state.stuck ?? EMPTY;
  const found = signOf(state, stuck, event.type, event.ts, event.payload as Record<string, unknown>);
  if (!found) return { state, effects: [] };
  let next: Stuck = found.errors ? { ...stuck, errors: found.errors } : stuck;
  if (found.line === '') return { state: { ...state, stuck: next }, effects: [] };
  // A sign that is already in the window is not a second one: the third failure of a test is the same sign.
  if (stuck.signs.some((s) => s.sign === found.sign && age(s.at, event.ts) <= AGREE_MS)) return next === stuck ? { state, effects: [] } : { state: { ...state, stuck: next }, effects: [] };

  const id = deriveId(event.ts, event.id, 'stuck-signs', found.sign);
  const effects: Effect[] = [{ type: 'EmitEvent', event: { id, type: 'stuck:sign', ts: event.ts, payload: { sign: found.sign, line: found.line } } }];
  const signs = [...stuck.signs.filter((s) => age(s.at, event.ts) <= AGREE_MS), { sign: found.sign, at: event.ts, line: found.line, id }].slice(-8);
  next = { ...next, signs };
  const agree = signs.filter((s) => s.sign !== found.sign);
  if (agree.length > 0 && (next.noticedAt === null || age(next.noticedAt, event.ts) >= NOTICE_GAP_MS)) {
    const both = [agree.at(-1)!, signs.at(-1)!];
    next = { ...next, noticedAt: event.ts };
    const offer = pullUpOffer(state, event.ts);
    effects.push({
      type: 'EmitEvent',
      event: {
        id: deriveId(event.ts, event.id, 'stuck-signs', 'notice'),
        type: 'notice:candidate',
        ts: event.ts,
        payload: {
          timestamp: event.ts,
          shape: 'transition',
          kind: 'stuck',
          key: `stuck:${both.map((s) => s.sign).sort().join('+')}`,
          surprise: 1.8,
          precision: 0.6,
          valueHalfLifeMs: AGREE_MS,
          observation: `You may be stuck: ${both[1].line}, and ${both[0].line}. Want a second pair of eyes?`,
          evidence: both.map((s) => `${s.sign}: ${s.line}`),
          signs: both.map((s) => s.id),
          concerns: [],
          ...(offer ? { offer } : {}),
        },
      },
    });
  }
  return { state: { ...state, stuck: next }, effects };
};
