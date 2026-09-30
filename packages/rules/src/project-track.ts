import { canonicalProjectRoot } from '@sundial/helpers/redact/redact-url.js';
import { canonicalProjectName } from '@sundial/helpers/sundial-config.js';
import { deriveId } from '@sundial/helpers/derive-id.js';
import type { Effect, KernelState, ProjectRef, Rule } from '@sundial/kernel/types.js';

interface ProjectDetectedPayload {
  projectRoot?: string;
  projectName?: string;
  branch?: string | null;
  /** Full git remote URL, if the root has an `origin` (sensor-captured). */
  remote?: string | null;
  /** Organization owner slug derived from the remote (e.g. `acme`), or null. */
  org?: string | null;
}

/**
 * Longest-prefix `orgByPath` match — the owner's curated path→org map
 * (`~/Projects/acme` → `Acme`) wins over the remote-derived `org`, which is
 * noisy for forks/personal remotes (a fork of odysseus reports its GitHub
 * owner, not "playground"). Keys are canonicalized the same way as the root so
 * a config written with `~` or an absolute path both match.
 */
function orgForRoot(root: string, orgByPath: Record<string, string>): string | null {
  let best: string | null = null;
  let bestLen = -1;
  for (const [prefix, org] of Object.entries(orgByPath)) {
    const p = canonicalProjectRoot(prefix);
    if ((root === p || root.startsWith(`${p}/`)) && p.length > bestLen) {
      bestLen = p.length;
      best = org;
    }
  }
  return best;
}

/**
 * How many recent detections the `current` pointer is decided over. Ten, from
 * measuring the real 21,212-detection sequence: it takes 18,194 pointer moves
 * down to 32 (1.5/day), where a wider window of 20 gives 19 and a narrower 5
 * still leaves 395 with a 93% reversal rate among them.
 */
const DETECTION_WINDOW = 10;

/**
 * The dominant root in the recent detection window, or the existing pointer when
 * no root holds a strict majority.
 *
 * Requiring a strict majority means a genuinely ambiguous stretch — locators
 * rotating evenly between three repositories — leaves `current` where it was
 * rather than picking one arbitrarily. That is the intended bias: `current` is
 * documented as an ambient hint, real attribution comes from the per-window
 * resolver in `attribution.ts`, and a stale hint is far cheaper than one that
 * flickers into stored moments through the `git-activity` fallback.
 */
function nextCurrent(state: KernelState, recent: string[], nameForRoot: string): ProjectRef | null {
  const counts = new Map<string, number>();
  for (const r of recent) counts.set(r, (counts.get(r) ?? 0) + 1);

  let dominant: string | null = null;
  let best = 0;
  for (const [candidate, n] of counts) {
    if (n > best) {
      best = n;
      dominant = candidate;
    }
  }

  if (dominant === null || best * 2 <= recent.length) return state.project.current;
  if (state.project.current?.id === dominant) return state.project.current;
  // The window's dominant root may not be the one just detected, so take its name
  // from the registry rather than this event's payload.
  return { id: dominant, name: state.project.known[dominant]?.name ?? (dominant === recent[recent.length - 1] ? nameForRoot : dominant) };
}

/**
 * Reacts to `project:detected` — the single writer of `state.project.known`
 * (the registry per-window attribution prefix-matches against, see
 * `attribution.ts`) and of the durable `projects` rows.
 *
 * `id` is the root path — deterministic, so this pure rule assigns it (and a
 * remote-derived `organizationId`) with no DB read. Org is derived at
 * DETECTION time from the git remote, not re-written to null on every
 * re-detect (the old clobber bug): re-detecting the same root just refreshes
 * its `known` entry and re-upserts the same rows idempotently.
 *
 * `state.project.current` remains the ambient "what am I working on" hint that
 * `entityExtract`/`deploy`/`contextSwitch` and the `shell-cwd` attribution tier
 * read — but it no longer follows every detection. It moves only when a root
 * holds a strict majority of the recent detection window (`nextCurrent`),
 * because the detection stream is a poll over rotating locators rather than a
 * sequence of decisions. `known` is still refreshed on EVERY detection: the
 * registry should learn about a repository the first time it is seen, and only
 * the pointer needs damping.
 */
const NAMED_PREFIX = 'named:';

/**
 * The fold half of a merge: `from` (a synthetic `named:<project>` id) leaves
 * the registry and every pointer that named it now names `into`. The row half
 * — moments, commitments, the `projects` row — is the `MergeProject` effect
 * the executor performs. Other rules with project-keyed state fold this same
 * event for themselves (`projectTouchForecast` does); one event, many small
 * handlers, per the law.
 */
function applyMerge(state: KernelState, from: string, into: string): { state: KernelState; effects: Effect[] } {
  if (!(from in state.project.known)) return { state, effects: [] };
  const known: KernelState['project']['known'] = {};
  for (const [root, project] of Object.entries(state.project.known)) if (root !== from) known[root] = project;
  const current = state.project.current?.id === from ? { id: into, name: known[into]?.name ?? state.project.current.name } : state.project.current;
  const lastClosedMoment = state.project.lastClosedMoment?.projectId === from ? { ...state.project.lastClosedMoment, projectId: into } : state.project.lastClosedMoment;
  return {
    state: {
      ...state,
      project: {
        ...state.project,
        known,
        current,
        recentDetections: state.project.recentDetections.map((root) => (root === from ? into : root)),
        lastClosedMoment,
      },
    },
    effects: [{ type: 'MergeProject', from, into }],
  };
}

export const projectTrack: Rule = (state, event) => {
  if (event.type === 'project:merged') {
    const { from, into } = event.payload as { from?: string; into?: string };
    if (typeof from !== 'string' || typeof into !== 'string' || from === into) return { state, effects: [] };
    return applyMerge(state, from, into);
  }
  if (event.type !== 'project:detected') return { state, effects: [] };

  const payload = event.payload as ProjectDetectedPayload;
  if (!payload.projectRoot) return { state, effects: [] };

  // Identity is the tier-independent canonical root, NOT the raw (tier-gated)
  // `projectRoot` — otherwise a redaction-tier change reforks the id (a tier-1
  // absolute path vs a tier-2 `~`-collapsed one become two `projects` rows for
  // the same directory).
  const root = canonicalProjectRoot(payload.projectRoot);
  const name = payload.projectName ?? root;
  const branch = payload.branch ?? null;
  const remote = payload.remote ?? null;
  // Owner-curated path→org map wins; fall back to the remote-derived slug.
  const org = orgForRoot(root, state.config.orgByPath) ?? payload.org ?? null;

  const effects: Effect[] = [
    {
      type: 'WriteDB',
      table: 'projects',
      row: { id: root, name, rootPath: root, organizationId: org },
    },
  ];
  // W6 P9: the org rides on `projects.organizationId` only. Its own `organizations` row (the same
  // slug as id and name, 2,820 upserts for 4 rows) had no reader, so it is no longer written.

  const recentDetections = [...state.project.recentDetections, root].slice(-DETECTION_WINDOW);

  // A real root arriving for a name a synthetic `named:<project>` id was minted
  // for earlier: the two are one project. `findKnownByName` already sends new
  // windows to the real root; this asks for the synthetic to be folded away —
  // as an EVENT, so the merge is in the log and every project-keyed slice can
  // fold it, rather than a silent registry edit here.
  if (!root.startsWith(NAMED_PREFIX)) {
    const canonical = canonicalProjectName(name, state.config.projectAliases);
    for (const [other, project] of Object.entries(state.project.known)) {
      if (!other.startsWith(NAMED_PREFIX) || canonicalProjectName(project.name, state.config.projectAliases) !== canonical) continue;
      effects.push({
        type: 'EmitEvent',
        event: { id: deriveId(event.ts, event.id, 'project-merged', other), type: 'project:merged', ts: event.ts, payload: { from: other, into: root } },
      });
    }
  }

  return {
    state: {
      ...state,
      project: {
        ...state.project,
        current: nextCurrent(state, recentDetections, name),
        known: { ...state.project.known, [root]: { name, org, remote, branch } },
        recentDetections,
      },
    },
    effects,
  };
};
