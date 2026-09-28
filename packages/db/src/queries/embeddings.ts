import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db-client.js';
import { memoryEmbeddings } from '../schemas/db-schema.js';

export interface InsertEmbeddingInput {
  id: string;
  refType: 'moment' | 'knowledge_entry' | 'entity_fact';
  refId: string;
  model: string;
  vector: number[];
  createdAt: string;
}

export interface StoredEmbedding {
  id: string;
  refType: string;
  refId: string;
  model: string;
  vector: number[];
  createdAt: string;
}

/** `number[]` -> a packed `Float32Array`'s raw bytes, as a `Buffer` (D1, fixes A§5.4 — more compact and faster to (de)serialize than the JSON string this used to be). */
function vectorToBuffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

/**
 * Reads a `vector` cell back into `number[]`, tolerating a row written
 * *before* D1's blob migration: SQLite's manifest typing means a column
 * changing its declared type doesn't retroactively convert already-stored
 * values — an old row's `vector` cell is still literally the same JSON-text
 * string it always was, only *new* inserts are real blobs. Verified
 * empirically against the actual generated migration SQL, not assumed.
 *
 * This only works because `getAllEmbeddings` below reads via a raw `sql`
 * query, not the schema-typed `db.select().from(memoryEmbeddings)` —
 * drizzle's `blob({mode:'buffer'})` column unconditionally does
 * `Buffer.from(value)` on the way out (see `mapFromDriverValue` in
 * `drizzle-orm/sqlite-core/columns/blob.js`), which for an old row would
 * silently reinterpret the JSON string's own UTF-8 *bytes* as if they were
 * packed floats — corrupting it, not falling back. The raw driver value
 * (bypassing that mapping) is a genuine JS `string` for an old row and an
 * `ArrayBuffer` for a real one, verified empirically against `@libsql/client`
 * directly.
 */
function bufferToVector(raw: ArrayBuffer | string): number[] {
  if (typeof raw === 'string') return JSON.parse(raw) as number[];
  return Array.from(new Float32Array(raw));
}

export async function insertEmbedding(input: InsertEmbeddingInput): Promise<void> {
  const db = getDb();
  await db.insert(memoryEmbeddings).values({ ...input, vector: vectorToBuffer(input.vector) });
}

/** One vector per ref: a re-embed (a moment's narrative landing) replaces what was there rather than adding a second row. */
export async function replaceEmbedding(input: InsertEmbeddingInput): Promise<void> {
  const db = getDb();
  await db.delete(memoryEmbeddings).where(and(eq(memoryEmbeddings.refType, input.refType), eq(memoryEmbeddings.refId, input.refId)));
  await insertEmbedding(input);
}

/**
 * Linear scan, not a vector index — per docs/design/04-data-model-and-read-
 * surface.md's explicit call: a full vector-DB dependency isn't justified at
 * this per-user data volume (thousands, not millions, of rows). Revisit if
 * that assumption stops holding.
 */
export async function getAllEmbeddings(): Promise<StoredEmbedding[]> {
  const db = getDb();
  const rows = await db.all<{ id: string; ref_type: string; ref_id: string; model: string; vector: ArrayBuffer | string; created_at: string }>(
    sql`SELECT id, ref_type, ref_id, model, vector, created_at FROM memory_embeddings`,
  );
  return rows.map((row) => ({
    id: row.id,
    refType: row.ref_type,
    refId: row.ref_id,
    model: row.model,
    vector: bufferToVector(row.vector),
    createdAt: row.created_at,
  }));
}

/**
 * D2 (docs/audit/production-proposal-and-enhancements.md, fixes A§2.3) —
 * `scoredSearch` already resolves every embedding's `refId` during a scan;
 * this deletes exactly the ones that turned out orphaned (their moment/
 * knowledge entry no longer exists) right there, by id, rather than a
 * separate `NOT IN (SELECT ...)` sweep re-deriving the same fact later.
 */
export async function deleteEmbeddingsByIds(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const db = getDb();
  const result = await db.delete(memoryEmbeddings).where(inArray(memoryEmbeddings.id, ids));
  return result.rowsAffected;
}

/**
 * Replaces one row's vector + model tag in place — used by the backfill
 * (`reembedStaleEmbeddings`) to migrate a row written under a since-abandoned
 * embedding scheme forward to the current one, without changing its id or ref.
 */
export async function updateEmbeddingVector(id: string, vector: number[], model: string): Promise<void> {
  const db = getDb();
  await db.update(memoryEmbeddings).set({ vector: vectorToBuffer(vector), model }).where(eq(memoryEmbeddings.id, id));
}
