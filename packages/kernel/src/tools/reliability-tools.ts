import { z } from 'zod';
import { readScorecard } from '../read/scorecard-history.js';
import type { GnomonTool } from './registry.js';

/** W5 step 9: Gnomon's own scorecard, so it can quote itself with the n behind every number. */
export const RELIABILITY_TOOLS: GnomonTool[] = [
  {
    name: 'gnomon_reliability',
    description:
      "How reliable Gnomon itself is, from the record: twelve rows — model calls that succeeded and the longest failure run per route, how many notices got a verdict or an implicit label, how many were worth hearing per kind, the lift in the owner's presence after a notice, fact precision, how fast a wrong fact closes, the forecasters' skill, the route predictor, moment integrity, actions verified, sensor liveness. Every row carries its n and its target; a rate on fewer than 20 outcomes says it is too small to trust. Use it when the owner asks how well Gnomon works, whether to trust a number, or what Gnomon may do on its own; quote the n with the number.",
    schema: {
      days: z.number().int().min(1).max(90).optional().describe('The window for the rows read from the log. Default 30.'),
    },
    readOnly: true,
    handler: async ({ days }, env) => {
      const state = await env.state();
      if (!state) return { unavailable: 'No kernel state has been written yet.' };
      const now = env.now.getTime();
      const rows = await readScorecard({ state, now, days: (days as number | undefined) ?? 30 });
      return { asOf: env.now.toISOString(), rows, autonomy: state.autonomy?.levels ?? {} };
    },
  },
];
