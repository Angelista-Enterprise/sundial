import { z } from 'zod';
import type { GnomonTool } from './registry.js';

/**
 * What `show_view` asks the app to show. Returned by the handler and captured
 * by the `/ask` route, which is what turns it into a push to the client — the
 * kernel does not know the daemon's event bus exists, and a tool that reached
 * for it would invert the layering the rest of the registry keeps.
 */
export interface ShowViewRequest {
  altitude: 'today' | 'trend' | 'memory' | 'trust' | 'unsaid' | 'index';
  /** A project short name to scope to, or null for everything. */
  scope: string | null;
  range: '7d' | '28d' | null;
  /** An entity or moment id the altitude should open, when the question was about one thing. */
  selection: string | null;
  /** Why the app moved, in the owner's words — the dismissible chip's text. */
  because: string;
}

/**
 * The one write-tool into the app, and the only one there will be without a
 * separate decision.
 *
 * `almanac/decisions/assistant-as-an-event-source` is the standing line: this
 * assistant may speak, propose and claim; it may not operate the owner's
 * machine. Navigating its OWN presentation is deliberately placed on the near
 * side of that line — driving the window it already lives in is not reaching
 * out of it — and the boundary is the window's edge, stated here so the next
 * capability has to argue for itself rather than inherit this precedent.
 *
 * Two mechanical guards make the boundary real rather than rhetorical:
 *
 * - `readOnly: false`. This is the first entry in the registry that is not a
 *   pure read, which is exactly the case `GnomonTool.readOnly` was declared in
 *   advance to make detectable — the loop can tell a query from an action
 *   without parsing a name.
 * - It is NOT in the shared `TOOL_REGISTRY` the MCP server advertises. MCP is a
 *   different client in the same user session; a third party calling this would
 *   move the owner's window while they were reading something else, which is an
 *   actuation on their screen that no one asked for. This tool belongs only to
 *   the surface that IS the window.
 */
export const VIEW_TOOLS: GnomonTool[] = [
  {
    name: 'gnomon_show_view',
    description:
      "Move the Gnomon app to the page that shows what you are talking about — use this when the answer is better looked at than described, e.g. \"show me last week's work on overture\". Pick the altitude: 'today' (one day's shape), 'trend' (days compared), 'memory' (entities, facts, moments), 'trust' (permissions and measurement), 'unsaid' (what it considered saying), 'index' (what the app can show). This moves the owner's view, so use it when they asked to be shown something, not to illustrate an aside. It cannot do anything outside the app window.",
    schema: {
      altitude: z.enum(['today', 'trend', 'memory', 'trust', 'unsaid', 'index']),
      scope: z.string().optional().describe('Project short name to scope the page to'),
      range: z.enum(['7d', '28d']).optional().describe('For the trend altitude'),
      selection: z.string().optional().describe('An entity or moment id to open, when the question was about one specific thing'),
      because: z.string().max(80).optional().describe("One short clause naming what the owner asked for, shown on a dismissible chip, e.g. 'last week on overture'"),
    },
    readOnly: false,
    handler: async (args) => {
      const { altitude, scope, range, selection, because } = args as {
        altitude: ShowViewRequest['altitude'];
        scope?: string;
        range?: '7d' | '28d';
        selection?: string;
        because?: string;
      };
      const request: ShowViewRequest = {
        altitude,
        scope: scope ?? null,
        range: range ?? null,
        selection: selection ?? null,
        because: because?.trim() || 'from your question',
      };
      // Returned to the model too, not only to the route, so its prose can say
      // it moved the view rather than describing a page the owner is now
      // already looking at.
      return { shown: request, note: 'The app has been moved to this view. Do not also describe the page in detail — the owner can see it.' };
    },
  },
];
