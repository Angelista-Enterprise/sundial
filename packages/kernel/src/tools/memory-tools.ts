import { z } from 'zod';
import { findEntitiesByName, getAllEntities, getCurrentEntityFacts, getEntityFactTimeline, getKnowledgeEntriesForDate, getMomentsMentioning, getPromises, loadAliasNames, scoredSearch } from '@sundial/db/index.js';
import { promiseReliability } from '../promise-reliability.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js';
import { factRecordLine } from '../fact-tests.js';
import { loadLatestSnapshot } from '../snapshot.js';
import type { GnomonTool } from './registry.js';

function today(): string {
  return localDate(new Date().toISOString(), loadSundialConfig().timezone);
}

/**
 * The derived-memory tools: what Gnomon concluded, rather than what it observed.
 *
 * `gnomon_semantic_search` is the retriever `/ask` used to be limited to, now
 * one option among ten rather than the whole context. It ranks well — the
 * aspirations registry measures its top-5 hit rate at 81.8% against the gold
 * set — but ranking is not reach: it only ever returns rows that exist in
 * `memory_embeddings`, whose ref types are `moment`, `knowledge_entry`, and
 * `entity_fact`. Anything the model wants that is not one of those three has to
 * come from a different tool, which is the entire reason the others exist.
 */
export const MEMORY_TOOLS: GnomonTool[] = [
  {
    name: 'gnomon_anomalies',
    description: "Get the day's detected anomalies (unusual activity patterns) with the companion's note about each.",
    schema: { date: z.string().optional().describe('YYYY-MM-DD, defaults to today') },
    readOnly: true,
    handler: async ({ date }) => {
      const entries = await getKnowledgeEntriesForDate((date as string | undefined) ?? today(), loadSundialConfig().timezone);
      return entries.filter((entry) => entry.kind === 'companion-insight');
    },
  },
  {
    name: 'gnomon_goals',
    description:
      "What the owner has said they want, and where each one stands. `status` is their own word for it — typically \"open\" with a note, \"done\", or \"dropped\". Use it before offering to help with something, before asking what to work on, and when a conversation touches a goal so you can say whether it is still open. These are the OWNER'S goals, not Gnomon's own research question (that one is in the ambient context). Record a new one, or a change of status, with gnomon_assert on kind 'goal' and predicate 'status'.",
    schema: {},
    readOnly: true,
    handler: async () => {
      // The same read the owner's Goals surface makes, so the two cannot be
      // looking at different lists. A goal is an `entities` row of kind 'goal'
      // whose `status` is a current `knownAs`-style belief on it — no new table
      // and no new entity kind; both already existed and neither was readable.
      const entities = await getAllEntities();
      const goals = entities.filter((entity) => entity.kind === 'goal');
      const rows = await Promise.all(
        goals.map(async (entity) => {
          const facts = await getCurrentEntityFacts(entity.id);
          const status = facts.find((fact) => fact.predicate === 'status');
          return {
            goal: entity.canonicalName,
            status: status?.object ?? 'open',
            since: status?.validFrom ?? null,
            // Whose word it is. `assertion` is the owner's own; anything else
            // Gnomon worked out, and should be offered rather than stated.
            saidBy: status?.provenance === 'assertion' ? 'owner' : (status?.provenance ?? null),
            otherFacts: facts.filter((fact) => fact.predicate !== 'status').map((fact) => `${fact.predicate} ${fact.object}`),
          };
        }),
      );
      // Open first: a settled goal is a record, an open one is a claim on the
      // owner's attention.
      return rows.sort((a, b) => Number(/^(done|dropped)/i.test(a.status)) - Number(/^(done|dropped)/i.test(b.status)) || a.goal.localeCompare(b.goal));
    },
  },
  {
    name: 'gnomon_people',
    description:
      'The roster: everyone the owner has been in a meeting with, their name, how many facts are held about them, and (`promises`) what the owner owes them, what they owe the owner, and how many promises to them were kept, of how many closed. Use it for "who do I work with", "who have I not seen lately", or before naming a person you are unsure of. `entity: false` marks someone the calendar sent as a bare address and nothing on this machine could put a name to — refer to them as "an unnamed attendee", NEVER by the person-<hash> id, which means nothing to the owner. For one person\'s full history use gnomon_entity_history.',
    schema: {},
    readOnly: true,
    handler: async () => {
      // The same two reads the owner's People surface makes, so the model and
      // the owner cannot be looking at different rosters. `loadAliasNames` is
      // the identity join: a hashed attendee's entity is named for its hash and
      // the human name is a `knownAs` belief on it.
      const [entities, aliasNames, promises] = await Promise.all([getAllEntities(), loadAliasNames(), getPromises(500)]);
      const people = entities.filter((entity) => entity.kind === 'person');
      // U1-F41: what is owed between the owner and each person, with its n.
      const ledgers = new Map(promiseReliability(promises, (who) => aliasNames[who] ?? who).byPerson.map((l) => [l.who.toLowerCase(), l]));
      return Promise.all(
        people.map(async (entity) => {
          const resolved = aliasNames[entity.canonicalName];
          const hashed = /^person-[0-9a-f]{6,}$/i.test(entity.canonicalName);
          const facts = await getCurrentEntityFacts(entity.id);
          return {
            name: resolved ?? (hashed ? null : entity.canonicalName),
            // Kept so a follow-up tool call has something exact to pass, and
            // labelled as an id rather than a name.
            id: entity.id,
            named: resolved !== undefined || !hashed,
            factCount: facts.length,
            metWith: facts.filter((fact) => fact.predicate === 'attendedMeetingWith').length,
            ...(() => {
              const ledger = ledgers.get((resolved ?? entity.canonicalName).toLowerCase());
              return ledger ? { promises: { youOwe: ledger.youOwe, theyOwe: ledger.theyOwe, keptToThem: `${ledger.toThem.kept} of ${ledger.toThem.n} closed` } } : {};
            })(),
          };
        }),
      );
    },
  },
  {
    name: 'gnomon_entity_history',
    description:
      "Given a person/project/tool/topic's name, return its full fact timeline — including superseded facts, so \"who was I working with on this before X\" is answerable; a belief that makes a testable prediction carries `record` (\"right 12 of 13\", marked gathering under 20 outcomes) — and `appearances`: the moments the name shows up in, each saying WHERE (meeting = among the attendees, said = in the transcript, screen = on screen or in a window title, reading = in Gnomon's own summary). A name only on screen is weaker evidence than a meeting; say which.",
    schema: { name: z.string().describe('Free-text name to match against known entities (case-insensitive substring)') },
    readOnly: true,
    handler: async ({ name }) => {
      const matches = await findEntitiesByName(name as string);
      // lane C: a belief's record against what the owner then did, from the fold.
      const records = (await loadLatestSnapshot())?.state.factTests?.records ?? {};
      const withRecord = <T extends { id: string }>(fact: T) => {
        const r = records[fact.id];
        const line = r ? factRecordLine(r) : null;
        return line ? { ...fact, record: { right: r!.right, wrong: r!.wrong, line } } : fact;
      };
      return Promise.all(
        matches.map(async (entity) => {
          const facts = await getEntityFactTimeline(entity.id);
          // A hashed attendee's `canonicalName` IS the hash, and the human name
          // is a `knownAs` fact on it. Handing the model the raw row makes it
          // say "person-c205ca11f2" to the owner — the same unreadable output
          // `ownerAsk` now refuses to put in a question. So the display name is
          // resolved here, and the alias is kept beside it as the id it is.
          const knownAs = facts.find((fact) => fact.predicate === 'knownAs' && fact.validTo === null);
          // W4 — the moments this name appears in, and where in each. Not for
          // the owner, who is in every moment by definition.
          const merged = (() => {
            try {
              return JSON.parse(entity.aliasesJson || '[]') as string[];
            } catch {
              return [];
            }
          })();
          const names = [entity.canonicalName, ...merged, ...facts.filter((f) => f.predicate === 'knownAs' && f.validTo === null).map((f) => f.object)];
          const appearances = entity.kind === 'owner' ? { total: 0, byPlace: {}, moments: [] } : await getMomentsMentioning(names, 12);
          return {
            entity: (({ aliasesJson: _raw, ...rest }) => (knownAs ? { ...rest, canonicalName: knownAs.object, alias: entity.canonicalName } : rest))(entity),
            facts: facts.map(withRecord),
            appearances,
          };
        }),
      );
    },
  },
  {
    name: 'gnomon_semantic_search',
    description:
      'Free-text query -> ranked moments/knowledge entries/entity facts by relevance + recency + importance. Good for "remind me about <topic>" where you do not know the date. It cannot filter or aggregate — for "which files on <date>" or "how many X" use gnomon_code_activity, gnomon_signals, or gnomon_today_summary, which take real filters.',
    schema: { query: z.string().describe('Free-text search query'), limit: z.number().int().positive().max(50).optional() },
    readOnly: true,
    handler: async ({ query, limit }) => scoredSearch(query as string, (limit as number | undefined) ?? 10),
  },
];
