import { and, asc, eq, gte, lt, or } from 'drizzle-orm';
import { localDayRange } from '@sundial/helpers/local-day.js';
import { getDb } from '../db-client.js';
import { signals } from '../schemas/db-schema.js';

/**
 * The file-level record of a day's coding, aggregated out of raw `signals`.
 *
 * This exists because `/ask` could not answer "what did I do today for gnomon,
 * files edited etc." even though the record plainly contained the answer.
 * `scoredSearch` — the only retrieval `/ask` had — ranks `memory_embeddings`
 * rows, whose ref types are `moment`, `knowledge_entry`, and `entity_fact`.
 * Raw signals are not an embedding ref type and never will be (embedding 3800
 * `input:activity` ticks a day is not retrieval, it is noise), so the exact
 * file paths in `symbol:edited` and the commit subjects in `git:commit` had no
 * path to a prompt at all.
 *
 * The second reason is shape, not reach: "files edited today for gnomon" is a
 * filter-and-aggregate question (date range ∧ project ∧ group by file), and a
 * top-K cosine ranking has nowhere to put a WHERE clause. Even with signals
 * embedded, similarity search would return *some* edits, never *the* edits.
 * So this is a plain SQL query the model calls as a tool, not a retrieval.
 *
 * Three signal kinds carry the evidence, in descending order of usefulness:
 *
 * - `symbol:edited` — `{ projectRoot, edits: [{ file, symbols, hunkCount }] }`.
 *   The best source: the file path AND the function names inside it.
 * - `git:commit` — `{ commitLine, branch, cwd, insertions, deletions, filesChanged }`.
 *   What actually landed, as the owner's own words.
 * - `file:changed` — `{ projectRoot, changes: [{ relPath, kind }] }`. The
 *   fallback for a project with no symbol coverage, filtered for editor
 *   scratch files (see `isTransientPath`).
 *
 * `projectRoot` is matched as a suffix rather than an equality: the payloads
 * store a tilde-abbreviated path (`~/Projects/acme/gnomon`), while a caller —
 * an LLM answering a question about "gnomon" — has a bare project name. Both
 * `gnomon` and `~/Projects/acme/gnomon` therefore resolve.
 */
export interface FileEditSummary {
  /** Project-relative path, as the sensor recorded it. */
  file: string;
  /** Distinct symbol names seen edited in this file across the day, most-recent-first order preserved. */
  symbols: string[];
  /** Number of `symbol:edited`/`file:changed` observations naming this file — a rough "how often did I come back to it". */
  edits: number;
  firstEditedAt: string;
  lastEditedAt: string;
}

export interface CommitSummary {
  /** The raw `<sha> <subject>` line as git printed it. */
  commitLine: string;
  branch: string | null;
  insertions: number | null;
  deletions: number | null;
  filesChanged: number | null;
  committedAt: string;
}

export interface CodeActivitySummary {
  date: string;
  /** Echoes the filter that was applied, or null when the whole day was read across every project. */
  projectRoot: string | null;
  /** Every project root that produced code activity on this date — the answer to "which projects did I touch". */
  projectsTouched: string[];
  /** Branches seen in `git:commit`/`agent:session` payloads for the filtered project. */
  branches: string[];
  files: FileEditSummary[];
  commits: CommitSummary[];
  /** Set when `symbol:edited` produced nothing and `files` was derived from `file:changed` alone. */
  note?: string;
}

/**
 * Editor-and-toolchain debris that is not "a file the owner edited".
 *
 * Atomic-save editors write `foo.ts.tmp.33172.5ea25718330e`, then delete it —
 * both halves land in `file:changed`, and the live log shows the tmp file
 * outnumbering the real one. Reporting those as edited files would be worse
 * than reporting nothing, because it reads as authoritative.
 */
function isTransientPath(relPath: string): boolean {
  return (
    /\.tmp\.\d+\./.test(relPath) ||
    relPath.endsWith('~') ||
    relPath.includes('/.git/') ||
    relPath.startsWith('.git/') ||
    relPath.includes('/node_modules/') ||
    relPath.startsWith('node_modules/') ||
    relPath.includes('/dist/') ||
    relPath.startsWith('dist/') ||
    /\.(swp|swo|lock)$/.test(relPath) ||
    /(^|\/)\.DS_Store$/.test(relPath)
  );
}

/**
 * A tilde-abbreviated root (`~/Projects/acme/gnomon`) matches a caller's bare
 * name (`gnomon`) or a full path. Case-insensitive, and anchored at a path
 * segment so `gnomon` does not match `not-gnomon`.
 */
function rootMatches(root: string | null | undefined, filter: string): boolean {
  if (!root) return false;
  const haystack = root.toLowerCase().replace(/\/+$/, '');
  const needle = filter.toLowerCase().replace(/\/+$/, '').replace(/^~?\//, '');
  if (!needle) return true;
  return haystack === needle || haystack.endsWith(`/${needle}`) || haystack.includes(`/${needle}/`);
}

interface FileEditAccumulator {
  symbols: Set<string>;
  edits: number;
  firstEditedAt: string;
  lastEditedAt: string;
}

function record(acc: Map<string, FileEditAccumulator>, file: string, symbols: string[], at: string): void {
  const existing = acc.get(file);
  if (!existing) {
    acc.set(file, { symbols: new Set(symbols), edits: 1, firstEditedAt: at, lastEditedAt: at });
    return;
  }
  for (const symbol of symbols) existing.symbols.add(symbol);
  existing.edits += 1;
  if (at < existing.firstEditedAt) existing.firstEditedAt = at;
  if (at > existing.lastEditedAt) existing.lastEditedAt = at;
}

/**
 * `date` is a calendar date in `timeZone` (the owner's day, not UTC's — see
 * `localDayRange`). `projectRoot` filters to one project; omitting it reports
 * every project the day touched, which is what "what did I work on today"
 * without a named project should return.
 *
 * One indexed range scan over `captured_at` for the three relevant
 * `signal_type`s, then folded in JS: the payloads are JSON with variable-length
 * `edits`/`changes` arrays, so there is no fixed column set to GROUP BY in SQL.
 */
export async function getCodeActivityForDate(date: string, timeZone = 'UTC', projectRoot?: string): Promise<CodeActivitySummary> {
  const db = getDb();
  const { start, end } = localDayRange(date, timeZone);

  const rows = await db
    .select({ signalType: signals.signalType, eventType: signals.eventType, data: signals.data, capturedAt: signals.capturedAt })
    .from(signals)
    .where(
      and(
        gte(signals.capturedAt, start),
        lt(signals.capturedAt, end),
        or(eq(signals.signalType, 'symbol'), eq(signals.signalType, 'git'), eq(signals.signalType, 'file'), eq(signals.signalType, 'agent')),
      ),
    )
    .orderBy(asc(signals.capturedAt));

  const fromSymbols = new Map<string, FileEditAccumulator>();
  const fromFileWatcher = new Map<string, FileEditAccumulator>();
  const commits: CommitSummary[] = [];
  const projectsTouched = new Set<string>();
  const branches = new Set<string>();

  for (const row of rows) {
    const payload = JSON.parse(row.data) as Record<string, unknown>;
    // `git:commit` carries the root as `cwd`; the file/symbol sensors as `projectRoot`.
    const root = (payload.projectRoot ?? payload.cwd) as string | null | undefined;
    if (root) projectsTouched.add(root);
    if (projectRoot && !rootMatches(root, projectRoot)) continue;

    const branch = payload.branch as string | null | undefined;
    if (branch) branches.add(branch);

    if (row.signalType === 'symbol' && row.eventType === 'edited') {
      const edits = (payload.edits ?? []) as { file?: string; symbols?: string[] }[];
      for (const edit of edits) {
        if (!edit.file || isTransientPath(edit.file)) continue;
        record(fromSymbols, edit.file, edit.symbols ?? [], row.capturedAt);
      }
      continue;
    }

    if (row.signalType === 'file' && row.eventType === 'changed') {
      const changes = (payload.changes ?? []) as { relPath?: string; kind?: string }[];
      for (const change of changes) {
        // A delete of a scratch file is the other half of an atomic save, not a deletion the owner performed.
        if (!change.relPath || isTransientPath(change.relPath) || change.kind === 'delete') continue;
        record(fromFileWatcher, change.relPath, [], row.capturedAt);
      }
      continue;
    }

    if (row.signalType === 'git' && row.eventType === 'commit' && typeof payload.commitLine === 'string') {
      commits.push({
        commitLine: payload.commitLine,
        branch: branch ?? null,
        insertions: typeof payload.insertions === 'number' ? payload.insertions : null,
        deletions: typeof payload.deletions === 'number' ? payload.deletions : null,
        filesChanged: typeof payload.filesChanged === 'number' ? payload.filesChanged : null,
        committedAt: row.capturedAt,
      });
    }
  }

  // Symbol edits are strictly better evidence (they name functions, not just
  // files), so the file-watcher fallback is used only when they are absent
  // rather than merged into them — merging would double-count every save.
  const usedFallback = fromSymbols.size === 0 && fromFileWatcher.size > 0;
  const chosen = usedFallback ? fromFileWatcher : fromSymbols;

  const files: FileEditSummary[] = [...chosen.entries()]
    .map(([file, acc]) => ({ file, symbols: [...acc.symbols], edits: acc.edits, firstEditedAt: acc.firstEditedAt, lastEditedAt: acc.lastEditedAt }))
    .sort((a, b) => b.edits - a.edits || a.file.localeCompare(b.file));

  return {
    date,
    projectRoot: projectRoot ?? null,
    projectsTouched: [...projectsTouched].sort(),
    branches: [...branches].sort(),
    files,
    commits,
    ...(usedFallback ? { note: 'No symbol-level edits were recorded for this project/date; files were derived from filesystem-watch events, so no function names are available.' } : {}),
  };
}
