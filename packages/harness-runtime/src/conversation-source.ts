// dsh's session store → the owner's typed turns, for `RunConversationExtraction`.
//
// Lives here rather than in the `sundial-kernel` plugin because this package
// already depends on `@sundial/rules` (for the pure turn selection) and the
// plugin does not; the plugin hands in dsh's `sessionQuery` service and gets a
// `ConversationSource` back.
//
// Every session is read, not just the companion's: the Ask layer and ordinary
// chats are the owner talking to the same Gnomon. Subagent children are skipped
// — their "user" turns are another agent's instructions, not the owner's words.
import { selectOwnerTurns, type ConversationSource, type ConversationTurn, type RawSessionEvent } from '@sundial/rules/conversation-extract.js';

/** The slice of dsh's `sessionQuery` this needs, kept structural so this package stays free of dsh types. */
export interface SessionQueryLike {
  listSessions(): Promise<ReadonlyArray<{ header: { id: unknown; origin?: string } }>>;
  readSession(sessionId: never | unknown): Promise<{ events: ReadonlyArray<RawSessionEvent> }>;
}

export function createSessionConversationSource(sessionQuery: SessionQueryLike, now: () => number = Date.now): ConversationSource {
  return {
    async readOwnerTurnsSince(sinceIso: string): Promise<ConversationTurn[]> {
      const sinceMs = Date.parse(sinceIso);
      const untilMs = now();
      const turns: ConversationTurn[] = [];
      const records = await sessionQuery.listSessions();
      for (const record of records) {
        const header = record?.header;
        if (!header || header.origin === 'subagent') continue;
        let events: ReadonlyArray<RawSessionEvent>;
        try {
          events = (await sessionQuery.readSession(header.id)).events;
        } catch (error) {
          console.warn(`[sundial-kernel] conversation pass could not read session ${String(header.id)}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        turns.push(...selectOwnerTurns(String(header.id), events, sinceMs, untilMs));
      }
      turns.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      return turns;
    },
  };
}
