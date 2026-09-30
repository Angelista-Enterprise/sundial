import { z } from 'zod';
import { getAllSignalsInRange } from '@sundial/db/index.js';
import { localDate, wakingDate } from '@sundial/helpers/local-day.js';
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js';
import { agentYield, agentYieldLine } from '../agent-yield.js';
import { addDays, DRIFT_THRESHOLDS, driftSentence, heldTrends, mondayOf, wakingClock, weeklyDrift } from '../drift.js';
import { pageWithinBudget, RESULT_BUDGET_CHARS } from './evidence-tools.js';
import type { GnomonTool } from './registry.js';

// lane C (enhancements 8, 19): trends over weeks, read-only.

const DAY_MS = 86_400_000;

export const TREND_TOOLS: GnomonTool[] = [
  {
    name: 'gnomon_drift',
    description:
      "Slow weekly trends in how the owner works, one row per week with the n behind every number: `dayEnd` (median time the last real input stopped on working weekdays, over `dayEndN` days — measured on the waking day, 04:00 to 04:00, so a late night is not clipped at midnight), `weekendMin` (active minutes on Saturday and Sunday), `meetingMin` (scheduled minutes of timed meetings that ran), `switchesPerDay` (context switches per active day, over `activeDays`), `lateCommits` (commits after 22:00). A metric is null when its week has too few days to say anything. `holding` lists the trends that held beyond the usual level for three weeks in a row — the only ones Gnomon ever raises on its own. Use it for \"am I working later lately\", \"are my weeks getting more meetings\". Say the n; a week of three days is thin.",
    schema: {
      weeks: z.number().int().min(1).max(13).optional().describe('How many weeks back, newest last. Default 8.'),
    },
    readOnly: true,
    handler: async ({ weeks }, env) => {
      const state = await env.state();
      const days = state?.drift?.days;
      if (!days || Object.keys(days).length === 0) return { note: 'No drift days recorded yet. They are rebuilt from the log on the first boot with this version.' };
      const all = weeklyDrift(days);
      const tz = state.config.timezone;
      const current = mondayOf(wakingDate(env.now.toISOString(), tz));
      const holding = heldTrends(all, current);
      return {
        weeks: all.slice(-((weeks as number | undefined) ?? 8)).map((w) => ({ ...w, dayEnd: w.dayEnd === null ? null : wakingClock(w.dayEnd) })),
        holding: holding.map((t) => ({ metric: t.metric, direction: t.direction, said: driftSentence(t), baselineWeeks: t.baselineWeeks })),
        thresholds: DRIFT_THRESHOLDS,
        note: 'The current week is partial. A trend is raised only when it STARTS to hold; thresholds are defaults, not fitted.',
      };
    },
  },
  {
    name: 'gnomon_agent_yield',
    description:
      "What the owner's coding agents cost and produced, one row per project and owner-local week (newest first): `sessions` (Claude Code sessions seen by the fleet), `onBranch` (of those, on a feature branch or with a PR), `merged` (ended in a merged PR), `openPr` (a PR not merged yet), `costUsd` with `costKnown` (Claude's own list-price estimate, recorded only when a session ends or resumes — so the sum covers `costKnown` of `sessions`), and `branches` / `branchesMerged` (distinct feature branches an agent worked on, from the longer `agent:session` record). `line` is a sentence for a weekly view. Use it for \"what did Claude cost on puzzlebox this week\", \"how many agent sessions ended in a merged PR\". Always say the n.",
    schema: {
      weeks: z.number().int().min(1).max(26).optional().describe('How many weeks back, ending this week. Default 4.'),
      project: z.string().optional().describe('Only this project (checkout folder name, case-insensitive substring).'),
      offset: z.number().int().min(0).optional().describe('The `nextOffset` of the previous page.'),
    },
    readOnly: true,
    handler: async ({ weeks, project, offset }, env) => {
      const tz = loadSundialConfig().timezone;
      const thisWeek = mondayOf(localDate(env.now.toISOString(), tz));
      const firstWeek = addDays(thisWeek, -7 * (((weeks as number | undefined) ?? 4) - 1));
      // A day of slack either side for the zone; the week filter below is exact.
      const from = new Date(Date.parse(`${firstWeek}T00:00:00.000Z`) - DAY_MS).toISOString();
      const to = new Date(env.now.getTime() + 60_000).toISOString();
      const signals = await getAllSignalsInRange(from, to, ['agent:fleet', 'agent:session', 'git:pr-status']);
      const rows = agentYield(
        signals.map((s) => ({ type: `${s.signalType}:${s.eventType}`, ts: s.capturedAt, data: s.data })),
        tz,
      ).filter((r) => r.week >= firstWeek);
      const want = (project as string | undefined)?.toLowerCase();
      const picked = want ? rows.filter((r) => r.project.toLowerCase().includes(want)) : rows;
      const page = pageWithinBudget(
        picked.map((r) => ({ ...r, line: agentYieldLine(r, r.week === thisWeek ? 'this week' : `the week of ${r.week}`) })),
        { offset: offset as number | undefined, limit: 200, budget: RESULT_BUDGET_CHARS },
      );
      return {
        ...page,
        note: 'costUsd is an estimate at list price, never a bill. Sessions are counted only from when the fleet sensor ran; branches go further back.',
      };
    },
  },
];
