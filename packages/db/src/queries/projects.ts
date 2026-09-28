import { eq } from 'drizzle-orm';
import { getDb } from '../db-client.js';
import { commitments, moments, organizations, projects } from '../schemas/db-schema.js';

export interface StoredProject {
  id: string;
  name: string;
  rootPath: string;
  organizationId: string | null;
  createdAt: string;
}

export interface UpsertProjectInput {
  id: string;
  name: string;
  rootPath: string;
  organizationId?: string | null;
}

/**
 * Upsert, not a plain insert — `id` is the project's root path (deterministic,
 * no DB lookup needed to assign it), so re-detecting the same project on
 * every `project:detected` re-fire is expected and should just refresh the
 * row, not collide on the primary key. Same idempotency principle as
 * `insertMoment` (packages/db/src/queries/moments.ts).
 */
export async function upsertProject(input: UpsertProjectInput): Promise<void> {
  const db = getDb();
  const row = {
    id: input.id,
    name: input.name,
    rootPath: input.rootPath,
    organizationId: input.organizationId ?? null,
    createdAt: new Date().toISOString(),
  };
  await db
    .insert(projects)
    .values(row)
    .onConflictDoUpdate({ target: projects.id, set: { name: row.name, organizationId: row.organizationId } });
}

export async function getProjectByRootPath(rootPath: string): Promise<StoredProject | null> {
  const db = getDb();
  const rows = await db.select().from(projects).where(eq(projects.rootPath, rootPath)).limit(1);
  return rows[0] ?? null;
}

export async function getAllProjects(): Promise<StoredProject[]> {
  const db = getDb();
  return db.select().from(projects);
}

export interface UpsertOrganizationInput {
  id: string;
  name: string;
}

/**
 * Upsert by `id` (the remote-derived owner slug) — one org is shared across
 * many projects, so re-detecting any of them re-writes the same row rather
 * than colliding. Same idempotency principle as `upsertProject`.
 */
export async function upsertOrganization(input: UpsertOrganizationInput): Promise<void> {
  const db = getDb();
  await db
    .insert(organizations)
    .values({ id: input.id, name: input.name, createdAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: organizations.id, set: { name: input.name } });
}

/**
 * Folds project `from` into project `into` everywhere a project id is stored,
 * then drops `from`'s own row. The repair half of `projectTrack`'s merge: the
 * resolver already sends NEW windows to the real root, and this moves the rows
 * the synthetic id collected before that root was known. Idempotent — a replay
 * finds nothing left pointing at `from`.
 */
export async function mergeProjectRows(from: string, into: string): Promise<{ moments: number; commitments: number }> {
  const db = getDb();
  const movedMoments = await db.update(moments).set({ projectId: into }).where(eq(moments.projectId, from));
  const movedCommitments = await db.update(commitments).set({ projectId: into }).where(eq(commitments.projectId, from));
  await db.delete(projects).where(eq(projects.id, from));
  return { moments: movedMoments.rowsAffected ?? 0, commitments: movedCommitments.rowsAffected ?? 0 };
}
