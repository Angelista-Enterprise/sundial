// W3: config in the log. The single writer of `state.config` after boot:
// `config:changed` carries the leaves that moved (`config-log.ts`), from the
// route that wrote `config.json` (`source: 'owner'`) or from the boot that found
// it changed while stopped (`source: 'boot'`). A replay therefore runs on the
// config that was in force at the time, not on today's file.
import { applyConfigDiff, type ConfigDiffEntry } from '@sundial/kernel/config-log.js';
import type { Rule } from '@sundial/kernel/types.js';

export const configTrack: Rule = (state, event) => {
  if (event.type !== 'config:changed') return { state, effects: [] };
  const p = event.payload as { source?: unknown; diff?: unknown; restart?: unknown };
  const diff = Array.isArray(p.diff) ? (p.diff as ConfigDiffEntry[]) : [];
  const restart = Array.isArray(p.restart) ? p.restart.filter((r): r is string => typeof r === 'string') : [];
  // A boot applied everything the file held; an owner's change adds what waits for the next one.
  const pendingRestart = p.source === 'boot' ? [] : [...new Set([...(state.config.pendingRestart ?? []), ...restart])].sort();
  return { state: { ...state, config: { ...applyConfigDiff(state.config, diff), pendingRestart } }, effects: [] };
};
