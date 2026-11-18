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
  // Nodus: hot because a figure is often the better answer whatever the words (plugins/sundial-nodus).
  'gnomon_visualize',
  // Hot so the model never fetches their schema first (gnomon_tools took 2 to 11 s) or sends them with empty args.
  'gnomon_run_shell',
  'gnomon_await',
  'screen_look',
  'screen_act',
  // Set 2 Round 1: "pull it up" in one call (sundial-actions pull-up.js).
  'gnomon_pull_up',
  // Set 2 Round 3: "run <skill>", a kept skill in one call (sundial-actions skill.js).
  'gnomon_skill',
  'todo_write',
  'ask_user_question',
  'skill',
];

/** The two fixed entries that stand in for everything deferred. */
export const DISCOVER_TOOL_NAME = 'gnomon_tools';
export const DISPATCH_TOOL_NAME = 'gnomon_call';

/**
 * The call the model meant, out of the envelope it sent.
 *
 * Run 12 lost five calls to the envelope alone: `gnomon_call` wrapped around itself, and a `name`
 * left out while the tool's own arguments sat at the top level. Both say plainly which tool was
 * wanted, so they are unwrapped instead of refused. Anything else still comes back with an example.
 */
export function unwrap(args, depth = 0) {
  const name = typeof args?.name === 'string' ? args.name : '';
  const inner = args?.args && typeof args.args === 'object' && !Array.isArray(args.args) ? args.args : {};
  // gnomon_call inside gnomon_call: the one that names a real tool is the one meant.
  if (name === DISPATCH_TOOL_NAME && depth < 3 && typeof inner.name === 'string') return unwrap(inner, depth + 1);
  if (name) return { name, args: inner };
  // No name, but the arguments carry one tool's own fields: take the name from the only key that is a tool's.
  const { args: _nested, ...flat } = args ?? {};
  return { name: typeof flat.tool === 'string' ? flat.tool : '', args: Object.keys(inner).length ? inner : flat };
}

/** Levenshtein distance between two names. */
export function editDistance(a, b) {
  const first = Array.from({ length: b.length + 1 }, (_, j) => j);
  const last = [...a].reduce((row, ca, i) => {
    const next = [i + 1];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (ca === b[j - 1] ? 0 : 1));
    return next;
  }, first);
  return last[b.length];
}

/**
 * The tools nearest what the model sent, nearest first. With a name: by edit distance (the live
 * record has `gnomondid_i` 4 times and `gnonon_what_if` once). With none: by how many of the
 * argument keys each tool takes, so an empty name (7 on the record) is answered with a short list.
 */
export function closestTools(schemas, name, args = {}, n = 3) {
  const keys = Object.keys(args ?? {});
  const scored = schemas
    .filter((t) => !isFixed(t.name))
    .map((t) => ({ name: t.name, score: name ? editDistance(name, t.name) : -keys.filter((k) => k in (t.parameters?.properties ?? {})).length }))
    .filter((t) => name || t.score < 0)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.slice(0, n);
}

/** A misspelled name within this many edits runs as the one tool it is nearest. */
export const NAME_SLACK = 2;

/** The menu's runtime-context name. */
export const MENU_CONTEXT_NAME = 'gnomon:deferred-tools';

/**
 * The menu: what each deferred tool is FOR, so the model can reason about
 * which it needs before it reads a schema. A tool missing here lands in "More".
 */
export const TOOL_GROUPS = [
  ['Look up the record', 'did I…?, what happened when, a project, people, goals, tickets, my pull requests (open, review, CI), habits, trends', ['gnomon_pull_requests', 'gnomon_did_i', 'gnomon_timeline', 'gnomon_recent_activity', 'gnomon_project_status', 'gnomon_signals', 'gnomon_people', 'gnomon_goals', 'gnomon_tickets', 'gnomon_anomalies', 'gnomon_routines', 'gnomon_drift', 'gnomon_brief', 'gnomon_project_handoff', 'gnomon_current_context', 'gnomon_conversation_search', 'gnomon_agent_yield']],
  ['Show on the board', 'place, focus or walk cards; read a card; a grid or a figure', ['gnomon_board', 'gnomon_look', 'gnomon_lens', 'show_surface', 'gnomon_compose_figure']],
  ['Remember and correct', 'a fact the owner told you, a promise they tell you of ("I owe Mira the draft by Tuesday"), an outcome, feedback', ['gnomon_assert', 'gnomon_track_promise', 'gnomon_claim', 'gnomon_record_outcome', 'gnomon_notice_feedback', 'gnomon_owner_answer']],
  ['Act for the owner (needs their yes)', 'propose, draft, ask them, calendar, a web page, a file', ['gnomon_propose', 'gnomon_draft', 'gnomon_ask_owner', 'gnomon_calendar_create', 'web_page', 'present']],
  ["On the owner's screen, in their other apps", 'look first, then act or point on a ref: screen_look {app: "Notes"}, then screen_act {ref: "e7", action: "press", because: "Open the note"} or screen_mark {ref: "e7"}', ['screen_look', 'screen_act', 'screen_mark', 'screen_guide', 'screen_undo']],
  ['Later and in the background', 'remind me or check back at a time (a wake-up), a job for the shelf, stop a repeat', ['gnomon_start_job', 'gnomon_schedule_wakeup', 'gnomon_cancel_wakeup', 'gnomon_shelve', 'gnomon_work_done', 'gnomon_stop_repeat']],
  ['Watch rules', 'test, find, adopt, pause or drop a rule that notices on its own; what if', ['gnomon_test_rule', 'gnomon_mine_rules', 'gnomon_what_if', 'gnomon_adopt_rule', 'gnomon_drop_rule', 'gnomon_pause_rule', 'gnomon_resume_rule', 'gnomon_reach_revoke', 'gnomon_export_rule']],
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
/** The menu's first line. Exported for the lab bench, which shows the model the same words. */
export const MENU_HEAD = `More tools, by what they are for. Their schemas are kept out of your tool list: run one with ${DISPATCH_TOOL_NAME} and your best arguments — a wrong argument comes back with that tool's schema — or read it first with ${DISCOVER_TOOL_NAME} if you cannot guess what it takes. Most questions need none of these: a day's totals — minutes per app and project, notes edited, agent repos, tickets opened — are one gnomon_today_summary call.`;

export function menuText(coldTools) {
  return [
    MENU_HEAD,
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
    description: `Read the full schema of one of the tools in the menu (listed in your context, not in your tool list). Pass a name to get that tool's description and parameters; omit it for the grouped menu. Only when you cannot guess its arguments: ${DISPATCH_TOOL_NAME} returns the schema with any argument error anyway.`,
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
    description: `Run one of the tools in the menu. Pass its name and its own arguments as an object in \`args\` — your best guess is fine: a wrong argument comes back with the tool's schema, so the next call can be right without a ${DISCOVER_TOOL_NAME} round. It runs exactly as a direct call would, approvals included, and returns what the tool returns.`,
    parameters: {
      // Not required: run 12 lost five calls to dsh refusing the envelope before this tool could say how to fix it.
      name: { type: 'string', description: 'Which tool from the menu to run.' },
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
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    // One flag covers the whole door, whatever tool comes through it next.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const asked = unwrap(args);
      const sent = String(asked?.name ?? '');
      const example = `${DISPATCH_TOOL_NAME} {"name": "gnomon_today_summary", "args": {"date": "2026-11-13"}}`;
      const schemas = tools.schemas(exec?.agent);
      if (!sent) {
        const near = closestTools(schemas, '', asked.args).map((t) => t.name);
        const error = `Name the tool to run, like this: ${example}. The tool's own arguments go inside args, never beside it.`;
        return near.length ? { error: `${error} The tools that take these arguments: ${near.join(', ')}.` } : { error, available: coldOf(exec?.agent).map((t) => t.name).sort() };
      }
      if (sent === DISPATCH_TOOL_NAME) return { error: `${sent} is called directly, with its own arguments at the top level, not through ${DISPATCH_TOOL_NAME}. Send ${sent} as the tool name of this call.` };
      // A misspelled name runs as the one tool within NAME_SLACK edits of it; two as near is a guess, so it is refused.
      const near = schemas.some((t) => t.name === sent) ? [] : closestTools(schemas, sent);
      const fixed = near.length && near[0].score <= NAME_SLACK && near[1]?.score !== near[0].score ? near[0].name : null;
      if (fixed) console.log(`[sundial-tools] ${DISPATCH_TOOL_NAME}: no tool named ${sent}, ran ${fixed}`);
      const name = fixed ?? sent;
      const found = schemas.find((t) => t.name === name);
      if (!found) return { error: `No tool named ${name}. The nearest: ${near.map((t) => t.name).join(', ')}.`, available: coldOf(exec?.agent).map((t) => t.name).sort() };
      const result = await tools.execute({
        callId: `${exec.callId}:${name}`,
        rootCallId: exec.rootCallId ?? exec.callId,
        name,
        arguments: asked.args,
        agent: exec.agent,
        parent: exec.token,
        signal: exec.signal,
      });
      // The tool's own text, as a direct call reads it; raw JSON only when it renders more than text.
      const text = result.content?.length && result.content.every((b) => b.type === 'text') ? result.content.map((b) => b.text).join('\n') : null;
      if (!result.isError) return text ?? result.value;
      const error = result.error?.message ?? String(result.error?.code ?? 'the tool failed');
      // An argument the model guessed wrong is answered with the schema: the menu loop the lab bench
      // measured was the model reading schemas before every call (up to 11 reads in one turn).
      const bad = /invalid|expected|required|unrecognized|validation|argument/i.test(error);
      const schema = bad ? coldOf(exec?.agent).find((t) => t.name === name) : null;
      // Run 36 T01: gnomon_run_shell came with empty args, and the refusal did not name the field it needed.
      const needs = bad ? (Array.isArray(found.parameters?.required) ? found.parameters.required : []).filter((k) => !(k in asked.args)) : [];
      const said = needs.length ? `${name} needs ${needs.join(' and ')} in args: nothing was run. Send ${DISPATCH_TOOL_NAME} {"name": "${name}", "args": {${needs.map((k) => `"${k}": ...`).join(', ')}}}.` : error;
      return schema ? JSON.parse(JSON.stringify({ error: said, schema: { description: schema.description, parameters: schema.parameters } })) : { error: said };
    },
  });

  return { discover, dispatch };
}
