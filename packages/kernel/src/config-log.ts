// W3: config in the log. `config.json` is the seed and the log is the history:
// every change reaches `state.config` as a `config:changed` event (`configTrack`),
// from the route that wrote the file or from the boot that found it changed, so
// a replay runs on the config that was in force at the time.
import { resolveActions, type ResolvedSundialConfig } from '@sundial/helpers/sundial-config.js';
import type { KernelConfig } from './types.js';

/** The subset of the resolved config a pure rule may read: the boot's copy, in one place. */
export function kernelConfigOf(c: ResolvedSundialConfig): KernelConfig {
  return {
    retentionDays: c.retentionDays,
    screenTextRetentionDays: c.ocr.retentionDays,
    transcriptRetentionDays: c.audio.retentionDays,
    autoHearMeetings: c.audio.autoMeetings,
    decayFactor: c.decayFactor,
    projectRules: c.projectRules,
    sharedPlaces: c.sharedPlaces,
    projectAliases: c.projectAliases,
    orgByPath: c.orgByPath,
    locationLabels: c.locationLabels,
    ownerAliases: c.ownerAliases,
    timezone: c.timezone,
    refutationEnabled: c.refutationEnabled,
    leisureRules: c.leisureRules,
    experiments: c.experiments,
    notifications: { pushAtMac: c.notifications.pushAtMac, enabled: c.notifications.enabled },
    vault: c.vault,
    // lane E (#12)
    jobs: c.jobs,
    // Overrides, not resolved caps: JSON has no `Infinity`. Keys never live in config.json.
    budgets: c.budgets,
    llm: { use: c.llm.use, providers: c.llm.providers },
    actions: c.actions,
  };
}

/** One changed leaf. A secret's path is logged as `{changed: true}`, never its value. */
export interface ConfigDiffEntry {
  path: string;
  was?: unknown;
  now?: unknown;
  changed?: true;
}

const SECRET_PATH = /key|token|secret|password/i;
const secret = (path: string): boolean => SECRET_PATH.test(path) || /^integrations(\.|$)/.test(path) || /\.(env|headers)(\.|$)/.test(path);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const stable = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x)) ?? 'null';

/**
 * Objects whose keys are the schema's own, walked leaf by leaf. Every other
 * value (a record keyed by the owner's names or paths, a list) is one leaf, so
 * a path never carries an owner-chosen key and splits cleanly on `.`.
 */
const NESTED = new Set(['experiments', 'notifications', 'jobs', 'llm', 'leisureRules', 'actions', 'actions.internal', 'actions.outward']);

/**
 * The leaves where `now` differs from `was`. Not diffed: `pendingRestart`,
 * which the log derives. Key order does not count as a change.
 */
export function configDiff(was: object, now: object, at = ''): ConfigDiffEntry[] {
  const a = was as Record<string, unknown>;
  const b = now as Record<string, unknown>;
  const out: ConfigDiffEntry[] = [];
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const path = at === '' ? key : `${at}.${key}`;
    if (path === 'pendingRestart') continue;
    if (NESTED.has(path) && isObj(a[key]) && isObj(b[key])) {
      out.push(...configDiff(a[key] as object, b[key] as object, path));
      continue;
    }
    if (stable(a[key]) === stable(b[key])) continue;
    out.push(secret(path) ? { path, changed: true } : { path, was: a[key] ?? null, now: b[key] ?? null });
  }
  return out;
}

/** `config` with every non-secret entry's `now` set at its path. Pure. */
export function applyConfigDiff(config: KernelConfig, diff: readonly ConfigDiffEntry[]): KernelConfig {
  const setIn = (obj: Record<string, unknown>, [key, ...rest]: string[], value: unknown): Record<string, unknown> => ({
    ...obj,
    [key!]: rest.length === 0 ? value : setIn(isObj(obj[key!]) ? (obj[key!] as Record<string, unknown>) : {}, rest, value),
  });
  let out = config as unknown as Record<string, unknown>;
  for (const entry of diff) {
    if (!entry || typeof entry.path !== 'string' || entry.changed || !('now' in entry) || secret(entry.path)) continue;
    out = setIn(out, entry.path.split('.'), entry.now);
  }
  return out as unknown as KernelConfig;
}

/**
 * The `config.json` paths only a restart applies (W3): the redaction tier is
 * module state, sensors and the microphone are spawned at start, model routes
 * and MCP mounts are registered at start, the delivery transports and the
 * Claude hand are built at start, and the vault sensor and night-shift tools
 * exist only if their switch was on at start. Everything else a rule reads is
 * live through `state.config`.
 */
export const RESTART_PATHS = ['privacy', 'ocr', 'audio', 'browser', 'clipboardEnabled', 'pollIntervalMs', 'llm.providers', 'integrations', 'notifications', 'hands', 'vault', 'jobs.enabled', 'experiments.presence'];
/** Under a restart path, but read by rules from `state.config`. */
const LIVE_UNDER_RESTART = new Set(['ocr.retentionDays', 'audio.retentionDays', 'audio.autoMeetings', 'notifications.pushAtMac']);

/** The restart-only leaves that differ between two raw `config.json` objects. */
export function restartPaths(was: unknown, now: unknown): string[] {
  const leaves = (v: unknown, at: string, out: Map<string, string>): Map<string, string> => {
    if (isObj(v) && !/^integrations(\.|$)/.test(at)) for (const [k, x] of Object.entries(v)) leaves(x, at === '' ? k : `${at}.${k}`, out);
    else out.set(at, stable(v));
    return out;
  };
  const a = leaves(was ?? {}, '', new Map());
  const b = leaves(now ?? {}, '', new Map());
  const changed = [...new Set([...a.keys(), ...b.keys()])].filter((p) => a.get(p) !== b.get(p));
  return [...changed.filter((p) => !LIVE_UNDER_RESTART.has(p) && RESTART_PATHS.some((r) => p === r || p.startsWith(`${r}.`))), ...actionsRegistered(was, now)].sort();
}

/** An action tool is registered at start only when its policy is not `off` (sundial-actions), so a class whose off-set moved waits for a restart; ask and auto are live at the gate. */
function actionsRegistered(was: unknown, now: unknown): string[] {
  const [a, b] = [was, now].map((c) => resolveActions(isObj(c) ? c.actions : undefined));
  return (['internal', 'outward'] as const)
    .filter((k) => {
      const off = (x: typeof a, tool?: string) => ((tool === undefined ? undefined : x[k].byTool[tool]) ?? x[k].default) === 'off';
      return off(a) !== off(b) || [...Object.keys(a[k].byTool), ...Object.keys(b[k].byTool)].some((t) => off(a, t) !== off(b, t));
    })
    .map((k) => `actions.${k}`);
}

/** The `config:changed` payload for a route that just wrote the file, or null when nothing a rule or a restart sees moved. */
export function configChange(current: KernelConfig | undefined, written: ResolvedSundialConfig, restart: string[]): { source: 'owner'; diff: ConfigDiffEntry[]; restart: string[] } | null {
  const diff = current ? configDiff(current, kernelConfigOf(written)) : [];
  return diff.length === 0 && restart.length === 0 ? null : { source: 'owner', diff, restart };
}
