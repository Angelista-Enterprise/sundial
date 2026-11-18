// fallow-ignore-next-line unresolved-import
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// fallow-ignore-next-line unresolved-import
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getLatestFoldRowid, getLatestSnapshot, getRecentFoldRows, getRecentSignals } from '@sundial/db/index.js';
import { loadLatestSnapshot, replayTail } from '@sundial/kernel/snapshot.js';
import { TOOL_REGISTRY, toolEnv } from '@sundial/kernel/tools/index.js';
import type { ToolEnv } from '@sundial/kernel/tools/registry.js';
import type { KernelState } from '@sundial/kernel/types.js';
import { adoptedRules } from '@sundial/kernel/watch-flow.js';
import { sandboxed } from '@sundial/kernel/read/rig-session.js';
import { watchRules } from '@sundial/rules/watch-rules.js';
import { rigSessions } from '@sundial/rules/rig-sessions.js';

/**
 * Track B6: live resources, and `resources/subscribe` on them.
 *
 * `sundial://context` is gnomon_current_context's answer; `sundial://notices` is gnomon_notices'
 * (the last 24 hours). A host that subscribes gets `notifications/resources/updated` when the
 * record moved under one: the MCP server is a separate process, so it looks at the database on
 * a timer while anyone listens (a new kernel snapshot for the context; a new delivered notice for
 * the notices) and stays quiet otherwise. The spec revision with `subscriptions/listen`
 * (2026-07-28) is in no SDK yet (see B1); this is the shape every host speaks today.
 *
 * Two more for a host that draws the fold as it happens (the observatory, PROPOSAL §5), on a
 * 500 ms look rather than 15 s, both cheap reads:
 *  - `sundial://fold`: the last `FOLD_ROWS` rows of the effect journal, each cut to which rule
 *    did what kind of thing on which event (`getRecentFoldRows`). It moves when a row lands
 *    (the journal's newest rowid). A row's later status change alone does not announce it.
 *  - `sundial://rules`: the adopted rules as `gnomon_test_rule` lists them. It moves on any
 *    `rule:*` signal. The snapshot it reads from is up to a minute old, so the `rule:*`
 *    signals logged since are folded on top by `watchRules` itself: a rule adopted, paused or
 *    dropped a second ago is already so here. Fires and verdicts are as of the snapshot.
 */

export interface LiveVersions {
  'sundial://context': string;
  'sundial://notices': string;
}

export const LIVE: Record<keyof LiveVersions, { name: string; description: string; tool: string }> = {
  'sundial://context': { name: 'Sundial context', description: "What the owner is doing now, as gnomon_current_context answers it. Updated when the record's snapshot moves.", tool: 'gnomon_current_context' },
  'sundial://notices': { name: 'Sundial notices', description: 'The notices Gnomon delivered in the last 24 hours, as gnomon_notices answers it. Updated when one is delivered.', tool: 'gnomon_notices' },
};

export const LIVE_INTERVAL_MS = 15_000;

/** What each resource's version is right now: the newest snapshot, the newest delivered notice. Cheap: two indexed reads. */
export async function liveVersions(): Promise<LiveVersions> {
  const [snapshot, notices] = await Promise.all([getLatestSnapshot(), getRecentSignals(10, 'notice')]);
  const delivered = notices.find((s) => s.eventType === 'delivered');
  return { 'sundial://context': snapshot?.id ?? '', 'sundial://notices': delivered?.id ?? '' };
}

/** The fast pair: the effect journal's newest row, the newest `rule:*` signal. */
export interface FastVersions {
  'sundial://fold': string;
  'sundial://rules': string;
}

export const FOLD_ROWS = 200;
export const FAST_INTERVAL_MS = 500;

/** The state `sundial://rules` lists from: the newest snapshot, with the `rule:*` signals since folded on top by the same interpreter. */
export async function liveRulesState(): Promise<KernelState | null> {
  const snap = await loadLatestSnapshot();
  if (!snap) return null;
  let state = snap.state;
  // S4: never a rig chat's sandbox row (`reduce` folds those into its sandbox, not the owner's rules); a rig chat marked
  // since the snapshot is marked here too, so its rows are known as the rig's.
  for (const e of await replayTail(snap.logOffset)) {
    if (e.type === 'thread:model' || e.type === 'thread:delegate') state = rigSessions(state, e).state;
    else if (e.type.startsWith('rule:') && !sandboxed(state, e)) state = watchRules(state, e).state;
  }
  return state;
}

export const FAST: Record<keyof FastVersions, { name: string; description: string; read: () => Promise<unknown> }> = {
  'sundial://fold': {
    name: 'Sundial fold',
    description: `The last ${FOLD_ROWS} effects the kernel journaled, oldest first: {event_id, effect_index, applied_at, rule_name, event_type, kind, emitted, status}. kind is the effect's variant (EmitEvent, RecordGateDecision …), emitted the type an EmitEvent raised. Updated within a second of a row landing.`,
    read: async () => ({ rows: await getRecentFoldRows(FOLD_ROWS) }),
  },
  'sundial://rules': {
    name: 'Sundial rules',
    description: 'The adopted watch rules, as gnomon_test_rule with no rule lists them (paused, version, fires, verdicts), with each one\'s flow. Updated within a second of any rule:* signal.',
    read: async () => ({ rules: adoptedRules((await liveRulesState())?.watch) }),
  },
};

export async function fastVersions(): Promise<FastVersions> {
  const [rowid, rules] = await Promise.all([getLatestFoldRowid(), getRecentSignals(1, 'rule')]);
  return { 'sundial://fold': String(rowid), 'sundial://rules': rules[0]?.id ?? '' };
}

export interface LiveOptions {
  check?: () => Promise<LiveVersions>;
  intervalMs?: number;
  checkFast?: () => Promise<FastVersions>;
  fastIntervalMs?: number;
}

/**
 * One timer over a set of URIs: running only while one of them is subscribed, it reads their
 * versions and announces the subscribed ones that moved. The baseline is read at the first
 * subscribe, so the first tick does not announce what the host just read.
 */
function poller<V extends { [K in keyof V]: string }>(server: McpServer, check: () => Promise<V>, intervalMs: number) {
  const subscribed = new Set<keyof V>();
  let last: V | null = null;
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const now = await check();
      if (last !== null) {
        for (const uri of subscribed) if (now[uri] !== last[uri]) await server.server.sendResourceUpdated({ uri: uri as string });
      }
      last = now;
    } catch (error) {
      console.error(`[sundial mcp] live check: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      ticking = false;
    }
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    last = null;
  };
  return {
    stop,
    async add(uri: keyof V) {
      subscribed.add(uri);
      if (timer !== null) return;
      last = await check();
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    remove(uri: keyof V) {
      subscribed.delete(uri);
      if (subscribed.size === 0) stop();
    },
  };
}

export function registerLive(server: McpServer, env: () => ToolEnv = toolEnv, { check = liveVersions, intervalMs = LIVE_INTERVAL_MS, checkFast = fastVersions, fastIntervalMs = FAST_INTERVAL_MS }: LiveOptions = {}): void {
  for (const [uri, { name, description, tool }] of Object.entries(LIVE)) {
    const t = TOOL_REGISTRY.find((x) => x.name === tool);
    if (!t) throw new Error(`The registry no longer holds ${tool}.`);
    server.registerResource(name, uri, { description, mimeType: 'application/json' }, async (u) => ({
      contents: [{ uri: u.href, mimeType: 'application/json', text: JSON.stringify(await t.handler({} as never, env()), null, 2) }],
    }));
  }
  for (const [uri, { name, description, read }] of Object.entries(FAST)) {
    server.registerResource(name, uri, { description, mimeType: 'application/json' }, async (u) => ({
      contents: [{ uri: u.href, mimeType: 'application/json', text: JSON.stringify(await read()) }],
    }));
  }

  const slow = poller(server, check, intervalMs);
  const fast = poller(server, checkFast, fastIntervalMs);
  const all = [...Object.keys(LIVE), ...Object.keys(FAST)];

  server.server.setRequestHandler(SubscribeRequestSchema, async ({ params }) => {
    const uri = params.uri;
    if (uri in LIVE) await slow.add(uri as keyof LiveVersions);
    else if (uri in FAST) await fast.add(uri as keyof FastVersions);
    else throw new Error(`Only ${all.join(', ')} can be subscribed to.`);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async ({ params }) => {
    if (params.uri in LIVE) slow.remove(params.uri as keyof LiveVersions);
    if (params.uri in FAST) fast.remove(params.uri as keyof FastVersions);
    return {};
  });
  const onclose = server.server.onclose;
  server.server.onclose = () => {
    slow.stop();
    fast.stop();
    onclose?.();
  };
}
