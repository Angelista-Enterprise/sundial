import { z } from 'zod';
import {
  findEntitiesByName,
  getAllEntities,
  getEntityFactTimeline,
  getEntityGraphEdges,
  getMemoryTierCounts,
  getMomentsSince,
  getMultiDayCommitments,
  getOpenCommitments,
  getPipelineCoverage,
} from '@sundial/db/index.js';
import { localDate, localMinuteOfDay } from '@sundial/helpers/local-day.js';
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js';
import { buildDailyContext } from '../daily-context.js';
import type { Figure } from '../types.js';
import type { GnomonTool } from './registry.js';

function ownerTimeZone(): string {
  return loadSundialConfig().timezone;
}

function today(now: Date): string {
  return localDate(now.toISOString(), ownerTimeZone());
}

/** `2h 05m`, the way every other surface says a duration. */
function hm(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function hourOf(iso: string): number {
  return localMinuteOfDay(iso, ownerTimeZone()) / 60;
}

/**
 * The one tool that draws.
 *
 * Everything else in the registry answers with prose or rows; this one returns
 * a typed view-spec the client renders with the SAME components the resident
 * Study pages use. That is the whole mechanism behind the design's acceptance
 * criterion that an answer's chart and a page's chart can never disagree — they
 * are one drawing over one set of numbers, and the numbers are computed here.
 *
 * The model's role is to CHOOSE: which of the six shapes fits the question, and
 * over what window. It supplies no values. There is deliberately no free-form
 * variant, no "series of points the model provides", and no image — a figure a
 * model could author would be a chart with no evidence behind it, which is the
 * one thing this product cannot ship.
 *
 * Returned to the model as well as captured by the route, and both on purpose:
 * the route puts it on the answer, and the model sees what it drew so its prose
 * can refer to the figure instead of restating every number in it.
 */
export const FIGURE_TOOLS: GnomonTool[] = [
  {
    name: 'gnomon_compose_figure',
    description:
      "Draw a figure to show alongside your answer, instead of restating numbers in prose. Pick the shape that fits: 'dial-slice' (one day's shape, with the unobserved hatch), 'trend-slice' (N recent days compared), 'graph-neighborhood' (one entity and what it connects to), 'fact-chain' (how one belief was arrived at, link by link), 'commitment-thread' (one piece of work across days), 'census' (counts against their totals). You choose the shape and window; the numbers are computed here from the record. Call this at most once per answer, and only when seeing the shape tells the owner something the sentence cannot. Then write prose that refers to it rather than repeating it.",
    schema: {
      kind: z.enum(['dial-slice', 'trend-slice', 'graph-neighborhood', 'fact-chain', 'commitment-thread', 'census']),
      date: z.string().optional().describe('YYYY-MM-DD for dial-slice; defaults to today'),
      days: z.number().int().positive().max(90).optional().describe('How many days back for trend-slice; defaults to 7'),
      name: z.string().optional().describe('Entity name for graph-neighborhood and fact-chain, or the branch/thread name for commitment-thread'),
      predicate: z.string().optional().describe('Which predicate to trace for fact-chain, e.g. worksOn'),
    },
    readOnly: true,
    handler: async (args, env) => composeFigure(args as unknown as ComposeFigureArgs, env.now),
  },
];

interface ComposeFigureArgs {
  kind: Figure['kind'];
  date?: string;
  days?: number;
  name?: string;
  predicate?: string;
}

/**
 * Exported for the route, which captures the composed figure onto the answer,
 * and for tests. A refusal is returned as `{ unavailable }` rather than thrown:
 * the model reads it as a tool result and writes prose without a figure, which
 * is a better outcome than an error that costs a round.
 */
export async function composeFigure(args: ComposeFigureArgs, now: Date): Promise<Figure | { unavailable: string }> {
  switch (args.kind) {
    case 'dial-slice':
      return dialSlice(args.date ?? today(now), now);
    case 'trend-slice':
      return trendSlice(args.days ?? 7, now);
    case 'graph-neighborhood':
      return graphNeighborhood(args.name);
    case 'fact-chain':
      return factChain(args.name, args.predicate);
    case 'commitment-thread':
      return commitmentThread(args.name);
    case 'census':
      return census();
  }
}

async function dialSlice(date: string, now: Date): Promise<Figure | { unavailable: string }> {
  const context = await buildDailyContext(date, { timeZone: ownerTimeZone() });
  const observedMin = context.coverage.trackedMin;
  if (observedMin === 0) return { unavailable: `Nothing was observed on ${date}, so there is no shape to draw.` };

  const isToday = date === today(now);
  const curve = context.energyCurve.map((point) => ({ hour: point.hour, score: point.score }));
  const fromHour = curve.length > 0 ? Math.min(...curve.map((p) => p.hour)) : 6;

  return {
    kind: 'dial-slice',
    // The caption is the claim: how much of the window a sensor actually
    // accounted for. Composed here because that is a statement about coverage.
    caption: `dial-slice · ${isToday ? 'today' : date} · ${hm(observedMin)} observed of ${hm(context.coverage.wallClockMin)}`,
    openIn: 'today',
    date,
    fromHour,
    toHour: 24,
    observedMin,
    wallClockMin: context.coverage.wallClockMin,
    curve,
    meetings: context.meetings.map((m) => ({ startHour: hourOf(m.start), endHour: hourOf(m.end) })),
    deepBlocks: context.deepWorkBlocks.map((b) => ({ startHour: hourOf(b.start), endHour: hourOf(b.end) })),
    nowHour: isToday ? hourOf(now.toISOString()) : null,
  };
}

async function trendSlice(days: number, now: Date): Promise<Figure | { unavailable: string }> {
  const timeZone = ownerTimeZone();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const moments = await getMomentsSince(since);

  const byDay = new Map<string, number>();
  for (const moment of moments) {
    const day = localDate(moment.startTime, timeZone);
    byDay.set(day, (byDay.get(day) ?? 0) + moment.durationMs);
  }

  // Every day in the range gets a row, including the ones with nothing on them.
  // A range that silently omits its empty days reads as unbroken work, which is
  // the single most misleading thing this figure could do.
  const rows: { date: string; minutes: number; observed: boolean }[] = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    const day = localDate(new Date(now.getTime() - back * 24 * 60 * 60 * 1000).toISOString(), timeZone);
    const ms = byDay.get(day);
    rows.push({ date: day, minutes: ms ? Math.round(ms / 60000) : 0, observed: ms !== undefined });
  }

  const observedDays = rows.filter((r) => r.observed).length;
  if (observedDays === 0) return { unavailable: `Nothing was observed in the last ${days} days.` };

  const total = rows.reduce((sum, r) => sum + r.minutes, 0);
  const empty = rows.length - observedDays;
  return {
    kind: 'trend-slice',
    caption: `trend-slice · ${days} days · ${hm(total)} across ${observedDays} observed ${observedDays === 1 ? 'day' : 'days'}${empty > 0 ? `, ${empty} empty` : ''}`,
    openIn: 'trend',
    days: rows,
  };
}

async function graphNeighborhood(name: string | undefined): Promise<Figure | { unavailable: string }> {
  if (!name) return { unavailable: 'graph-neighborhood needs the name of an entity to centre on.' };
  const [entity] = await findEntitiesByName(name);
  if (!entity) return { unavailable: `No entity matches "${name}".` };

  const [edges, all] = await Promise.all([getEntityGraphEdges(), getAllEntities()]);
  // Direct edges only, in both directions — "what is this connected to" is not a
  // question about which way the predicate happens to point.
  const direct = edges.filter((edge) => !edge.superseded && (edge.fromEntityId === entity.id || edge.toEntityId === entity.id));
  if (direct.length === 0) return { unavailable: `"${entity.canonicalName}" has no facts attached, so it has no neighbourhood to draw.` };

  // Edges carry ids; a drawing needs names.
  const nameById = new Map(all.map((candidate) => [candidate.id, candidate.canonicalName]));

  return {
    kind: 'graph-neighborhood',
    caption: `graph-neighborhood · ${entity.canonicalName} · ${direct.length} direct ${direct.length === 1 ? 'connection' : 'connections'}`,
    openIn: 'memory',
    center: { id: entity.id, name: entity.canonicalName, kind: entity.kind },
    edges: direct.map((edge) => {
      const otherId = edge.fromEntityId === entity.id ? edge.toEntityId : edge.fromEntityId;
      return {
        toName: nameById.get(otherId) ?? otherId,
        predicate: edge.predicate,
        provenance: edge.provenance,
      };
    }),
  };
}

async function factChain(name: string | undefined, predicate: string | undefined): Promise<Figure | { unavailable: string }> {
  if (!name) return { unavailable: 'fact-chain needs the name of an entity.' };
  const [entity] = await findEntitiesByName(name);
  if (!entity) return { unavailable: `No entity matches "${name}".` };

  const timeline = await getEntityFactTimeline(entity.id);
  const chosen = predicate ?? timeline[0]?.predicate;
  if (!chosen) return { unavailable: `"${entity.canonicalName}" has no facts to trace.` };

  // Oldest first: a chain is read in the order it was built, and supersession
  // only makes sense forwards.
  const links = timeline
    .filter((fact) => fact.predicate === chosen)
    .slice()
    .sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  if (links.length === 0) return { unavailable: `"${entity.canonicalName}" has no ${chosen} facts.` };

  const superseded = links.filter((l) => l.validTo !== null).length;
  return {
    kind: 'fact-chain',
    caption: `fact-chain · ${entity.canonicalName} ${chosen} · ${links.length} ${links.length === 1 ? 'link' : 'links'}${superseded > 0 ? `, ${superseded} superseded` : ''}`,
    openIn: 'memory',
    entityName: entity.canonicalName,
    predicate: chosen,
    links: links.map((fact) => ({
      at: fact.validFrom,
      object: fact.object,
      confidence: fact.confidence,
      provenance: fact.provenance,
      supersededAt: fact.validTo,
    })),
  };
}

async function commitmentThread(name: string | undefined): Promise<Figure | { unavailable: string }> {
  const threads = [...(await getMultiDayCommitments()), ...(await getOpenCommitments())];
  if (threads.length === 0) return { unavailable: 'No commitments are being tracked yet.' };

  const needle = name?.toLowerCase();
  const thread = needle
    ? threads.find((t) => t.name.toLowerCase().includes(needle) || (t.branch ?? '').toLowerCase().includes(needle))
    : // No name given: the thread most recently returned to is the one the
      // question is almost certainly about.
      threads.slice().sort((a, b) => (b.lastTouchedAt ?? '').localeCompare(a.lastTouchedAt ?? ''))[0];
  if (!thread) return { unavailable: `No thread of work matches "${name}".` };

  return {
    kind: 'commitment-thread',
    caption: `commitment-thread · ${thread.name} · ${thread.activeDays} active ${thread.activeDays === 1 ? 'day' : 'days'}, ${thread.touches} ${thread.touches === 1 ? 'moment' : 'moments'}`,
    openIn: 'memory',
    name: thread.name,
    branch: thread.branch,
    openedAt: thread.openedAt,
    activeDays: thread.activeDays,
    touches: thread.touches,
  };
}

async function census(): Promise<Figure> {
  const [counts, coverage] = await Promise.all([getMemoryTierCounts(), getPipelineCoverage()]);
  return {
    kind: 'census',
    caption: `census · all time · ${counts.signals} signals`,
    openIn: 'trust',
    // `total: null` where there is genuinely no denominator. A count shown
    // against an invented total is a share the data cannot support.
    rows: [
      { label: 'moments', count: counts.moments, total: null },
      { label: 'with a project', count: coverage.momentsWithProject, total: coverage.moments },
      { label: 'with an intent', count: coverage.momentsWithIntent, total: coverage.moments },
      { label: 'entities', count: counts.entities, total: null },
      { label: 'facts', count: counts.entityFacts, total: null },
      { label: 'knowledge entries', count: counts.knowledgeEntries, total: null },
    ],
  };
}
