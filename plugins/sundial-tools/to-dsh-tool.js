// One Gnomon tool → one registry-ready dsh ToolDefinition.
//
// The honest note on `deps`: the daemon's `/ask` route (the reference wiring,
// apps/daemon/src/daemon/api/routes/ask.ts in the old repo) built no per-tool
// deps object at all — gnomon handlers reach the record through module state
// (`@sundial/db`'s getDb() singleton, initialised by the sundial-db plugin, and
// `loadLatestSnapshot()` over the snapshots the sundial-kernel plugin keeps
// writing). What ask.ts DID add around `executeGnomonTool` was an execute
// wrapper with two capture points — figures onto the answer, show-view onto
// the push bus — and that wrapper is what `deps` reproduces here:
//
//   - `deps.onFigure(figure)`   — called when gnomon_compose_figure returns a
//     real figure (not its `{ unavailable }` refusal).
//   - `deps.onShowView(shown)`  — called when gnomon_show_view returns a
//     navigation request.
//
// Both are optional. In dsh there is no SSE bus and no macOS app yet, so the
// canonical JSON simply flows back to the model (figures/views render as
// JSON for now).
// PHASE5: a UI projection hooks in here — the gnomon-proactive/web surface
// passes `onFigure`/`onShowView` in `deps` (or an `output.presentResult`
// presenter) to draw the figure with real components / move a client view,
// exactly where ask.ts's execute wrapper did it.
//
// Validation is deliberately doubled: dsh validates the model's args against
// the converted ParameterSchemaSpec (whose numeric/string bounds are prose,
// not enforced — see schema.js), then `executeTool` re-runs gnomon's own zod
// shape, so an out-of-range `limit: 900` still fails with zod's field-naming
// message the way it always has. The throw becomes a dsh tool error the
// model reads and retries against — same recovery contract as the old loop.
//
// Named exports only.
import { defineTool } from '@deepseek-ai/dsh-tools';
import { executeTool, toolDefinitions } from '@sundial/kernel/tools/registry.js';
import { toParameterSchemaSpec } from './schema.js';
import { renderResultText } from './render.js';

/** The one tool whose result is also rendered, not just read (ask.ts's FIGURE_TOOL_NAME). */
export const FIGURE_TOOL_NAME = 'gnomon_compose_figure';
/** And the one that moves the owner's view (ask.ts's VIEW_TOOL_NAME). */
export const VIEW_TOOL_NAME = 'gnomon_show_view'

/**
 * How long one Gnomon tool may run before dsh gives the model a timeout result.
 *
 * dsh's `tool-call-timeout-policy` is mounted and enabled, but it is
 * COOPERATIVE: it reads `timeoutMs` off the resolved tool definition and does
 * nothing when that is undefined. No Gnomon tool declared one, so the policy had
 * never once fired — a tool that hung held the turn open indefinitely.
 *
 * Sixty seconds is far above what these cost. The slowest reads on the live
 * record are `gnomon_semantic_search` (one embedding pass) and
 * `gnomon_today_summary` (five date-scoped queries), both well inside a second.
 * A tool past a minute is stuck, not slow, and the model is better told so than
 * left waiting.
 */
const TOOL_TIMEOUT_MS = 60_000;

/** ask.ts's `isFigure`: a composed figure, as opposed to the tool's `{ unavailable }` refusal. */
function isFigure(value) {
  return typeof value === 'object' && value !== null && typeof value.kind === 'string';
}

/**
 * dsh's canonical output must be lossless JSON. Handlers return plain JS
 * objects that are already JSON-shaped, but a stray `undefined` property
 * (legal in JS, invisible to JSON) would fail dsh's materialization, so the
 * value is round-tripped once — the same normalisation `serializeResult`
 * applied implicitly when it stringified for the old loop.
 */
function toLosslessJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

/**
 * Convert one `GnomonTool` (zod schema + handler) into a dsh ToolDefinition.
 *
 * - parameters: gnomon's wire JSON Schema → dsh ParameterSchemaSpec.
 * - execute: gnomon's own `executeTool` (zod validation + handler), then the
 *   ask.ts capture points, then lossless-JSON normalisation.
 * - output.schema `{ type: 'json' }`: handler result shapes vary per call
 *   (e.g. gnomon_moment_detail returns a moment OR `{ error }`), so the
 *   canonical schema stays unconstrained and the VALUE is the contract.
 * - render: the same text projection gnomon's tool loop showed the model.
 *
 * @param gnomonTool one entry of TOOL_REGISTRY / ASK_TOOL_REGISTRY
 * @param deps optional capture points: `{ onFigure?, onShowView?, handles?, today? }`
 *   — `handles` is the per-session repeat-call cache (handles.js) and `today`
 *   the owner-local date it decides staleness against; both absent means every
 *   call executes, which is the behaviour this had before they existed.
 */
export function toDshTool(gnomonTool, deps = {}) {
  const [definition] = toolDefinitions([gnomonTool]);
  const parameters = toParameterSchemaSpec(definition.parameters);

  return defineTool({
    name: gnomonTool.name,
    description: gnomonTool.description,
    parameters,
    timeoutMs: TOOL_TIMEOUT_MS,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderResultText(value) }],
    },
    // `readOnly` was declared on every gnomon tool exactly so a loop can tell
    // a query from an action mechanically; dsh's parallel-dispatch gate is
    // that consumer here. gnomon_show_view (readOnly: false) never joins a
    // parallel group.
    isConcurrencySafe: () => gnomonTool.readOnly,
    async execute(args, exec) {
      // A read asked twice for a FINISHED day gets a handle instead of a second
      // copy of the same rows — see handles.js for why this only ever appends.
      // Read tools only: a write repeated is a second write, never a no-op.
      const sessionId = gnomonTool.readOnly ? (exec?.agent?.id ?? null) : null;
      const handle = sessionId ? deps.handles?.lookup(sessionId, gnomonTool.name, args ?? {}, deps.today?.()) : null;
      if (handle) return toLosslessJson(handle);

      const value = await executeTool([gnomonTool], gnomonTool.name, args ?? {});

      // ask.ts's two sanctioned "the assistant did something visible" paths,
      // reproduced at the same seam. No-ops until a surface passes hooks.
      if (gnomonTool.name === FIGURE_TOOL_NAME && isFigure(value)) deps.onFigure?.(value);
      if (gnomonTool.name === VIEW_TOOL_NAME && value?.shown) deps.onShowView?.(value.shown);
      // PHASE5: push the figure/view into the companion surface here.

      if (sessionId) deps.handles?.remember(sessionId, gnomonTool.name, args ?? {}, value, deps.today?.());

      return toLosslessJson(value);
    },
  });
}
