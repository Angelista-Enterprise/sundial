import { z } from 'zod';
import { countSignalsInRange, getAllEntities, getGateDecisionsBetween, getMomentsBetween, getPromises, getSignalsInRange, loadAliasNames, type StoredMoment, type StoredSignal } from '@sundial/db/index.js';
import { localDate, localDayRange, localHour } from '@sundial/helpers/local-day.js';
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js';
import { blindSpots, didITypes, judgeDidI, namesFor, needlesFor, parseDidI } from '../did-i.js';
import { buildTimeline, keepRow, postmortemDraft, TIMELINE_TYPES, type LogRow, type MomentRow } from '../flight-recorder.js';
import { DEFAULT_GATE_POLICY, policyForBias, type Channel } from '../gate.js';
import { loadLatestSnapshot } from '../snapshot.js';
import { backtestTypes, backtestWatch, resolvePeople, validateWatchRule, type WatchRule } from '../watch.js';
import { candidateOf, whatIf, type ReplayItem } from '../what-if.js';
import { pageWithinBudget, RESULT_BUDGET_CHARS } from './evidence-tools.js';
import type { GnomonTool } from './registry.js';

/*
 * Lane A — three read tools over the whole log: "did I…?" (UC5), the flight
 * recorder (UC10) and the policy replay (UC9). The arithmetic lives in
 * `did-i.ts`, `flight-recorder.ts` and `what-if.ts` as pure functions; these
 * handlers only read the rows and hand them over.
 */

const zone = (): string => loadSundialConfig().timezone;
const DAY_MS = 86_400_000;

const toRow = (s: StoredSignal): LogRow => ({ id: s.id, type: `${s.signalType}:${s.eventType}`, ts: s.capturedAt, data: s.data });
const toMoment = (m: StoredMoment): MomentRow => ({ id: m.id, start: m.startTime, end: m.endTime, projectId: m.projectId, process: m.processName, data: m.data });

/** Every row of `types` in `[from, to)`, oldest first, paged so a busy stretch is read whole. */
async function readAll(from: string, to: string, types: string[], contains?: string, cap = 50_000): Promise<StoredSignal[]> {
  const out: StoredSignal[] = [];
  for (let offset = 0; offset < cap; offset += 5000) {
    const rows = await getSignalsInRange(from, to, 5000, types, offset, contains);
    out.push(...rows);
    if (rows.length < 5000) break;
  }
  return out;
}

/**
 * A `person-<hash>` is never shown to the owner: it becomes the name the
 * record holds for it, or "someone unnamed".
 */
const named = (aliasNames: Record<string, string>) => (text: string) => text.replace(/person-[0-9a-f]{6,}/gi, (h) => aliasNames[h] ?? 'someone unnamed');

/** Names of people the record holds, hashes left out. */
async function peopleNames(): Promise<string[]> {
  return (await getAllEntities()).filter((e) => e.kind === 'person' && !/^person-[0-9a-f]{6,}$/i.test(e.canonicalName)).map((e) => e.canonicalName);
}

/** `HH:MM` on a local day, as an instant. */
function atClock(day: string, hhmm: string | undefined, fallback: string, tz: string): string {
  if (!hhmm) return fallback;
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.parse(localDayRange(day, tz).start) + ((h ?? 0) * 60 + (m ?? 0)) * 60_000).toISOString();
}

export const RECALL_TOOLS: GnomonTool[] = [
  {
    name: 'gnomon_did_i',
    description:
      'Answers "did I …?" — did I reply to Mira, push BOX-484, send the invoice, go to the retro — with the rows that show it, or "no sign of it". Pass the question\'s own words as `what`. It reads the action (reply/mail, push, commit, PR, went to a meeting, ran, opened, said), any ticket key, the person (resolved to every name the record holds for them) and the words the thing is called, then checks sent and received mail, commits, pushes, PRs, commands, calendar, pages, documents, moments and promises in the window. `answer` is "yes" when a row is the doing itself (a sent mail to them, a push of that branch, a moment in that meeting with the mic on), "related only" when rows name the thing without doing it, else "no sign of it" — then say what was searched and what the record cannot see (`blind`). Quote the evidence with its time; each row carries its id. For a reply it also says when they last wrote and whether a mail to them came after.',
    schema: {
      what: z.string().min(2).describe('The question in the owner\'s words, e.g. "reply to Mira", "push BOX-484", "send the invoice", "go to the retro"'),
      person: z.string().optional().describe('The person, when the words do not name them plainly'),
      days: z.number().int().positive().max(60).optional().describe('How far back to look (default 14)'),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Only this day (YYYY-MM-DD, owner time), e.g. for "did I … yesterday"'),
    },
    readOnly: true,
    handler: async ({ what, person, days, date }) => {
      const tz = zone();
      const now = new Date().toISOString();
      const span = (days as number | undefined) ?? 14;
      const range = typeof date === 'string' ? localDayRange(date, tz) : { start: new Date(Date.now() - span * DAY_MS).toISOString(), end: now };
      const [aliasNames, people, promises] = await Promise.all([loadAliasNames(), peopleNames(), getPromises(200)]);
      const q = parseDidI(String(what), { person: person as string | undefined, aliasNames, people });
      const types = didITypes(q.action);
      const needles = needlesFor(q);
      // One read per needle (the SQL holds one substring), merged by id; with
      // nothing to look for, the action's own rows in the window.
      const reads = needles.length > 0 ? await Promise.all(needles.map((n) => getSignalsInRange(range.start, range.end, 1000, types, 0, n))) : [await getSignalsInRange(range.start, range.end, 1000, types)];
      const byId = new Map<string, StoredSignal>();
      for (const list of reads) for (const r of list) byId.set(r.id, r);
      const rows = [...byId.values()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)).map(toRow);
      const moments = needles.length > 0 ? (await getMomentsBetween(range.start, range.end, needles, 500)).map(toMoment) : [];
      const sent = await countSignalsInRange(range.start, range.end, ['mail:sent']);
      const answer = judgeDidI(q, rows, moments, promises, tz);
      const show = named(aliasNames);
      return {
        answer: answer.answer,
        read: { action: q.action, tickets: q.tickets, person: q.person ? { asked: q.person.asked, namesKnown: q.person.names.length } : null, words: q.keys },
        evidence: answer.evidence.map((e) => ({ ...e, text: show(e.text) })),
        ...(answer.more > 0 ? { more: `${answer.more} more matching rows not shown; gnomon_signals with contains=<a word above> and a date opens them` } : {}),
        ...(answer.reply ? { reply: answer.reply.lastFromThem ? { theyLastWrote: answer.reply.lastFromThem.at, subject: show(answer.reply.lastFromThem.subject), mailToThemAfter: answer.reply.sentAfter } : { theyLastWrote: null } } : {}),
        searched: { from: range.start, to: range.end, types, rowsMatched: rows.length, momentsMatched: moments.length, promisesRead: promises.length, sentMailInWindow: sent },
        blind: blindSpots(q, { 'mail:sent': sent }),
      };
    },
  },
  {
    name: 'gnomon_timeline',
    description:
      'The flight recorder: one timeline of a window ("what happened 14:00–16:00 on puzzlebox", "what was I doing at 3"), and a postmortem draft. It orders commands, commits, pushes, PRs, pages, meetings, mail, agent waits, focus and time away; use it for "walk me through this morning" too. One day per call (`date`), narrowed with `from`/`to` (HH:MM owner time), `project` (rows naming it and moments attributed to it; away/back lines always stay), `person`, `contains`. Repeats are folded into one line with `n` (the same command run five times, a PR re-reported, twelve file saves). Each line keeps the id of its row. Pass `postmortem: true` for a write-up skeleton from the same rows: what happened, what went wrong (failing commands and when they passed, red CI, reverts, force pushes), what resolved it, and the questions only the owner can answer. Lines come a page at a time; `nextOffset` reads on.',
    schema: {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD in the owner timezone, defaults to today'),
      from: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('HH:MM owner time: from here on'),
      to: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('HH:MM owner time: up to here'),
      project: z.string().optional().describe('A project name or folder, e.g. "puzzlebox"'),
      person: z.string().optional().describe('Only what names this person'),
      contains: z.string().optional().describe('Only rows holding these words'),
      postmortem: z.boolean().optional().describe('Also return a postmortem draft built from the same rows'),
      limit: z.number().int().positive().max(200).optional().describe('Lines per page (default 60)'),
      offset: z.number().int().min(0).optional().describe('Where to start: the nextOffset of the previous page'),
    },
    readOnly: true,
    handler: async ({ date, from, to, project, person, contains, postmortem, limit, offset }) => {
      const tz = zone();
      const day = (date as string | undefined) ?? localDate(new Date().toISOString(), tz);
      const whole = localDayRange(day, tz);
      const start = atClock(day, from as string | undefined, whole.start, tz);
      const end = atClock(day, to as string | undefined, whole.end, tz);
      const [signals, moments, aliasNames, people] = await Promise.all([readAll(start, end, TIMELINE_TYPES), getMomentsBetween(start, end, [], 2000), loadAliasNames(), person ? peopleNames() : Promise.resolve([])]);
      const filter = {
        ...(project ? { project: String(project) } : {}),
        ...(person ? { people: namesFor(String(person), aliasNames, people) } : {}),
        ...(contains ? { contains: String(contains) } : {}),
      };
      const rows = signals.map(toRow);
      const lines = buildTimeline(rows, moments.map(toMoment), tz, filter);
      const show = named(aliasNames);
      const window = `${day} ${(from as string | undefined) ?? '00:00'}–${(to as string | undefined) ?? '24:00'}`;
      const draft = postmortem ? postmortemDraft(rows.filter((r) => keepRow(r, filter)), lines, tz, `${project ? `${String(project)}, ` : ''}${window} (owner time)`) : null;
      const draftText = draft ? draft.lines.map(show).join('\n') : '';
      const page = pageWithinBudget(
        lines.map((l) => ({ at: l.at, kind: l.kind, text: show(l.text), id: l.id, ...(l.n ? { n: l.n } : {}) })),
        { offset: offset as number | undefined, limit: (limit as number | undefined) ?? 60, budget: RESULT_BUDGET_CHARS - draftText.length - 400 },
      );
      return {
        window,
        ...(Object.keys(filter).length > 0 ? { filter: { project: project ?? null, person: person ?? null, contains: contains ?? null } } : {}),
        rowsRead: rows.length,
        momentsRead: moments.length,
        ...page,
        ...(draft ? { postmortem: draftText, postmortemCounts: draft.counts } : {}),
        ...(lines.length === 0 ? { note: 'Nothing in the record for this window and filter. Widen from/to, or drop the project filter: rows name a project by its folder or branch.' } : {}),
      };
    },
  },
  {
    name: 'gnomon_what_if',
    description:
      'Replays recorded notices through the gate with a change: "with a cap of 3, which pings would I have missed?", or "had this rule been on". Every notice candidate on record goes through the gate\'s own arithmetic twice — as it stands (the owner\'s dial) and changed: `cap` (interruptions a day, now 6), `budget` (list notices a day, now 4), `dial` (the notice dial: -1 halves both bars and says more, +1 doubles them and says less), `mute` (notice kinds to switch off, e.g. ["agent-waiting"], a trailing * for a family), `rule` (an adopted watch rule id or a new spec, whose backtested fires join the stream so they compete for the same cap and budget). Returns both counts, the `delta` with n, the interruptions `missed` and `gained` with their words and times, heard per kind where it moves, and `agreement`: how often the replay matches what the gate actually did. Report the delta and its n, not a percentage.',
    schema: {
      days: z.number().int().positive().max(60).optional().describe('How many past days to report on (default 30). The replay itself starts at the first candidate on record, so habituation is warm.'),
      cap: z.number().int().min(0).max(30).optional().describe('Interruptions per day (phasic cap)'),
      budget: z.number().int().min(0).max(30).optional().describe('List notices per day (tonic budget)'),
      dial: z.number().min(-3).max(3).optional().describe('The notice dial to try instead of the current one'),
      mute: z.array(z.string()).optional().describe('Notice kinds to switch off'),
      rule: z.any().optional().describe('A watch rule: an adopted rule id, or a spec object as gnomon_test_rule takes'),
    },
    readOnly: true,
    handler: async ({ days, cap, budget, dial, mute, rule }) => {
      const snapshot = await loadLatestSnapshot();
      const tz = snapshot?.state.config.timezone ?? zone();
      const settings = snapshot?.state.settings;
      const span = (days as number | undefined) ?? 30;
      const now = new Date().toISOString();
      const from = new Date(Date.now() - span * DAY_MS).toISOString();
      const base = policyForBias(settings?.noticeBias ?? 0);
      const variant = {
        ...policyForBias(typeof dial === 'number' ? dial : (settings?.noticeBias ?? 0)),
        ...(typeof cap === 'number' ? { phasicDailyCap: cap } : {}),
        ...(typeof budget === 'number' ? { dailyBudget: budget } : {}),
      };
      const epoch = '1970-01-01T00:00:00.000Z';
      const [rows, decisions] = await Promise.all([readAll(epoch, now, ['notice:candidate']), getGateDecisionsBetween(epoch, now)]);
      // A decision row is keyed by the candidate's own instant and key.
      const recorded = new Map(decisions.map((d) => [`${d.decidedAt}|${d.noticeKey}`, d]));
      const items: ReplayItem[] = [];
      for (const r of rows) {
        const candidate = candidateOf(r.data);
        if (!candidate) continue;
        const d = recorded.get(`${r.capturedAt}|${candidate.key}`);
        items.push({
          id: r.id,
          ts: r.capturedAt,
          candidate,
          // The row stores the priced cost (cost × weight); the replay wants the 0..1 cost back.
          ...(d && d.interruptionCost > 0 ? { cost: d.interruptionCost / DEFAULT_GATE_POLICY.interruptionCostWeight } : {}),
          ...(d ? { recorded: d.channel as Channel } : {}),
        });
      }
      let added: ReplayItem[] | undefined;
      let ruleNote: Record<string, unknown> = {};
      if (rule !== undefined && rule !== null && rule !== '') {
        const adopted = typeof rule === 'string' ? snapshot?.state.watch?.rules.find((r) => r.id === rule) : undefined;
        let spec: unknown = adopted ?? rule;
        if (!adopted && typeof spec === 'string') {
          try {
            spec = JSON.parse(spec);
          } catch {
            return { error: `No adopted rule "${String(rule)}", and it is not a JSON spec either. gnomon_test_rule with no rule lists the adopted ones.` };
          }
        }
        const checked = adopted ? { rule: adopted as WatchRule } : validateWatchRule(resolvePeople(spec, snapshot?.state.memory.aliasNames ?? {}));
        if ('error' in checked) return { error: checked.error };
        const events = (await readAll(from, now, backtestTypes(checked.rule), undefined, 400_000)).map((s) => ({ id: s.id, type: `${s.signalType}:${s.eventType}`, ts: s.capturedAt, payload: s.data }));
        const { fires } = backtestWatch(checked.rule, events, { daytime: (ts) => localHour(ts, tz) >= 6 && localHour(ts, tz) < 18, timeZone: tz });
        added = fires.map((f, i) => ({ id: `rule:${i}`, ts: f.at, candidate: f.candidate }));
        ruleNote = { rule: { id: checked.rule.id, adopted: adopted !== undefined, fires: fires.length } };
      }
      const result = whatIf(items, { base, variant, change: { ...(typeof cap === 'number' ? { cap } : {}), ...(typeof budget === 'number' ? { budget } : {}), ...(Array.isArray(mute) ? { mute: mute as string[] } : {}) }, from, days: span, zone: tz, ...(added ? { added } : {}) });
      return {
        change: { cap: cap ?? null, budget: budget ?? null, dial: dial ?? null, mute: mute ?? [], ...ruleNote },
        current: { cap: base.phasicDailyCap, budget: base.dailyBudget, dial: settings?.noticeBias ?? 0 },
        ...(settings?.autonomy === 'off' ? { autonomyOff: 'Autonomy is off, so in fact nothing is said at all; the counts are what the gate would decide with it on.' } : {}),
        ...result,
      };
    },
  },
];
