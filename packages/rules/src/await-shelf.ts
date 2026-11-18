import { deriveId } from '@sundial/helpers/derive-id.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { isRigSession, SANDBOX_CHANNEL } from '@sundial/kernel/read/rig-session.js';
import type { Effect, Rule } from '@sundial/kernel/types.js';

/**
 * Set 4 R2: a long job on the shelf. The `long` rig family passed, but the slip stood in front of the owner for the
 * whole wait: a `gnomon_await` on a 90 s build held the turn. Now a job wait past a minute is shelved (`await:shelved`,
 * sundial-actions await-tool.js), the turn ends with "Waiting for the build, I will knock", and this rule knocks when the
 * job's own row (`shell:exited`) lands: the result and one offer, addressed to the chat that waited. A rig chat's knock
 * stays in its sandbox: one line in that thread (`SANDBOX_CHANNEL`), never the gate, the companion or the phone.
 *
 * Single writer of `state.awaits`, the newest `AWAITS_KEPT`. After `shellJobs`; nothing else reads it.
 */
export const AWAITS_KEPT = 20;

const str = (v: unknown, n = 80) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

export const awaitShelf: Rule = (state, event) => {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  if (event.type === 'await:shelved') {
    const [job, session] = [str(p.job), str(p.sessionId)];
    if (!job || !session) return { state, effects: [] };
    const row = { job, session, about: str(p.about, 40) || 'the job', at: event.ts };
    return { state: { ...state, awaits: [...(state.awaits ?? []).filter((w) => w.job !== job), row].slice(-AWAITS_KEPT) }, effects: [] };
  }
  const wait = event.type === 'shell:exited' ? (state.awaits ?? []).find((w) => w.job === p.jobId) : undefined;
  if (!wait) return { state, effects: [] };
  const code = typeof p.exitCode === 'number' ? p.exitCode : -1;
  const last = str(p.lastLine, 160);
  const what = `${wait.about.charAt(0).toUpperCase()}${wait.about.slice(1)}`;
  const observation = `${what} ${code === 0 ? 'finished' : `failed with exit code ${code}`}${last ? `. Its last line: "${last}"` : ''}.`;
  const key = `work-awaited:${wait.job}`;
  const evidence = [`${wait.job} exited ${code}`];
  const effect: Effect = isRigSession(state, wait.session)
    ? { type: 'Notify', channel: SANDBOX_CHANNEL, payload: { noticeKey: key, kind: 'work-awaited', observation, evidence, sessionId: wait.session, sandbox: wait.session } }
    : {
        type: 'EmitEvent',
        event: {
          id: deriveId(event.ts, event.id, 'await-shelf', wait.job),
          type: 'notice:candidate',
          ts: event.ts,
          payload: {
            timestamp: event.ts,
            shape: 'self-report',
            kind: 'work-awaited',
            key,
            // The owner was told it would knock: they are waiting on it, as on a job they asked for.
            surprise: 2,
            precision: 1,
            valueHalfLifeMs: 4 * 60 * 60 * 1000,
            observation,
            evidence,
            concerns: [],
            sessionId: wait.session,
            // One offer: the job's own rows on the record (its last line, how it ended).
            offer: { tool: 'gnomon_signals', args: { date: localDate(event.ts, state.config.timezone), signalType: 'shell', contains: wait.job, limit: 3 }, label: code === 0 ? 'Show the output' : 'Show the failing line' },
          },
        },
      };
  return { state: { ...state, awaits: (state.awaits ?? []).filter((w) => w !== wait) }, effects: [effect] };
};
