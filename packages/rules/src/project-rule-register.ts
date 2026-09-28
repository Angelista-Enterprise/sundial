import { canonicalProjectName } from '@sundial/helpers/sundial-config.js';
import { deriveId } from '@sundial/helpers/derive-id.js';
import type { Rule } from '@sundial/kernel/types.js';
import { findKnownByName, matchProjectRules, namedProjectId, type WindowLocatorInput, activeMeetingTitle } from './attribution.js';

interface WindowChangedPayload {
  processName?: string;
  windowTitle?: string;
  documentPath?: string | null;
}

function locatorFromEvent(payload: WindowChangedPayload): WindowLocatorInput {
  return {
    processName: typeof payload.processName === 'string' ? payload.processName : '',
    windowTitle: typeof payload.windowTitle === 'string' ? payload.windowTitle : '',
    documentPath: typeof payload.documentPath === 'string' ? payload.documentPath : null,
  };
}

/**
 * P1 (docs/design/07) — gives a rule-matched project that has NO filesystem
 * root (e.g. a browser-only project like `overture` matched by a
 * `localhost:3000` URL rule) a first-class `projects` row + `known` entry, so
 * it shows in the sidebar and `resolveAttribution` can resolve its
 * `named:<canonical>` id the same way it resolves a real repo.
 *
 * Reacts to `window:changed`. When a project rule matches and NO known project
 * already carries that canonical name (neither a filesystem-detected repo nor a
 * previously-registered synthetic), it emits a synthetic `project:detected` for
 * `projectTrack` — the single writer of `state.project.known`/the `projects`
 * table — to fold in. This is the same "attributed one event later, once the
 * detection it triggered folds into `known`" pattern `attribution.ts`
 * documents; it is self-limiting because once registered, `findKnownByName`
 * finds the entry and no further `project:detected` is emitted.
 *
 * When a rule instead matches a name a real repo already owns, nothing is
 * emitted here: `resolveAttribution` merges the window onto that repo's root
 * directly, which is the point (browser time joins the filesystem project).
 */
export const projectRuleRegister: Rule = (state, event) => {
  if (event.type !== 'window:changed') return { state, effects: [] };
  const rules = state.config.projectRules;
  if (rules.length === 0) return { state, effects: [] };

  const locator = locatorFromEvent(event.payload as WindowChangedPayload);
  const branch = state.project.current?.id ? (state.project.known[state.project.current.id]?.branch ?? null) : null;
  // The same meeting the resolver sees: without it a `meetingContains` rule can
  // attribute a window while this rule fails to register its synthetic project,
  // leaving moments carrying a `named:` id with no `projects` row behind it.
  const rule = matchProjectRules(rules, locator, branch, activeMeetingTitle(state));
  if (!rule) return { state, effects: [] };

  const aliases = state.config.projectAliases;
  // A known project (real root OR already-registered synthetic) by this
  // canonical name → nothing to register.
  if (findKnownByName(state.project.known, rule.project, aliases) !== null) return { state, effects: [] };

  const canonical = canonicalProjectName(rule.project, aliases);
  const root = namedProjectId(canonical);
  return {
    state,
    effects: [
      {
        type: 'EmitEvent',
        event: {
          id: deriveId(event.ts, event.id, 'project-rule-register', root),
          type: 'project:detected',
          ts: event.ts,
          payload: { projectRoot: root, projectName: canonical, branch: null, remote: null, org: null },
        },
      },
    ],
  };
};
