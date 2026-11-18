// The routes of a turn, one fact, one module: which apps the turn brief prints what worked before in, and that text.
// The route logic and the log query live in `@sundial/helpers/screen-routes.js`, shared with `screen_act`.
import { learned, ownSteps, type StepRow } from '@sundial/helpers/screen-routes.js';
import type { KernelState } from '../types.js';
import { isRigSession } from './rig-session.js';

export { TYPED, deadEndsOf, learned, looksLikeRef, ownSteps, routesOf, stepCall, stepsOf, stepText, type Route, type StepQueries, type StepRow } from '@sundial/helpers/screen-routes.js';

/** The routes of one app, as the brief prints them. */
export interface AppRoutes {
  app: string;
  text: string;
}

/**
 * The apps a turn's routes are read for: the apps the message names, then the front app. A name is a word that
 * matches an app the owner works in, whatever its case, or (run 13) any capitalised word, since the record knows
 * apps the window list has dropped. At most 20 to ask the log about.
 */
export function routeApps(state: KernelState | null | undefined, text = ''): string[] {
  const front = state?.window?.active?.processName;
  const known = Object.keys(state?.apps?.used ?? {});
  const words = String(text);
  const named = known.filter((app) => new RegExp(`(?<![\\p{L}\\p{N}])${app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(words));
  const capitalised = words.match(/\b[A-Z][A-Za-z]{2,}\b/g) ?? [];
  const apps = [...named, ...capitalised, front].filter((app): app is string => typeof app === 'string' && app.trim() !== '');
  const seen = new Set<string>();
  return apps.filter((app) => !seen.has(app.toLowerCase()) && Boolean(seen.add(app.toLowerCase()))).slice(0, 20);
}

/**
 * What worked before in the apps of this turn (`routeApps`), at most three apps with something learned: the rig's runs only in
 * the rig's own chats (`sessionId`), as screen_act replays them (runs 179-182 T19: its chat never saw the route it had just
 * run, so the same task again began with a look).
 */
export async function readRoutes({ state, text, steps, sessionId }: { state: KernelState | null | undefined; text?: string; steps: (app: string) => Promise<StepRow[]>; sessionId?: string }): Promise<AppRoutes[]> {
  const out: AppRoutes[] = [];
  const rig = isRigSession(state, sessionId);
  for (const app of routeApps(state, text)) {
    const rows = await steps(app);
    const said = learned(rig ? rows : ownSteps(rows), app, text);
    if (said) out.push({ app, text: said });
    if (out.length >= 3) break;
  }
  return out;
}
