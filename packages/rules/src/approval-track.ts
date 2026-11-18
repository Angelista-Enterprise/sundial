// Round 2 (B3): the approvals Gnomon is waiting on, from the log. The shell writes `approval:asked` and
// `approval:answered` (host/server.js); the gate writes `action:decided` just before the ask, with the
// call's tool and the final it named. Before this fold the open asks lived in a Map in the shell, and a
// restart forgot them: the slip showed nothing, and the owner's answer went nowhere.
import { APPROVAL_GONE_MS } from '@sundial/kernel/read/doing.js';
import type { ApprovalAnswer, ApprovalAsk, KernelState, Rule } from '@sundial/kernel/types.js';

export const OPEN_KEPT = 20;
export const RECENT_KEPT = 50;
export const DECIDED_KEPT = 20;

type Approvals = NonNullable<KernelState['approvals']>;
const EMPTY: Approvals = { open: [], recent: [], decided: [] };
/** Who can answer an ask: the owner (web client), the rig (yes.mjs), the bench answerer (only on the bench install, host/bench-guard.js), the shell's timer, the asker withdrawing it. */
const BY = new Set(['owner', 'rig', 'bench', 'timeout', 'asker']);

const str = (v: unknown, n: number) => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, n) : undefined);
const closed = (ask: ApprovalAsk, answer: string, by: string, at: string): ApprovalAnswer => ({ ...ask, answer, by, answeredAt: at });

/** Single writer of `state.approvals`. */
export const approvalTrack: Rule = (state, event) => {
  const was = state.approvals ?? EMPTY;
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const at = Date.parse(event.ts);
  // An ask the shell's own timer never answered (the process went down) closes by the fold's clock.
  const stale = was.open.filter((a) => at - Date.parse(a.at) >= APPROVAL_GONE_MS);
  let next: Approvals = stale.length ? { ...was, open: was.open.filter((a) => !stale.includes(a)), recent: [...was.recent, ...stale.map((a) => closed(a, 'rejected', 'timeout', event.ts))].slice(-RECENT_KEPT) } : was;

  switch (event.type) {
    case 'action:decided': {
      const callId = str(p.callId, 120);
      const tool = str(p.tool, 120);
      if (!callId || !tool) break;
      // The record keeps a final's kind and how it goes, never its app, address or command (gate.js bare).
      const facts = (p.inputs as { facts?: { final?: { kind?: unknown } | null; app?: unknown } } | undefined)?.facts;
      const kind = str(facts?.final?.kind, 40) ?? 'plain';
      // Round 3: a plain act's one app (gate.js callFacts names none for a private app), for the ladder.
      const app = kind === 'plain' ? str(facts?.app, 80) : undefined;
      const call = { callId, tool, kind, ...(app ? { app } : {}) };
      // The ask can land first: it takes the join when it does.
      next = { ...next, decided: [...next.decided.filter((d) => d.callId !== callId), call].slice(-DECIDED_KEPT), open: next.open.map((a) => (a.callId === callId ? { ...a, kind, ...(app ? { app } : {}) } : a)) };
      break;
    }
    case 'approval:asked': {
      const id = str(p.approvalId, 120);
      const sessionId = str(p.sessionId, 200);
      if (!id || !sessionId || next.open.some((a) => a.id === id)) break;
      const callId = str(p.callId, 120) ?? null;
      const call = callId ? next.decided.find((d) => d.callId === callId) : undefined;
      // `text`: the step line, without a final's To, Path or Command (host/server.js stepLine).
      const ask: ApprovalAsk = { id, sessionId, tool: str(p.tool, 120) ?? call?.tool ?? 'a tool', callId, kind: call?.kind ?? str(p.kind, 40) ?? 'plain', ...(call?.app ? { app: call.app } : {}), line: str(p.text, 300) ?? null, at: event.ts };
      next = { ...next, open: [...next.open, ask].slice(-OPEN_KEPT) };
      break;
    }
    case 'approval:answered': {
      const ask = next.open.find((a) => a.id === p.approvalId);
      if (!ask) break;
      // Round 3: who answered, from a known set; a missing or strange `by` is `unknown`, which never moves the ladder (autonomy-track.ts).
      const by = BY.has(p.by as string) ? (p.by as string) : 'unknown';
      next = { ...next, open: next.open.filter((a) => a !== ask), recent: [...next.recent, closed(ask, str(p.answer, 40) ?? 'rejected', by, event.ts)].slice(-RECENT_KEPT) };
      break;
    }
  }
  return next === was ? { state, effects: [] } : { state: { ...state, approvals: next }, effects: [] };
};
