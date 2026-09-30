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
// So the registered set NEVER changes. Since 2026-09-30 EVERY tool stays
// registered — Gnomon's read tools, its action tools, the board tools and
// dsh's own — and `hideColdTools` drops the cold ones from the model-facing
// list at prompt assembly. Nothing about execution changes: the gate, the
// approvals and the audit see every call under its real name. Measured on a
// local model the same day: 46 schemas were ~14,650 of an ~18,000-token first
// prompt, the dominant cost of a first answer on a Mac. Two fixed entries
// stand in for the cold tools:
//
//   gnomon_tools(name?)      → the full schema of a deferred tool, as a RESULT
//   gnomon_call(name, args)  → run one, through the same wrapper as any other
//
// A discovered schema arrives as an appended message. The prefix stays
// byte-identical, and discovery costs one ordinary tool result.
//
// `gnomon_call` re-enters dsh's own pipeline (`tools.execute`) as a nested
// call, so the permission gate, approvals, validation and audit run for the
// inner tool exactly as for a direct call. It must never call a definition's
// `execute` directly: that skipped the gate (the gate keys on the call's name,
// which would be `gnomon_call`).
//
// Named exports only.

/**
 * The tools that stay in every prompt: the reads most questions need, and the
 * chat's own moves. Everything else is one `gnomon_tools` call away.
 *
 * Names that are not registered are ignored, so this list reads as the intent
 * even if a tool is renamed or switched off.
 */
export const HOT_TOOL_NAMES = [
  'gnomon_today_summary',
  'gnomon_code_activity',
  'gnomon_open_commitments',
  'gnomon_entity_history',
  'gnomon_semantic_search',
  'gnomon_moment_detail',
  'todo_write',
  'ask_user_question',
  'skill',
];

/** The two fixed entries that stand in for everything deferred. */
export const DISCOVER_TOOL_NAME = 'gnomon_tools';
export const DISPATCH_TOOL_NAME = 'gnomon_call';

/** The menu's runtime-context name. */
export const MENU_CONTEXT_NAME = 'gnomon:deferred-tools';

/**
 * The menu: what each deferred tool is FOR, so the model can reason about
 * which it needs before it reads a schema. A tool missing here lands in "More".
 */
export const TOOL_GROUPS = [
  ['Look up the record', 'did I…?, what happened when, a project, people, goals, tickets, habits, trends', ['gnomon_did_i', 'gnomon_timeline', 'gnomon_recent_activity', 'gnomon_project_status', 'gnomon_signals', 'gnomon_people', 'gnomon_goals', 'gnomon_tickets', 'gnomon_anomalies', 'gnomon_routines', 'gnomon_drift', 'gnomon_brief', 'gnomon_project_handoff', 'gnomon_current_context', 'gnomon_conversation_search', 'gnomon_agent_yield']],
  ['Show on the board', 'place, focus or walk cards; read a card; a grid or a figure', ['gnomon_board', 'gnomon_look', 'gnomon_lens', 'show_surface', 'gnomon_compose_figure']],
  ['Remember and correct', 'a fact the owner told you, a promise, an outcome, feedback', ['gnomon_assert', 'gnomon_track_promise', 'gnomon_claim', 'gnomon_record_outcome', 'gnomon_notice_feedback', 'gnomon_owner_answer']],
  ['Act for the owner (needs their yes)', 'propose, draft, ask them, calendar, a web page, a file', ['gnomon_propose', 'gnomon_draft', 'gnomon_ask_owner', 'gnomon_calendar_create', 'web_page', 'present']],
  ['Later and in the background', 'a job for the shelf, a wake-up, stop a repeat', ['gnomon_start_job', 'gnomon_schedule_wakeup', 'gnomon_cancel_wakeup', 'gnomon_shelve', 'gnomon_work_done', 'gnomon_stop_repeat']],
  ['Watch rules', 'test, find, adopt or drop a rule that notices on its own; what if', ['gnomon_test_rule', 'gnomon_mine_rules', 'gnomon_what_if', 'gnomon_adopt_rule', 'gnomon_drop_rule', 'gnomon_export_rule']],
  ['Web', 'search and read pages', ['web_search', 'web_fetch']],
  ['About Gnomon itself', 'its reliability, model spend, board traffic', ['gnomon_reliability', 'gnomon_llm_ledger', 'gnomon_board_traffic']],
];

/** Runtime contexts the chat never needs: dsh's file-sandbox note (Gnomon has no file tools). */
export const DROPPED_CONTEXTS = ['sandbox:policy'];

/**
 * The first sentence of a tool's description — enough to know whether to ask
 * for the rest.
 */
export function oneLine(description, maxChars = 110) {
  const text = String(description ?? '').trim();
  const stop = text.indexOf('. ');
  const first = stop > 0 ? text.slice(0, stop + 1) : text;
  return first.length <= maxChars ? first : `${first.slice(0, maxChars - 1).trimEnd()}…`;
}

const isFixed = (name) => name === DISCOVER_TOOL_NAME || name === DISPATCH_TOOL_NAME;

/** Split model-facing schemas into the ones always shown and the ones behind the menu. */
export function splitByHeat(tools, hot = HOT_TOOL_NAMES) {
  const hotSet = new Set(hot);
  return {
    hot: tools.filter((tool) => hotSet.has(tool.name) || isFixed(tool.name)),
    cold: tools.filter((tool) => !hotSet.has(tool.name) && !isFixed(tool.name)),
  };
}

/** The deferred tools, grouped: `[{ group, tools: [{ name, summary }] }]`, in menu order. */
export function menuOf(coldTools) {
  const groupOf = new Map(TOOL_GROUPS.flatMap(([group, , names]) => names.map((name) => [name, group])));
  const order = [...TOOL_GROUPS.map(([group]) => group), 'More'];
  const byGroup = new Map(order.map((group) => [group, []]));
  for (const tool of coldTools) byGroup.get(groupOf.get(tool.name) ?? 'More').push({ name: tool.name, summary: oneLine(tool.description) });
  const hints = new Map(TOOL_GROUPS.map(([group, hint]) => [group, hint]));
  return order.filter((group) => byGroup.get(group).length > 0).map((group) => ({ group, hint: hints.get(group) ?? '', tools: byGroup.get(group) }));
}

/** The menu as the model reads it, once per prompt: names by purpose, no schemas. */
export function menuText(coldTools) {
  return [
    `More tools, by what they are for. Their schemas are kept out of your tool list: call ${DISCOVER_TOOL_NAME} with a name to read one (or with none for a line on each), then ${DISPATCH_TOOL_NAME} to run it. Most questions need none of these.`,
    ...menuOf(coldTools).map(({ group, hint, tools }) => `- ${group}${hint ? ` (${hint})` : ''}: ${tools.map((t) => t.name).join(', ')}`),
  ].join('\n');
}

/**
 * Hide the cold tools at prompt assembly, and put the menu in their place.
 * Every tool stays registered; only what the model is SHOWN changes.
 */
export function hideColdTools(ctx, hot = HOT_TOOL_NAMES) {
  return ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next();
    const { hot: shown, cold } = splitByHeat(assembled.tools ?? [], hot);
    if (cold.length === 0) return assembled;
    const contexts = (assembled.contexts ?? []).filter((c) => c.name !== MENU_CONTEXT_NAME && !DROPPED_CONTEXTS.includes(c.name));
    return { ...assembled, tools: shown, contexts: [...contexts, { name: MENU_CONTEXT_NAME, text: menuText(cold) }] };
  });
}

/**
 * Build the two fixed entries over dsh's tool registry.
 *
 * @param tools dsh's `ctx.tools` (schemas + execute)
 * @param defineTool dsh's `defineTool`, injected so this module imports nothing from dsh
 */
export function layerTools({ tools, defineTool, hot = HOT_TOOL_NAMES }) {
  const coldOf = (agent) => splitByHeat(tools.schemas(agent), hot).cold;

  const discover = defineTool({
    name: DISCOVER_TOOL_NAME,
    description: `Read the full schema of one of the tools in the menu (listed in your context, not in your tool list). Pass a name to get that tool's description and parameters; omit it for the grouped menu. Read a tool before its first ${DISPATCH_TOOL_NAME}.`,
    parameters: {
      // dsh's schema compiler rejects `required: false` — an optional
      // parameter omits the key entirely.
      name: { type: 'string', description: 'Which tool from the menu. Omit for the whole menu.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cold = coldOf(exec?.agent);
      const name = args?.name;
      if (name === undefined || name === null || name === '') return { menu: menuOf(cold) };
      const tool = cold.find((t) => t.name === String(name));
      // A wrong name is answered with the list: the cheapest correction is
      // showing the model what is actually there.
      if (!tool) return { error: `No tool named ${name} in the menu.`, available: cold.map((t) => t.name).sort() };
      // A plain copy: dsh rejects a result that is not lossless JSON.
      return JSON.parse(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
    },
  });

  const dispatch = defineTool({
    name: DISPATCH_TOOL_NAME,
    description: `Run one of the tools in the menu. Pass its name and its own arguments as an object in \`args\`; read it with ${DISCOVER_TOOL_NAME} first. It runs exactly as a direct call would, approvals included, and returns what the tool returns.`,
    parameters: {
      name: { type: 'string', description: 'Which tool from the menu to run.', required: true },
      // `additionalProperties: true` is the point: the shape is the inner
      // tool's own schema, which dsh validates when the call re-enters the pipeline.
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
    // One flag covers the whole door, whatever tool comes through it next.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const name = String(args?.name ?? '');
      if (isFixed(name)) return { error: `${name} is called directly, not through ${DISPATCH_TOOL_NAME}.` };
      if (!tools.schemas(exec?.agent).some((t) => t.name === name)) return { error: `No tool named ${name}.`, available: coldOf(exec?.agent).map((t) => t.name).sort() };
      const result = await tools.execute({
        callId: `${exec.callId}:${name}`,
        rootCallId: exec.rootCallId ?? exec.callId,
        name,
        arguments: args?.args ?? {},
        agent: exec.agent,
        parent: exec.token,
        signal: exec.signal,
      });
      return result.isError ? { error: result.error?.message ?? String(result.error?.code ?? 'the tool failed') } : result.value;
    },
  });

  return { discover, dispatch };
}
