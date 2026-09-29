// sundial-tools: Gnomon's read tools in dsh's tool registry, plus gnomon_assert
// — the owner-assertion write path — and the 'ask' budget guard around every
// agent model call.
//
// The registry is ASK_TOOL_REGISTRY — the same read tools MCP is advertised.
// Figures return canonical JSON; see to-dsh-tool.js for the projection seam.
//
// Not all of them are SHOWN. The measured-hot tools are registered directly;
// the cold tail is reachable through `gnomon_call`, with the names kept in the
// prompt as a standing context — see layers.js for the split and, more
// importantly, for why the registered set must never change shape mid-turn.
//
// Handlers reach the record the same way they did under the daemon: through
// `@sundial/db`'s module singleton (initialised by the sundial-db plugin before
// this one applies — inject guarantees the order) and the kernel snapshots
// the sundial-kernel plugin keeps writing. `deps` reproduces ask.ts's execute
// wrapper seam; the injected services live on it so the seam has the same
// reach the daemon's ApiServerDeps had (live state, db, queries, memory).
//
// Named exports only — a default export drops `inject`.
import { defineTool } from '@deepseek-ai/dsh-tools';
import { executeGnomonTool } from '@sundial/kernel/tools/index.js';
import { ASK_TOOL_REGISTRY } from '@sundial/kernel/tools/index.js';
import { toolDefinitions } from '@sundial/kernel/tools/registry.js';
import { resolveDailyCaps } from '@sundial/kernel/budgets.js';
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js';
import { DEFAULT_PROVIDER, LEGACY_PROVIDER } from '@sundial/helpers/llm-providers.js';
import { slugifyEntityName } from '@sundial/rules/entity-extract.js';
import { canonicalOwnerName, knownProjectNames, rejectEntityName } from '@sundial/rules/entity-name-validation.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { toDshTool } from './to-dsh-tool.js';
import { createHandleCache } from './handles.js';
import { createRerank } from './rerank.js';
import { createRouteLog } from './route-log.js';
import { deferredToolsContext, DISCOVER_TOOL_NAME, DISPATCH_TOOL_NAME, layerTools, splitByHeat } from './layers.js';
import { createAskBudgetGuard } from './budget.js';
import { createLlmAuditRecorder } from './audit.js';
import { createShellWitness } from './shell-witness.js';
import { CARD_KINDS, normKind } from '@sundial/rules/board-track.js';
import { createCardReaders } from './card-readers.js';
import { clockContext, frozenPerTurn } from './clock.js';
import { BOARD_LOOK_ID, boardContextText, boardSummary } from './board-context.js';
import { LENS_AGGS, LENS_OPS, LENS_SHOWS, lensProblem, runLens } from '../sundial-theme/shell/lens-core.js';
import { CARDS, checkFilters, describeCard } from '../sundial-theme/shell/cards.js';
import { internalHeaders } from '../sundial-theme/shell/guard.js';
import { createAmbientContext } from './ambient.js';
import { composeAmbientContext, gatherAmbientInput } from '@sundial/kernel/ambient-context.js';
import { showSurfaceTool, SURFACE_TOOL_NAME } from './show-surface.js';
import { watchTools } from './watch-tools.js';

export { toDshTool, FIGURE_TOOL_NAME } from './to-dsh-tool.js';
export { toValueSchemaSpec, toParameterSchemaSpec } from './schema.js';
export { renderResultText, MAX_RESULT_BYTES } from './render.js';
export { createAskBudgetGuard, ASK_PURPOSE, BUDGET_EXHAUSTED_CODE } from './budget.js';
export { createShellWitness, extractShellCommand, extractExitCode, SHELL_TOOL_NAMES } from './shell-witness.js';
export {
  createLlmAuditRecorder,
  serializePrompt,
  auditPurpose,
  mapUsageToColumns,
  boundBody,
  DEFAULT_AUDIT_PURPOSE,
  MAX_BODY_CHARS,
} from './audit.js';
export { GNOMON_PERSONA, HARNESS_NOTE } from './persona.js';
export { clockContext, CLOCK_CONTEXT_NAME, CLOCK_CONTEXT_ORDER } from './clock.js';
export { createAmbientContext, AMBIENT_CONTEXT_NAME, AMBIENT_CONTEXT_ORDER, AMBIENT_REFRESH_MS } from './ambient.js';
export { showSurfaceTool, rejectSurfacePayload, rejectCanvasHtml, SURFACE_TOOL_NAME, SURFACE_KINDS } from './show-surface.js';

export const name = 'sundial-tools';
// `systemPrompt` is dsh's own service (@deepseek-ai/dsh-system-prompt). It is
// injected rather than assumed because a profile without the system-prompt row
// would otherwise fail at `apply` with an unhelpful undefined read.
export const inject = ['tools', 'systemPrompt', 'gnomonKernel', 'gnomonDb', 'gnomonMemory'];

export function apply(ctx) {
  // ask.ts's ApiServerDeps, reproduced: live state + the record's services,
  // plus the two capture points (unset until a surface provides them).
  // Repeat reads of a FINISHED day come back as a handle rather than a second
  // copy of the same rows (handles.js). Shared across every tool because the
  // key is the call, not the tool.
  const handles = createHandleCache();
  const deps = {
    getState: () => ctx.gnomonKernel.getState(),
    db: ctx.gnomonDb.db,
    queries: ctx.gnomonDb.queries,
    memory: ctx.gnomonMemory,
    handles,
    today: () => localDate(new Date().toISOString(), loadSundialConfig().timezone),
    // PHASE5: onFigure — the UI projection hook (see to-dsh-tool.js).
  };

  // Every tool is BUILT; only the hot ones are REGISTERED. The cold ones are
  // reachable through `gnomon_call`, which runs this same definition — so the
  // handles, the capture points, the zod validation and the timeout all apply
  // whichever door a tool came through. See layers.js for why the registered
  // set must never change shape mid-conversation.
  // J1.3: the retriever's hits go through Jev before the model sees them.
  // Wrapped HERE, not in the kernel tool, because the judge and the learned
  // thresholds live on the kernel service — the MCP server keeps the raw list.
  const rerank = createRerank({ judgeNow: (options) => ctx.gnomonKernel.judgeNow(options), getState: () => ctx.gnomonKernel.getState() });
  const withRerank = (tool) => (tool.name === 'gnomon_semantic_search' ? { ...tool, handler: async (args) => rerank(args.query, await tool.handler(args)) } : tool);
  // gnomon_board is the one way the chat moves the owner's view.
  const CHAT_TOOLS = ASK_TOOL_REGISTRY;
  const definitionsByName = new Map(CHAT_TOOLS.map((tool) => [tool.name, toDshTool(withRerank(tool), deps)]));
  const { hot, cold } = splitByHeat(CHAT_TOOLS);

  for (const tool of hot) {
    ctx.tools.register(definitionsByName.get(tool.name));
  }

  const { discover, dispatch } = layerTools({ coldTools: cold, definitionsByName, defineTool, toolDefinitions });
  ctx.tools.register(discover);
  ctx.tools.register(dispatch);

  // The deferred tools' NAMES stay in every prompt, roughly 100 tokens for the
  // list. That is the insurance against the one real risk of deferring: a model
  // that stops using a tool because it no longer knows the tool is there.
  ctx.systemPrompt.context(deferredToolsContext(cold));

  // A handle says "the full result is still above". Compaction rewrites the
  // history and can remove the message it is talking about, so every handle for
  // that session is dropped the moment compaction finishes. Cheap to be wrong
  // in this direction: the cost is one repeated tool call, where the other
  // direction costs an answer built on evidence the model cannot see.
  ctx.on('compaction/end', (session) => {
    handles.clear(session?.agent?.id ?? session?.id ?? null);
  });

  // The surface envelope (gnomon_redesign/handoff §6): draws in the owner's
  // chat, so it is dsh only, never MCP.
  // The sundial-theme client renders it via `tool.call.toolview` keyed by name.
  ctx.tools.register(showSurfaceTool());

  // The one write tool. The daemon owned this path as `POST /assert` →
  // `recordAssertion` (apps/daemon/src/daemon/index.ts): an owner statement
  // re-enters the log as an `entity:fact-candidate` with `provenance:
  // 'assertion'`, which `contradictionCheck` promotes on ONE observation and
  // which supersedes a conflicting confirmed fact immediately instead of
  // waiting for three contradicting sightings. Harness mode keeps the daemon's
  // port dark by design, so the same seam lives here, on the sanctioned
  // crossing: `appendSignal`.
  //
  // One improvement over the HTTP route: the fold's shape gate
  // (`rejectEntityName`) runs BEFORE the event is appended and its reason is
  // RETURNED, so the companion hears "the owner is not a person entity" and
  // can re-shape the assertion, instead of the candidate dying silently in
  // the fold the way a 200-then-drop through the daemon route would.
  // `owner` is the fifth: facts about the owner themselves. Any alias of the
  // owner given under another kind is folded onto it below, so the model cannot
  // file the owner as a person or a topic by accident.
  // Gnomon's own rules: adopt a tested watch, drop one.
  for (const tool of watchTools((type, payload) => ctx.gnomonKernel.appendSignal(type, payload), () => ctx.gnomonKernel.getState())) ctx.tools.register(tool);
  const ASSERT_ENTITY_KINDS = ['person', 'project', 'tool', 'topic', 'owner', 'goal'];
  ctx.tools.register(
    defineTool({
      name: 'gnomon_assert',
      description: [
        "Record a fact. saidBy decides its weight: 'owner' when the owner directly stated or corrected it in their own words —",
        "that supersedes a conflicting belief immediately and barely decays; 'me' when YOU inferred it from what you saw or read —",
        'that is recorded as your observation and needs to recur before it becomes belief. Never mark your own inference as the owner\'s word:',
        'twelve of the twelve facts the owner marked wrong were inferences about their sleep, wake and schedule recorded as if they had said them.',
        'entityKind: owner (a fact about the owner themselves — their preferences, schedule, people, places),',
        'person (a collaborator — never the owner), project, tool, topic, or goal (something the owner wants to achieve, in their words; predicate status = open|paused|done|dropped, targetDate, why).',
        'Prefer the established predicates where they fit: usesTool, worksOn, relatesToProject, collaboratesOn, deployedVia.',
        'If the name is rejected by the record\'s shape gate, the reason comes back — re-shape and retry, or ask the owner.',
      ].join(' '),
      parameters: {
        entityKind: { type: 'string', required: true, description: 'One of: owner, person, project, tool, topic, goal.' },
        canonicalName: { type: 'string', required: true, description: 'The entity the fact is about, e.g. "Priya Sharma" or "gnomon".' },
        predicate: { type: 'string', required: true, description: 'The relation, e.g. usesTool, collaboratesOn, drives.' },
        object: { type: 'string', required: true, description: 'The value, e.g. "Xcode" or "Audi A3".' },
        saidBy: { type: 'string', required: true, description: "'owner' if the owner said it in this conversation, in their words. 'me' if you worked it out yourself. When in doubt, 'me'." },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            recorded: { type: 'boolean' },
            entityId: { type: 'string' },
            triple: { type: 'string' },
            reason: { type: 'string' },
            provenance: { type: 'string' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.recorded
              ? value.provenance === 'assertion'
                ? `Asserted "${value.triple}" (${value.entityId}). Supersedes any conflicting belief immediately; the previous fact is kept in the timeline.`
                : `Noted "${value.triple}" (${value.entityId}) as your own observation. It becomes belief once it recurs; it does not override what the owner said.`
              : `Not recorded: ${value.reason}`,
          },
        ],
      },
      async execute(args) {
        let entityKind = String(args.entityKind).trim();
        if (!ASSERT_ENTITY_KINDS.includes(entityKind)) {
          throw new Error(`entityKind must be one of ${ASSERT_ENTITY_KINDS.join(', ')} — got "${entityKind}"`)
        }
        let canonicalName = String(args.canonicalName).trim();
        // The owner under any alias, any kind → the one owner entity.
        const ownerName = canonicalOwnerName(canonicalName, ctx.gnomonKernel.getState()?.config.ownerAliases);
        if (ownerName !== null && (entityKind === 'owner' || entityKind === 'person' || entityKind === 'topic')) {
          entityKind = 'owner';
          canonicalName = ownerName;
        }
        const predicate = String(args.predicate).trim();
        const object = String(args.object).trim();
        // No default. It decides whether this supersedes the owner's belief
        // immediately or waits for corroboration, and guessing 'me' turned the
        // owner's own correction into a queued observation — the exact inversion
        // the parameter exists to prevent.
        const saidBy = String(args.saidBy ?? '').trim().toLowerCase();
        if (saidBy !== 'owner' && saidBy !== 'me') {
          throw new Error(`saidBy is required and must be 'owner' (they said it, in this conversation) or 'me' (you worked it out) — got "${String(args.saidBy ?? '')}"`)
        }
        // The owner's own word is an assertion. The model's reading of the
        // record is an observation with the model as its source, held to the
        // same recurrence bar as any other observation.
        const provenance = saidBy === 'owner' ? 'assertion' : 'assistant';
        if (!canonicalName) throw new Error('canonicalName is required')
        if (!predicate) throw new Error('predicate is required')
        if (!object) throw new Error('object is required')

        // The fold's shape gate, run up front with the same context
        // `contradictionCheck` would use, so a rejection is an answer the
        // companion can act on rather than a silent drop.
        const state = ctx.gnomonKernel.getState();
        const nameContext = state
          ? {
              ownerAliases: state.config.ownerAliases,
              projectNames: knownProjectNames(state.config.projectAliases, state.project.known),
            }
          : undefined;
        const rejection = rejectEntityName(entityKind, canonicalName, provenance, nameContext);
        if (rejection) return { recorded: false, reason: rejection.reason };

        // Shaped exactly like the daemon's `recordAssertion`: same
        // `${kind}:${slug}` id convention as every other candidate producer.
        // `sourceEventId` is null where the daemon used the candidate event's
        // own id — `appendSignal` mints that id internally, and a chat-born
        // assertion has no deeper source signal to link.
        const entityId = `${entityKind}:${slugifyEntityName(canonicalName)}`;
        await ctx.gnomonKernel.appendSignal('entity:fact-candidate', {
          entityKind,
          canonicalName,
          predicate,
          object,
          confidence: provenance === 'assertion' ? 100 : 70,
          provenance,
          entityId,
          sourceEventId: null,
          projectId: null,
        });

        return { recorded: true, entityId, triple: `${canonicalName} ${predicate} ${object}`, provenance }
      },
    }),
  );

  // The owner's own conversations with Gnomon, searchable. dsh keeps every
  // session as an append-only log and ships a text index over it that both of
  // its layers leave off; the profile turns it on (`session-query-sqlite`,
  // `openAt: first-search`). Separate from gnomon_semantic_search on purpose:
  // that ranking was measured and tuned over the record, and folding a second
  // corpus into it means re-measuring. Resolved at call time like every
  // optional dsh service, so a profile without the index answers honestly.
  ctx.tools.register(
    defineTool({
      name: 'gnomon_conversation_search',
      description: [
        'Search past conversations between the owner and Gnomon — what was said, asked, decided or promised in the chat itself. This is the chat log, not the activity record: for what the owner DID, use the other tools.',
        'Literal, case-insensitive text match over every message; returns the strongest match per conversation with an excerpt and when it was said.',
      ].join(' '),
      parameters: {
        query: { type: 'string', required: true, description: 'Words or a phrase to look for, as text. Not a regex.' },
        limit: { type: 'number', description: 'Conversations to return, 1–20. Default 8.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            hits: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { sessionId: { type: 'string' }, at: { type: 'string' }, role: { type: 'string' }, excerpt: { type: 'string' } } } },
            unavailable: { type: 'string' },
          },
        },
        render: (_args, value) =>
          value.unavailable
            ? [{ type: 'text', text: value.unavailable }]
            : value.hits.length === 0
              ? [{ type: 'text', text: 'No conversation mentions that.' }]
              : [{ type: 'text', text: value.hits.map((hit) => `${hit.at} · ${hit.role} in ${hit.sessionId}: ${hit.excerpt}`).join('\n') }],
      },
      async execute(args) {
        const query = String(args.query ?? '').trim();
        if (query === '') throw new Error('query is required');
        const limit = Math.min(20, Math.max(1, Number.isFinite(Number(args.limit)) ? Math.round(Number(args.limit)) : 8));
        const sessionQuery = ctx.get?.('sessionQuery');
        if (sessionQuery === undefined || typeof sessionQuery.searchSessions !== 'function') return { hits: [], unavailable: 'This profile has no conversation index.' };
        // dsh refuses a search when the set of live sessions moved between its
        // two observations (a work child starting, a session being created) and
        // retries only once. Under the work loop that is a normal moment, not a
        // fault, so this waits it out a few times before saying so.
        let page;
        for (let attempt = 1; ; attempt += 1) {
          try {
            page = await sessionQuery.searchSessions({ query, limit });
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (attempt < 4 && /did not stabilize/.test(message)) {
              await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
              continue;
            }
            return { hits: [], unavailable: `The conversation index is not available: ${message}` };
          }
        }
        return {
          hits: page.items.map((hit) => ({
            sessionId: String(hit.header?.id ?? hit.bestMatch?.sessionId ?? ''),
            at: new Date(hit.bestMatch?.time ?? hit.header?.createdAt ?? 0).toISOString(),
            role: String(hit.bestMatch?.type ?? '').startsWith('user/') ? 'owner' : 'gnomon',
            excerpt: String(hit.bestMatch?.snippet ?? '').slice(0, 400),
          })),
        };
      },
    }),
  );

  // The clock the persona cannot carry (see clock.js). Registration is
  // context-scoped, so it is torn down with the plugin on unload.
  ctx.systemPrompt.context(frozenPerTurn(clockContext()));

  // What Gnomon knows about the owner, in every turn (see ambient.js). The
  // slice reads the record, and dsh resolves a context synchronously, so it is
  // cached and rebuilt behind the turn: once now, then every minute. The timer
  // is an effect so it dies with the plugin.
  const ambient = createAmbientContext({
    build: async () => composeAmbientContext(await gatherAmbientInput({ state: ctx.gnomonKernel.getState() })),
    onError: (error) => console.warn(`[sundial-tools] ambient memory refresh failed: ${error?.message ?? error}`),
  });
  ctx.effect(() => () => ambient.dispose(), 'sundial-tools ambient memory');
  ctx.systemPrompt.context(frozenPerTurn(ambient.context));
  void ambient.refresh();

  // ── The board ────────────────────────────────────────────────────────────
  // The owner's space is Gnomon's too. One tool, several verbs, every verb an
  // event through the kernel — the same `board:*` signals the owner's own
  // drags append — so Gnomon and the owner move the same cards on the same
  // record, and the client is a projection of `state.board`.
  const BOARD_ACTIONS = ['place', 'move', 'remove', 'focus', 'notice', 'walk', 'step', 'clear', 'arrange', 'save', 'load', 'note', 'section', 'span'];
  // Both from the one card catalog the client draws from. `surface` and
  // `figure` are made by drawing, not by placing, so they are not offered here.
  const BOARD_KINDS = CARDS.filter((c) => c.id !== 'surface:' && c.id !== 'figure:' && c.id !== 'browser:').map((c) => c.id.replace(/:$/, ''));
  /** kind + key → the pane id the client resolves. */
  const boardId = (kind, key) => {
    switch (kind) {
      case 'entity':
        return key ? `entity:${String(key).toLowerCase()}` : null;
      case 'moment':
        return key ? `moment:${key}` : null;
      case 'note':
        return `note:${key || Date.now().toString(36)}`;
      case 'lens':
        return `lens:${key || Date.now().toString(36)}`;
      case 'web':
        return /^https?:\/\//.test(String(key ?? '')) ? `web:${key}` : null;
      default:
        return kind;
    }
  };
  // lane Q (Q12): what the board context says, and the board a tool reads back, are in board-context.js.
  ctx.systemPrompt.context(
    frozenPerTurn({
      name: 'gnomon:board',
      order: -35,
      text: () => boardContextText(ctx.gnomonKernel.getState(), deps.today()),
    }),
  );
  // ── What a card shows ─────────────────────────────────────────────────
  // The read tools are date- and project-shaped; the owner's questions are
  // card-shaped ("this pane", "that stretch"). One tool turns a card id into
  // the same rows the card draws, trimmed to what fits beside the card.
  // ponytail: the instruments' rows come from the theme's own loopback routes
  // (they have no other reader); a shared query module would be the upgrade.
  const LOOK_CHARS = 6000;
  const trimJson = (value) => {
    const text = JSON.stringify(value);
    if (text.length <= LOOK_CHARS) return value;
    if (Array.isArray(value)) {
      const keep = Math.max(1, Math.floor((value.length * LOOK_CHARS) / text.length));
      return { shown: keep, of: value.length, rows: value.slice(0, keep) };
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = Array.isArray(v) && JSON.stringify(v).length > LOOK_CHARS / 2 ? { shown: Math.min(8, v.length), of: v.length, rows: v.slice(0, 8) } : v;
    return out;
  };
  const route = async (path) => {
    const response = await fetch(`http://127.0.0.1:${process.env.SUNDIAL_WEB_PORT || 3080}${path}`, { headers: { accept: 'application/json', ...internalHeaders() } });
    if (!response.ok) throw new Error(`${path} → ${response.status}`);
    return response.json();
  };
  // One reader per card kind, and `CARD_KINDS` (the record's own list) is what
  // the test beside `card-readers.js` holds it to.
  const CARD_READERS = createCardReaders({
    route,
    tool: executeGnomonTool,
    state: () => ctx.gnomonKernel.getState(),
  });
  ctx.tools.register(
    defineTool({
      name: 'gnomon_look',
      description: [
        `Read what a card on the board shows, by its card id (as gnomon_look with id "board" lists them). Every card can be read; what each one answers:\n${CARDS.map((c) => `- ${c.id}${c.id.endsWith(':') ? '<key>' : ''} "${c.title}": ${c.question}`).join('\n')}\ndial takes an hour for the stretch under the shadow.`,
        'Use this FIRST when the owner points at something on the board — "this pane", "that stretch", "the card on the right" — instead of translating it into a date and a project yourself. Trimmed to what fits beside the card; ask the date-shaped tools for the rest.',
      ].join(' '),
      parameters: {
        id: { type: 'string', required: true, description: `The card id, or "${BOARD_LOOK_ID}" for every card on the board: what each is, where it sits, the recent moves and your plan.` },
        hour: { type: 'number', description: 'For dial: the hour (e.g. 14.5) to read the moments around.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        const id = String(args.id ?? '');
        // lane Q (Q12): the board itself, which the context no longer lists.
        if (id === BOARD_LOOK_ID) return { card: BOARD_LOOK_ID, board: boardSummary(ctx.gnomonKernel.getState()?.board, deps.today()) ?? 'There is no board yet.' };
        const card = ctx.gnomonKernel.getState()?.board?.cards?.[id];
        // The card's own kind when the record has it; otherwise the part of the
        // id before the colon, which is how `board:place` derives one too.
        const kind = normKind(card?.kind ?? id.split(':')[0]);
        const key = id.slice(id.split(':')[0].length + 1);
        const reader = CARD_READERS[kind];
        if (reader === undefined) {
          // `CARD_KINDS` is the record's list and `card-readers.js` covers it,
          // so reaching here means an id that names no card at all.
          return { card: id, unavailable: card ? `No reader for a ${kind} card yet.` : 'No such card on the board.' };
        }
        try {
          return trimJson({ card: id, ...(await reader(key, card ?? null, args)) });
        } catch (error) {
          return { card: id, unavailable: error instanceof Error ? error.message : String(error) };
        }
      },
    }),
  );

  // A lens: a live view Gnomon composes over one read tool — rows picked,
  // filtered, grouped, sorted, shaped — placed as a card that keeps re-reading.
  // How it EXPLAINS with a shape instead of a paragraph, and leaves the shape
  // behind. `preview` runs it and returns the rows; `place` puts it on the board.
  const isReadTool = (name) => ASK_TOOL_REGISTRY.some((t) => t.name === name && t.readOnly === true);
  /**
   * The owner's autonomy setting, as a refusal. `act` is the only level at
   * which Gnomon may change what is on the screen; below it the tools say so
   * rather than failing quietly, so the model can tell the owner why.
   */
  const mayAct = () => {
    const level = ctx.gnomonKernel.getState()?.settings?.autonomy ?? 'act';
    return level === 'act' ? null : `the owner set autonomy to "${level}" — you may not place or move cards. Say what you would have shown instead.`;
  };
  const parseJson = (v) => (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return undefined; } })() : v);
  ctx.tools.register(
    defineTool({
      name: 'gnomon_lens',
      description: [
        'Compose a LENS: a live view over one of your read tools, to explain something with a shape instead of prose — "commits per project this week", "moments after 22:00", "the ten longest stretches".',
        'A lens names a read tool and its args, picks the rows (pick: a path into the answer, else the first array), filters them (where: [{ field, op, value }], ops ' + LENS_OPS.join('/') + '; since takes an ISO instant or 7d/36h/90m),',
        'optionally groups them (group: field, agg: { fn: ' + LENS_AGGS.join('|') + ', field? }), sorts (sort: "-field" for descending), limits, and shows them as ' + LENS_SHOWS.join(', ') + '.',
        'action preview runs it and returns the rows so you can read them before saying anything; action place puts it on the board as a card that keeps re-reading (near: a card or row to land beside).',
        'Use it when a question is really about a distribution, a ranking, a count over time, or a filtered list — and say in one line what the lens shows.',
        'The owner can remove the card like any other; the lens itself is kept on the Lenses shelf forever. So name it in your answer as a link — [what it shows](board:<the id place returned>) — and that link puts it back on the board however long from now, out of whatever conversation it was made in.',
      ].join(' '),
      parameters: {
        action: { type: 'string', required: true, enum: ['preview', 'place'], description: 'preview = run and return rows; place = put on the board.' },
        title: { type: 'string', required: true, description: 'The card head, e.g. "Commits per project, this week".' },
        tool: { type: 'string', required: true, description: 'A read tool: ' + ASK_TOOL_REGISTRY.filter((t) => t.readOnly).map((t) => t.name).join(', ') },
        args: { type: 'json', description: 'The tool\'s arguments, as JSON.' },
        pick: { type: 'string', description: 'Path to the rows inside the answer, e.g. "moments" or "days"; omit for the first array found.' },
        where: { type: 'json', description: 'JSON array of { field, op, value }.' },
        group: { type: 'string', description: 'Field to group by; rows become one per distinct value.' },
        agg: { type: 'json', description: 'With group: { fn: count|sum|avg|min|max, field? }. Default count.' },
        sort: { type: 'string', description: 'Field to sort by; prefix - for descending.' },
        limit: { type: 'number', description: 'Max rows, default 50.' },
        columns: { type: 'json', description: 'JSON array of field names to show, in order; omit for all simple fields.' },
        show: { type: 'string', enum: LENS_SHOWS, description: 'The shape. table (default), bars (label + number per row), stat (one number), dots (a time list).' },
        note: { type: 'string', description: 'One line under the head saying what to see.' },
        near: { type: 'string', description: 'For place: a card id or row id to land beside.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: (_args, value) =>
          value.done
            ? [{ type: 'text', text: `${value.id ? `Lens ${value.id} placed. ` : ''}${value.total} row${value.total === 1 ? '' : 's'} · columns ${value.columns.join(', ')}\n${value.rows.map((r) => value.columns.map((c) => `${c}=${JSON.stringify(r[c])}`).join(' · ')).join('\n')}` }]
            : [{ type: 'text', text: `Lens: not done — ${value.reason}` }],
      },
      async execute(args) {
        const spec = {
          title: args.title,
          source: { tool: args.tool, args: parseJson(args.args) ?? {} },
          pick: args.pick || undefined,
          where: parseJson(args.where) ?? undefined,
          group: args.group || undefined,
          agg: parseJson(args.agg) ?? undefined,
          sort: args.sort || undefined,
          limit: Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Number(args.limit) : undefined,
          columns: parseJson(args.columns) ?? undefined,
          show: args.show || undefined,
          note: args.note || undefined,
        };
        for (const k of Object.keys(spec)) if (spec[k] === undefined) delete spec[k];
        const problem = lensProblem(spec, isReadTool);
        if (problem) return { done: false, reason: problem };
        // A preview is a read and is always allowed; placing is an act.
        const refused = args.action === 'place' ? mayAct() : null;
        if (refused) return { done: false, reason: refused };
        const data = await executeGnomonTool(spec.source.tool, spec.source.args);
        const result = runLens(spec, data);
        // A column the rows do not have rendered as the literal word `undefined`
        // down every row, silently, and read as data. Refuse it and say what the
        // fields ARE, so the next attempt is right rather than one guess closer.
        if (result.unknown.length > 0) return { done: false, reason: `no such field${result.unknown.length === 1 ? '' : 's'}: ${result.unknown.join(', ')} — the rows have ${result.fields.join(', ')}` };
        if (args.action === 'preview') return { done: true, columns: result.columns, rows: result.rows.slice(0, 12), total: result.total };
        const id = `lens:${Date.now().toString(36)}`;
        // No `w`/`h`: 640×480 was hardcoded here and beat `defaultSize`'s floor,
        // so every lens landed a third of the height of the cards beside it,
        // whatever the board's grid. The record decides a card's size by kind.
        await ctx.gnomonKernel.appendSignal('board:place', { id, kind: 'lens', text: JSON.stringify(spec), near: args.near, by: 'gnomon' });
        // And look at it. `near:` puts a card beside another one, which is often
        // off the side of the camera; a card placed where nobody is looking was
        // reported as a card that did not appear.
        await ctx.gnomonKernel.appendSignal('board:focus', { ids: [id], text: spec.title, by: 'gnomon' });
        return { done: true, id, columns: result.columns, rows: result.rows.slice(0, 6), total: result.total };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'gnomon_board',
      description: [
        'Arrange the owner\'s board — the screen you share. It is a space of cards; gnomon_look with id "board" lists every card with the question it answers and the filters it takes, and every result here ends with the board as it then stands. Kinds: ' + BOARD_KINDS.join(', ') + '. chat is the conversation (the owner opens it with ⌥C; never remove it).',
        'An entity takes key: its name; a moment its id; a web card the url (text: your excerpt) — place one right after web_fetch when the page is worth keeping, near the card it answers.',
        'Actions: place (kind, key?, filters?, x, y, w?, h?, z?, pinned?, text?) puts a card down — or re-sets one already there — and returns its id; move (id, x?, y?, w?, h?, z?) — z is depth, 0 front, negative recedes;',
        'remove (id); focus (ids, text?, mark?, filters?) brings those cards into the owner\'s view with a caption, and `mark` lights the rows inside them that carry those words; walk (steps: JSON array of { ids, text }) lays a whole play-by-play down at once; step (ids, text, filters?) adds ONE step live and RETURNS ONLY WHEN THE OWNER PRESSES NEXT (or after ten minutes) — narrate with step when you want to see what they do before going on; clear removes every card; arrange re-tiles the rows (the board tiles itself: each section is a row, cards in a row share one height and keep their own widths, ordered by x);',
        'save (name) keeps the cards as a scene, load (name) brings a scene back; note (text, x, y) is a shortcut for placing a note.',
        'Pinned cards (today, session) are permanent and stay through remove and load. Coordinates are world units, roughly pixels at zoom 1; today is 960×620 at the origin.',
        'section (id, label, x, y, w, h, anchor?) names a region of the board. place takes an optional near (a card id, or a section id — inside that region): the card lands beside that card, in the nearest free spot; with no x/y or near it lands at the nearest free spot to the origin. Nothing ever lands on another card; sizes have per-kind floors.',
        'Use it when the owner asks to be shown something beside something else, to tidy, to save or bring back a layout, or when a figure you drew deserves a place next to what it explains.',
        'Do not narrate every move; the owner watches the board.',
      ].join(' '),
      parameters: {
        action: { type: 'string', required: true, enum: BOARD_ACTIONS, description: 'What to do.' },
        kind: { type: 'string', enum: BOARD_KINDS, description: 'For place: the kind of pane.' },
        key: { type: 'string', description: 'For place: the entity name, moment id, url, or note key.' },
        near: { type: 'string', description: 'For place: a card id to land beside, or a section id to land inside.' },
        anchor: { type: 'string', description: 'For section: the pinned card that anchors it.' },
        id: { type: 'string', description: 'For move/remove: the card id (as returned by place, or as gnomon_look with id "board" lists them).' },
        ids: { type: 'json', description: 'For focus: a JSON array of card ids.' },
        label: { type: 'string', description: 'For section: its name, a few words.' },
        because: { type: 'string', description: 'ALWAYS for place, move, remove: one short line saying why — the owner sees it as a caption the moment the card lands ("the week you asked about", "so the two meetings sit side by side"). A move with no why reads as the board moving on its own.' },
        filters: { type: 'json', description: 'For place, focus or step: set what the card shows, as a JSON object — e.g. {"date":"2026-09-22"} on the day card, {"tab":"Files"} on Activity, {"query":"Alex"} on Explore. Each card lists the filters it takes (gnomon_look with id "board"); null clears them. Set the card to the point instead of describing where to look.' },
        mark: { type: 'string', description: 'For focus: words to light INSIDE the card — a day ("We 9"), a project name, a person, a shelf title. The owner sees those rows outlined for a few seconds. Use it to point at one line instead of describing where it is.' },
        ms: { type: 'number', description: 'For notice: how long the row stands, in ms (default 5000). 0 makes it stand until the owner answers or dismisses it — which is what a question needs.' },
        actions: { type: 'json', description: 'For notice: up to 3 replies, as a JSON array of { label: "Yes", say: "yes, log it" }. Pressing one SAYS that text to you as the owner, so their answer arrives as an ordinary turn. A notice with actions stands until answered.' },
        steps: { type: 'json', description: 'For walk: a JSON array of { ids: [card ids], text: "what to see here", weight?: "light"|"heavy" }, in reading order, 3–7 steps. Each text: Write it the way a colleague points at a screen: ONE thing to notice, in plain words, about 20 words, at most one number and only if it matters, and where on the card to look. Not a report, not a list of totals.' },
        weight: { type: 'string', enum: ['light', 'heavy'], description: 'For step: light = it only shows something; heavy = the owner must look or decide. Either way the step waits for the owner to press Next — they go at their own pace.' },
        autoAdvanceMs: { type: 'number', description: 'For walk: advance steps on their own every N ms while the owner does not touch the board.' },
        name: { type: 'string', description: 'For save/load: the scene name.' },
        label: { type: 'string', description: 'For span: today, 7d, 14d, 30d or 90d. Sets WHEN the whole board looks at — every card at once, yours and the owner\'s. There is no per-card window.' },
        from: { type: 'string', description: 'For span: the first day, YYYY-MM-DD. On its own it means that ONE day.' },
        to: { type: 'string', description: 'For span: the last day, YYYY-MM-DD.' },
        text: { type: 'string', description: 'For note/place: the text on the card. For step and focus: what you say about it, shown in the chat beside a link to the card. Write it the way a colleague points at a screen: ONE thing to notice, in plain words, about 20 words, at most one number and only if it matters, and where on the card to look. Not a report, not a list of totals.' },
        comment: { type: 'string', description: 'For place or move: the owner\'s remark ON this card (what to fix, what renders wrong). Empty clears it. Read them with gnomon_look id "board"; write one only when the owner asks you to note something about a surface. The result says whether it was saved — if it does not, the remark did not land and you must say so rather than reporting it written.' },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
        z: { type: 'number', description: 'Depth: 0 is the front, down to -600 far back.' },
        pinned: { type: 'boolean' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { done: { type: 'boolean' }, id: { type: 'string' }, reason: { type: 'string' }, cards: { type: 'number' }, continued: { type: 'boolean' }, recent: { type: 'string' }, remark: { type: 'string' }, board: { type: 'string' } },
        },
        // `remark` is named in the answer because a comment that silently fell
        // off still read as "Board: inst:day · 2 cards now" — a success line for
        // a half-executed call. A writer that cannot see what it wrote reports
        // work it never did.
        render: (_args, value) => [{ type: 'text', text: (value.done ? (value.continued === undefined ? `Board: ${value.id ? `${value.id} · ` : ''}${value.cards} cards now.${value.remark ? ` The owner's remark on ${value.id} is ${value.remark}.` : ''}` : value.continued ? `The owner pressed Next.${value.recent ? ` Meanwhile they: ${value.recent}.` : ''} Go on.` : 'The owner did not press Next within ten minutes; the step stays on the board. Wrap up briefly.') : `Board: not done — ${value.reason}`) + (value.board ? `\n\nThe board now:\n${value.board}` : '') }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const action = String(args.action);
        const refused = mayAct();
        if (refused) return { done: false, reason: refused, cards: 0 };
        const ids = typeof args.ids === 'string' ? (() => { try { return JSON.parse(args.ids); } catch { return null; } })() : args.ids;
        const filters = typeof args.filters === 'string' ? (() => { try { return JSON.parse(args.filters); } catch { return undefined; } })() : args.filters;
        let type = `board:${action}`;
        let payload = {};
        let id = typeof args.id === 'string' ? args.id : null;
        switch (action) {
          case 'place':
          case 'note': {
            const kind = action === 'note' ? 'note' : String(args.kind ?? '');
            if (!BOARD_KINDS.includes(kind)) return { done: false, reason: `kind must be one of ${BOARD_KINDS.join(', ')}`, cards: 0 };
            id = boardId(kind, args.key);
            if (id === null) return { done: false, reason: `a ${kind} needs a valid key`, cards: 0 };
            // A lens placed without a spec draws "no readable spec" — four of 27
            // did, and one was then pointed at in a walk. gnomon_lens makes them.
            if (kind === 'lens') {
              let spec = null;
              try {
                spec = JSON.parse(String(args.text ?? ''));
              } catch {
                spec = null;
              }
              const problem = lensProblem(spec, isReadTool);
              if (problem) return { done: false, reason: `${problem} — make a lens with gnomon_lens, which checks the spec and runs it`, cards: 0 };
            }
            if (filters !== undefined) {
              const checked = checkFilters(id, filters);
              if (!checked.ok) return { done: false, reason: checked.reason, cards: 0 };
            }
            type = 'board:place';
            payload = { id, kind, x: args.x, y: args.y, w: args.w, h: args.h, z: args.z, pinned: args.pinned, text: args.text, comment: args.comment, near: args.near, filters, by: 'gnomon' };
            break;
          }
          case 'move':
          case 'remove':
            if (id === null) return { done: false, reason: 'id is required', cards: 0 };
            payload = action === 'move' ? { id, x: args.x, y: args.y, w: args.w, h: args.h, z: args.z, comment: args.comment } : { id };
            break;
          case 'focus':
            if (!Array.isArray(ids) || ids.length === 0) return { done: false, reason: 'focus needs ids', cards: 0 };
            payload = { ids, text: args.text, mark: args.mark };
            break;
          case 'notice': {
            if (!args.text) return { done: false, reason: 'notice needs text', cards: 0 };
            const replies = typeof args.actions === 'string' ? (() => { try { return JSON.parse(args.actions); } catch { return null; } })() : args.actions;
            payload = { text: args.text, ms: args.ms, actions: Array.isArray(replies) ? replies : [] };
            break;
          }
          case 'step': {
            if (!Array.isArray(ids) && !args.text) return { done: false, reason: 'step needs ids or text', cards: 0 };
            payload = { ids: Array.isArray(ids) ? ids : [], text: args.text, weight: args.weight };
            break;
          }
          case 'walk': {
            const steps = typeof args.steps === 'string' ? (() => { try { return JSON.parse(args.steps); } catch { return null; } })() : args.steps;
            if (!Array.isArray(steps) || steps.length === 0) return { done: false, reason: 'walk needs steps: [{ ids, text }]', cards: 0 };
            payload = { steps, autoAdvanceMs: args.autoAdvanceMs };
            break;
          }
          case 'clear':
            break;
          case 'section':
            if (!args.id) return { done: false, reason: 'section needs an id', cards: 0 };
            payload = { id: args.id, label: args.label, x: args.x, y: args.y, w: args.w, h: args.h, anchor: args.anchor };
            break;
          case 'save':
          case 'load':
            if (!args.name) return { done: false, reason: 'name is required', cards: 0 };
            payload = { name: args.name };
            break;
          case 'span':
            // WHEN the whole board looks at, both hands on the same control.
            // Use it when the owner asks about another day or another week:
            // winding the board is the answer, not describing it in prose.
            payload = { label: args.label, from: args.from, to: args.to };
            break;
          case 'arrange':
            break;
          default:
            return { done: false, reason: `unknown action ${action}`, cards: 0 };
        }
        // Pointing at a card can set it too: the card turns to the point before
        // the owner looks. Same event as a place on an existing card, so the
        // record holds the setting; every named card must take the filters.
        if ((action === 'focus' || action === 'step') && filters !== undefined && Array.isArray(payload.ids)) {
          const cardsNow = ctx.gnomonKernel.getState()?.board?.cards ?? {};
          for (const cid of payload.ids) {
            const checked = checkFilters(cid, filters);
            if (!checked.ok) return { done: false, reason: checked.reason, cards: 0 };
            if (!cardsNow[cid]) return { done: false, reason: `${cid} is not on the board — place it with its filters first`, cards: 0 };
          }
          for (const cid of payload.ids) await ctx.gnomonKernel.appendSignal('board:place', { id: cid, kind: cardsNow[cid].kind, filters, by: 'gnomon' });
        }
        payload.by = 'gnomon';
        // The one line the owner sees when the card lands: why this, why now.
        if (typeof args.because === 'string' && args.because.trim() !== '') payload.because = args.because.trim().slice(0, 200);
        for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
        await ctx.gnomonKernel.appendSignal(type, payload);
        const stepAt = new Date().toISOString();
        let board = ctx.gnomonKernel.getState()?.board ?? null;
        // The theme's live channel relays this to every open browser at once.
        ctx.emit('gnomon/board', board);
        if (action === 'step') {
          // The checkpoint: hold the turn until the owner has pressed Next past
          // this step. ponytail: a 500ms poll, like gnomon_ask_owner's; an event
          // would save the poll if a turn ever holds many steps at once.
          const target = board?.walk?.steps.length ?? 0;
          const deadline = Date.now() + 10 * 60_000;
          let continued = false;
          while (Date.now() < deadline && !exec?.signal?.aborted) {
            board = ctx.gnomonKernel.getState()?.board ?? null;
            if (!board?.walk || board.walk.steps.length < target) break;
            if (board.walk.cursor >= target) {
              continued = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          // What the owner did while you waited, so the next step can answer it.
          const moves = (board?.recent ?? []).filter((r) => r.by === 'owner' && r.at > stepAt).map((r) => `${r.type}${r.id ? ` ${r.id}` : ''}`);
          return { done: true, continued, cards: board ? Object.keys(board.cards).length : 0, ...(moves.length ? { recent: moves.join(', ') } : {}), ...(board ? { board: boardSummary(board, deps.today()) } : {}) };
        }
        // Read the remark back off the record rather than echoing the argument:
        // the answer then describes what the board holds, not what was asked for.
        const wroteComment = typeof args.comment === 'string' && (action === 'place' || action === 'note' || action === 'move');
        const landed = wroteComment && id !== null ? (board?.cards?.[id]?.comment ?? null) : null;
        // No `undefined` values: dsh checks the result is lossless JSON.
        return {
          done: true,
          ...(id === null ? {} : { id }),
          cards: board ? Object.keys(board.cards).length : 0,
          ...(wroteComment ? { remark: landed === null ? 'cleared' : `saved: “${landed.slice(0, 60)}${landed.length > 60 ? '…' : ''}”` } : {}),
          // lane Q (Q12): the board as it now stands, which the context no longer carries.
          ...(board ? { board: boardSummary(board, deps.today()) } : {}),
        };
      },
    }),
  );

  // Every shell command dsh runs, into the same hook file a human's shell
  // writes (see shell-witness.js). Observe-only: `tools/result` fires after the
  // call has settled and cannot change it. Without this the shell sensor can
  // only see interactive history, which non-interactive `bash -c` never writes.
  ctx.on(
    'tools/result',
    createShellWitness({ getDefaultCwd: () => process.cwd() }),
  );

  // Same resolution the daemon did once at boot: defaults overlaid with
  // ~/.sundial/config.json's `budgets` field.
  // J1.4b: Jev's tool prediction for every owner message, logged beside the
  // tools the loop actually called — a month of pairs before any routing.
  ctx.on(
    'session/event',
    createRouteLog({ judgeNow: (options) => ctx.gnomonKernel.judgeNow(options), appendSignal: (type, payload) => ctx.gnomonKernel.appendSignal(type, payload) }),
  );

  const dailyCaps = resolveDailyCaps(loadSundialConfig().budgets);

  // The waterfall wraps EVERY dsh model call (agent conversation only — the
  // kernel's effect LLM calls use @sundial/llm's own transport and never pass
  // here, so nothing is double-metered or double-audited). Listener
  // registration is context-scoped, so it is torn down with the plugin on
  // unload. The same listener meters the spend AND writes the call's
  // `llm_audit` row, which is what makes the Ledger's "every call Gnomon
  // makes" true of the chat and not just of the machinery behind it.
  ctx.on(
    'llm/stream',
    createAskBudgetGuard({
      getState: () => ctx.gnomonKernel.getState(),
      getDailyCap: (purpose) => dailyCaps[purpose],
      appendSignal: (type, payload) => ctx.gnomonKernel.appendSignal(type, payload),
      recordAudit: createLlmAuditRecorder({
        queries: ctx.gnomonDb.queries,
        getMomentId: () => ctx.gnomonKernel.getState()?.moment?.id ?? null,
        routeBaseUrl: (id) =>
          id === DEFAULT_PROVIDER || id === LEGACY_PROVIDER
            ? process.env.SUNDIAL_LLM_BASE_URL
            : loadSundialConfig().llm.providers.find((p) => p.id === id)?.baseUrl,
      }),
    }),
  );

  console.log(
    `[sundial-tools] registered ${hot.length} hot read tools + ${cold.length} deferred behind ${DISCOVER_TOOL_NAME}/${DISPATCH_TOOL_NAME} + gnomon_assert + ${SURFACE_TOOL_NAME} + the gnomon:now clock context; repeat-call handles armed; ask budget guard armed (cap ${dailyCaps.ask}/day), chat calls written to the ledger`,
  );
}
