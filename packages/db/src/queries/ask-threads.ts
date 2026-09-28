import { desc, eq } from 'drizzle-orm';
import { getDb } from '../db-client.js';
import { askThreads } from '../schemas/db-schema.js';

export interface UpsertAskThreadInput {
  id: string;
  question: string;
  answer: string | null;
  reason: string | null;
  sourceCount: number;
  /** Stringified `AskSource[]` — see the schema comment on `ask_threads.sources`. */
  sources: string | null;
  askedAt: string;
  /** LLM round trips the tool loop took — see the schema comment on `ask_threads.rounds`. */
  rounds: number;
  /** Stringified `string[]` of the tools that produced a result. */
  toolsUsed: string | null;
  /** Stringified `Figure[]` the answer drew — see the schema comment on `ask_threads.figures`. */
  figures: string | null;
  remembered: boolean;
  rememberedAt: string | null;
  rememberedEntryId: string | null;
  sourceEventId: string | null;
}

export interface StoredAskThread {
  id: string;
  question: string;
  answer: string | null;
  reason: string | null;
  sourceCount: number;
  sources: string | null;
  askedAt: string;
  /** LLM round trips the tool loop took — see the schema comment on `ask_threads.rounds`. */
  rounds: number;
  /** Stringified `string[]` of the tools that produced a result. */
  toolsUsed: string | null;
  /** Stringified `Figure[]` the answer drew — see the schema comment on `ask_threads.figures`. */
  figures: string | null;
  remembered: boolean;
  rememberedAt: string | null;
  rememberedEntryId: string | null;
  sourceEventId: string | null;
}

/**
 * Upsert by id, not insert-or-skip: `askTrack` writes a thread once on
 * `ask:answered` and writes it again on `ask:remembered`, and the second write
 * is a real update of the same row rather than a new one. `onConflictDoNothing`
 * (what `insertKnowledgeEntry` uses, because a repeat insight genuinely is a
 * no-op) would silently drop the remember.
 *
 * The remember columns are the only ones the second write is allowed to change —
 * the question and the answer are what was actually asked and answered, and a
 * later event must not be able to rewrite them.
 */
export async function upsertAskThread(input: UpsertAskThreadInput): Promise<void> {
  const db = getDb();
  await db
    .insert(askThreads)
    .values(input)
    .onConflictDoUpdate({
      target: askThreads.id,
      set: {
        remembered: input.remembered,
        rememberedAt: input.rememberedAt,
        rememberedEntryId: input.rememberedEntryId,
      },
    });
}

/** Most recent first — the Ask page's thread rail. */
export async function getRecentAskThreads(limit = 50): Promise<StoredAskThread[]> {
  const db = getDb();
  return db.select().from(askThreads).orderBy(desc(askThreads.askedAt)).limit(limit);
}

/** One thread, for the remember route to read the question and answer it is promoting. */
export async function getAskThreadById(id: string): Promise<StoredAskThread | null> {
  const db = getDb();
  const [row] = await db.select().from(askThreads).where(eq(askThreads.id, id));
  return row ?? null;
}
