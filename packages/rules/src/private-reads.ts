import { isRedactedPlaceholder } from '@sundial/helpers/redact/redact-policy.js';
import type { KernelState, Rule } from '@sundial/kernel/types.js';

/**
 * Set 3 R3: what Gnomon read in private, per chat, from rows that already exist. The single writer of `state.privateReads`.
 *
 * - A file outside the workspace, a connected service's read or a read of Gnomon's own record: the gate's `action:decided` fact
 *   `reads` ('outside', 'integration', 'record') on a call it did not refuse, under the row's `sessionId`.
 * - A screen look's text: `screen:looked`, not refused and not a private app's (those read nothing). A chat's tool asks for
 *   its looks and acts by id first (`screen:asked`, sundial-actions index.js), so a look, or an act's after-look, is filed
 *   under that chat. A look no chat asked for (the app's own, the rig's) is filed under `''`: every chat counts it.
 * - A read stays in force for its chat across turns, while its text can still be in the model's context (run 202: a code read in
 *   one turn went out in the next turn's fetch). The gate drops it once the chat compacts past it (gate.js chatRead); a deleted
 *   chat (`chat:forget`) drops its entry here. A chatless entry counts only in the turn it came in.
 * The gate asks before a call carries data off the Mac after one (gate.js underEgress).
 *
 * Bounded: the newest `CHATS_KEPT` chats and the newest `ASKED_KEPT` asked ids.
 */
export const CHATS_KEPT = 20;
export const ASKED_KEPT = 40;

type Reads = NonNullable<KernelState['privateReads']>;
const EMPTY: Reads = { chats: {}, asked: {} };
type Kind = Reads['chats'][string]['kind'];
/** The gate's `reads` fact, as the kind of private read it is. */
const KINDS: Record<string, Kind> = { outside: 'file', integration: 'integration', record: 'record' };
const str = (x: unknown) => (typeof x === 'string' && x !== '' ? x : null);
const newest = <T>(rows: Record<string, T>, key: string, value: T, keep: number) => Object.fromEntries([...Object.entries(rows).filter(([k]) => k !== key), [key, value] as [string, T]].slice(-keep));

export const privateReads: Rule = (state, event) => {
  const p = event.payload as Record<string, unknown> & { inputs?: { facts?: { reads?: unknown } } };
  const was = state.privateReads ?? EMPTY;
  const put = (next: Reads) => ({ state: { ...state, privateReads: next }, effects: [] });
  const read = (chat: string, kind: Kind) => put({ ...was, chats: newest(was.chats, chat, { at: event.ts, kind }, CHATS_KEPT) });
  switch (event.type) {
    case 'screen:asked': {
      const [id, session] = [str(p.id), str(p.session)];
      return id && session ? put({ ...was, asked: newest(was.asked, id, session, ASKED_KEPT) }) : { state, effects: [] };
    }
    case 'action:decided':
      return p.verdict !== 'deny' && KINDS[String(p.inputs?.facts?.reads)] ? read(str(p.sessionId) ?? '', KINDS[String(p.inputs?.facts?.reads)]) : { state, effects: [] };
    case 'screen:looked': {
      const id = str(p.id);
      if (!id || p.refused !== undefined || [p.processName, p.windowTitle].some((x) => typeof x === 'string' && isRedactedPlaceholder(x))) return { state, effects: [] };
      return read(was.asked[id] ?? was.asked[str(p.after) ?? ''] ?? '', 'screen');
    }
    case 'chat:forget': {
      const session = str(p.sessionId);
      if (!session || !(session in was.chats)) return { state, effects: [] };
      return put({ ...was, chats: Object.fromEntries(Object.entries(was.chats).filter(([k]) => k !== session)) });
    }
    default:
      return { state, effects: [] };
  }
};
