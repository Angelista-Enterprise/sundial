// Which tools the model is shown, and how it reaches the rest.
//
// ## The measurement
//
// Gnomon registers 36 `gnomon_*` tools. Counted over 1,260 real tool calls in
// the live dsh session logs, 21 of them were used fewer than 15 times — and
// those 21 hold 56% of the schema text every single call carries.
//
// ## The honest size of the saving
//
// Small, in money. Tool schemas sit at the very FRONT of the prompt, which is
// the most-cached region there is: the same logs show an 85.5% overall prefix
// cache hit rate, 95.8% at the median call. Dropping ~2,200 tokens of cold
// schema saves ~2,200 tokens of which ~95% were cache reads.
//
// The reason to do it anyway is the one the literature names and the logs
// confirm: a model shown tools it does not need makes worse choices. Gnomon's
// own evidence is `gnomon_signals`, which was handed a `limit` it could not see
// past and reached for the maximum on 37 of 74 calls. Fewer, better-chosen
// instruments is a quality change, and it is filed as one.
//
// ## The trap, and the shape that avoids it
//
// The obvious implementation — discover a tool, then ADD it to the tools array
// — is the most expensive thing that could be built here. The tools array is
// part of the cached prefix. Changing its shape mid-conversation invalidates
// everything after it, and the cache misses already in these logs cost about
// 40,000 fresh tokens each. A "cheap" discovery step would be the most
// expensive call of the day.
//
// So the registered set NEVER changes. Two fixed entries stand in for the cold
// tools:
//
//   gnomon_tools(name?)      → the full schema of a deferred tool, as a RESULT
//   gnomon_call(name, args)  → run one, through the same wrapper as any other
//
// A discovered schema arrives as an appended message. The prefix stays
// byte-identical, and discovery costs one ordinary tool result.
//
// `gnomon_call` delegates to the cold tool's own `toDshTool` definition, so the
// repeat-call handles, the figure capture point, the zod validation and
// the timeout all apply exactly as they would if it had been registered.
//
// Named exports only.

/**
 * The tools that stay in every prompt, by measured use.
 *
 * The cut is at roughly 25 calls per 1,260, and it is deliberately generous:
 * deferring a tool costs a discovery round trip, and 36% of cut results in
 * these logs were ALREADY followed by an avoidable extra call. Adding more
 * round trips to save cached tokens would be a bad trade, so only the genuinely
 * cold tail moves.
 *
 * Names not in `ASK_TOOL_REGISTRY` are ignored, so this list can be read as the
 * intent even if a tool is renamed.
 */
export const HOT_TOOL_NAMES = [
  'gnomon_entity_history',
  'gnomon_code_activity',
  'gnomon_signals',
  'gnomon_semantic_search',
  'gnomon_today_summary',
  'gnomon_open_commitments',
  'gnomon_moment_detail',
];

/** The two fixed entries that stand in for everything deferred. */
export const DISCOVER_TOOL_NAME = 'gnomon_tools';
export const DISPATCH_TOOL_NAME = 'gnomon_call';

/** `gnomon:deferred-tools` — the name list, ordered just after the clock. */
export const DEFERRED_CONTEXT_NAME = 'gnomon:deferred-tools';
export const DEFERRED_CONTEXT_ORDER = -49;

/**
 * The first sentence of a tool's description — enough to know whether to ask
 * for the rest.
 *
 * Roughly 100 tokens per deferred tool across the whole list, which is the
 * insurance premium against the real failure mode of deferring: a model that
 * stops using a tool because it no longer knows the tool exists.
 */
export function oneLine(description, maxChars = 140) {
  const text = String(description ?? '').trim();
  const stop = text.indexOf('. ');
  const first = stop > 0 ? text.slice(0, stop + 1) : text;
  return first.length <= maxChars ? first : `${first.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Split a registry into the tools that are always shown and the ones behind the dispatcher. */
export function splitByHeat(tools, hot = HOT_TOOL_NAMES) {
  const hotSet = new Set(hot);
  return {
    hot: tools.filter((tool) => hotSet.has(tool.name)),
    cold: tools.filter((tool) => !hotSet.has(tool.name)),
  };
}

/**
 * The standing note that tells the model the deferred tools exist.
 *
 * Registered as a `systemPrompt.context` the same way the clock is, so it is
 * re-resolved at each assembly rather than frozen at boot — and so it sits in
 * the cached prefix, where a list that never changes belongs.
 */
export function deferredToolsContext(coldTools) {
  const lines = coldTools.map((tool) => `- ${tool.name}: ${oneLine(tool.description)}`);
  return {
    name: DEFERRED_CONTEXT_NAME,
    order: DEFERRED_CONTEXT_ORDER,
    text: () =>
      [
        `These Gnomon tools exist but are not listed in your tools. They are used rarely, so their full schemas are kept out of every prompt.`,
        `To use one: call ${DISPATCH_TOOL_NAME} with its name and arguments. Call ${DISCOVER_TOOL_NAME} first if you need to see its exact parameters.`,
        '',
        ...lines,
      ].join('\n'),
  };
}

/**
 * Build the two fixed entries.
 *
 * @param coldTools the deferred `GnomonTool` entries, for their schemas
 * @param definitionsByName name → the dsh definition built by `toDshTool`
 * @param defineTool dsh's `defineTool`, injected so this module imports nothing from dsh
 */
export function layerTools({ coldTools, definitionsByName, defineTool, toolDefinitions }) {
  const byName = new Map(coldTools.map((tool) => [tool.name, tool]));
  const known = [...byName.keys()].sort();

  const discover = defineTool({
    name: DISCOVER_TOOL_NAME,
    description: `Read the full parameter schema of one of Gnomon's deferred tools — the rarely-used ones listed in your context but not in your tool list. Pass a name to get that tool's schema, or omit it to list every deferred tool with a one-line summary. You do NOT need to call this before ${DISPATCH_TOOL_NAME} when the arguments are obvious; it is here for when they are not.`,
    parameters: {
      // dsh's schema compiler rejects `required: false` — an optional
      // parameter omits the key entirely.
      name: { type: 'string', description: `Which deferred tool. One of: ${known.join(', ')}. Omit to list them all.` },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const name = args?.name;
      if (name === undefined || name === null || name === '') {
        return { tools: coldTools.map((tool) => ({ name: tool.name, summary: oneLine(tool.description) })) };
      }
      const tool = byName.get(String(name));
      // A wrong name is answered with the list, not with an error: the model
      // guessed, and the cheapest correction is showing it what is actually
      // there rather than costing it a second failed turn.
      if (!tool) return { error: `No deferred tool named ${name}.`, available: known };
      const [definition] = toolDefinitions([tool]);
      // A plain copy: the schema zod hands back carries a hidden `~standard`
      // property (functions inside), and dsh rejects the WHOLE result as
      // "not lossless JSON" — every deferred tool's schema read failed that way
      // (seven times in one turn on 2026-09-24, and the model guessed arguments).
      return { name: tool.name, description: tool.description, parameters: JSON.parse(JSON.stringify(definition.parameters)) };
    },
  });

  const dispatch = defineTool({
    name: DISPATCH_TOOL_NAME,
    description: `Run one of Gnomon's deferred tools — the rarely-used ones listed in your context but not in your tool list. Available: ${known.join(', ')}. Pass the tool's own arguments as an object in \`args\`; call ${DISCOVER_TOOL_NAME} first if you are unsure of them. The result is exactly what the tool itself returns.`,
    parameters: {
      name: { type: 'string', description: `Which deferred tool to run. One of: ${known.join(', ')}.`, required: true },
      // `additionalProperties: true` is the whole point of this parameter: the
      // shape is whatever the deferred tool's own schema says, and gnomon's zod
      // validation inside that tool is what actually checks it. dsh requires the
      // flag to be explicit rather than inferred.
      args: {
        type: 'object',
        description: "The tool's own arguments, as an object. Omit or pass {} for a tool that takes none.",
        properties: {},
        additionalProperties: true,
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    // Conservative: one flag has to cover the whole door, whatever tool comes
    // through it next. Losing parallel dispatch on a tool called twice in
    // 1,260 calls costs nothing.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const name = String(args?.name ?? '');
      const definition = definitionsByName.get(name);
      if (!definition) return { error: `No deferred tool named ${name}.`, available: known };
      // Straight through the real definition, so validation, the repeat-call
      // handles, the figure capture and the timeout all behave as if this
      // tool had been registered directly.
      return definition.execute(args?.args ?? {}, exec);
    },
  });

  return { discover, dispatch };
}
