import { sql } from 'drizzle-orm';
import { getDb } from '../db-client.js';

export interface RedactionBySource {
  sourceType: string;
  /** Individual property values scrubbed, not events — one event can redact several. */
  redactions: number;
  events: number;
}

export interface RedactionHealth {
  windowHours: number;
  totalRedactions: number;
  /** Event types that produced at least one redaction, busiest first. */
  bySource: RedactionBySource[];
  /** Property names scrubbed at least once, e.g. `windowTitle`, `cwd`, `attendees`. */
  properties: string[];
  /** Sensor events in the window that CAN carry a redactable property. The denominator. */
  redactableEvents: number;
}

/**
 * Every event type `sanitizeAtIngest` is expected to scrub something in.
 *
 * The list is what makes the health check falsifiable rather than decorative. Knowing
 * that 5,000 redactions happened says nothing on its own — a redaction layer that
 * silently stopped would also report a number, just a smaller one, and nobody would
 * notice. Knowing that redactable events arrived and produced ZERO redactions is a
 * real alarm, and this is the list that lets the question be asked.
 *
 * Derived from the live log's own 2026-08-14 distribution: `window:changed` (window
 * titles), `file:changed`/`symbol:edited`/`project:*` (paths and project roots),
 * `git:*` (working directories), `shell:command` (cwd), `calendar:*` (attendees),
 * `agent:session` (paths).
 */
const REDACTABLE_EVENT_TYPES = ['changed', 'edited', 'detected', 'switched', 'status', 'commit', 'pr-status', 'command', 'upcoming', 'active', 'session'];

/**
 * How much `sanitizeAtIngest` actually scrubbed, and out of how much traffic.
 *
 * `privacy:redacted` rows are written on every redaction and, until 2026-08-14, were
 * read by absolutely nothing — 8,712 rows and 602 KB of audit trail nobody audited.
 * The decision recorded in `enhancements/collected-but-unused-data` (retired from
 * the almanac once built) was to
 * keep them and give them a reader rather than stop writing them, because they are
 * the ONLY evidence that redaction is running at all. Redaction failing open is a
 * silent, security-relevant failure: nothing errors, nothing looks wrong, and
 * unsanitized values simply begin flowing into the log, entity facts and embeddings.
 *
 * Reads the log directly rather than `KernelState`, because this is a health question
 * about history rather than a fact about now — the same reason the coverage
 * measurement reads the log.
 */
export async function getRedactionHealth(sinceIso: string, windowHours = 24): Promise<RedactionHealth> {
  const db = getDb();

  const rows =
    (await db.all<{ source: string | null; redactions: number | null; events: number; properties: string }>(sql`
      SELECT json_extract(data, '$.sourceType') AS source,
             SUM(COALESCE(json_extract(data, '$.total'), 0)) AS redactions,
             COUNT(*) AS events,
             GROUP_CONCAT(json_extract(data, '$.properties')) AS properties
      FROM signals
      WHERE signal_type = 'privacy' AND captured_at >= ${sinceIso}
      GROUP BY source
      ORDER BY redactions DESC`)) ?? [];

  const properties = new Set<string>();
  for (const row of rows) {
    for (const blob of (row.properties ?? '').split(/(?<=})\s*,\s*(?={)/)) {
      try {
        for (const key of Object.keys(JSON.parse(blob) as Record<string, unknown>)) properties.add(key);
      } catch {
        continue;
      }
    }
  }

  const redactable =
    (
      await db.all<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM signals
      WHERE captured_at >= ${sinceIso} AND event_type IN (${sql.join(
        REDACTABLE_EVENT_TYPES.map((t) => sql`${t}`),
        sql`, `,
      )})`)
    )[0]?.n ?? 0;

  return {
    windowHours,
    totalRedactions: rows.reduce((sum, r) => sum + (r.redactions ?? 0), 0),
    bySource: rows.filter((r) => r.source).map((r) => ({ sourceType: String(r.source), redactions: r.redactions ?? 0, events: r.events })),
    properties: [...properties].sort(),
    redactableEvents: redactable,
  };
}
