import { deriveId } from '@sundial/helpers/derive-id.js';
import type { Effect, Rule } from '@sundial/kernel/types.js';

interface ProjectSwitchedPayload {
  kind?: string;
  fromProjectRoot?: string;
  toProjectRoot?: string;
  fromProjectName?: string;
  toProjectName?: string;
  fromBranch?: string;
  toBranch?: string;
}

/**
 * Deliberate simplification vs WCS's `LifeEventSensor`: WCS deferred
 * cross-project context-switch emission by `contextSwitchSustainedMs` and
 * cancelled it if the moment closed early (a "glance"), via a `setTimeout`.
 * A pure rule can't hold a timer or cancel a pending emission from a later
 * event — that needs a real scheduled-effect mechanism, which is Phase 4's
 * scope ("the full Effect union", "effect executor's retry/backoff"), not
 * this wave's. This rule emits immediately instead: real signal, lower
 * precision (counts brief glances the sustained version would have
 * suppressed) — worth revisiting once Phase 4 effects exist.
 *
 * Must run BEFORE `momentClose` in `RULE_MANIFEST` — it reads `state.moment`
 * as the about-to-be-closed moment (its `projectId`, populated by
 * `momentClose` itself when that moment was opened) to detect a
 * project change across the moment boundary. Once `momentClose` has run for
 * this same event, `state.moment` is already the newly reopened one.
 *
 * The switch is the closing moment's project against the last project a
 * moment closed on (`lastMomentProject`, which a project-less moment such as
 * a browser tab leaves alone) — never against the sticky
 * `state.project.current`. Against the pointer, every switch on 2026-09-23
 * went "to" the one project it held, which was never a "from", so a return
 * could not be seen. Both paths key a project by its id (its root), so a
 * branch flip reads as a switch within one project, not a third project.
 */
export const contextSwitch: Rule = (state, event) => {
  if (event.type === 'project:switched') {
    const payload = event.payload as ProjectSwitchedPayload;
    if (payload.kind !== 'branch') return { state, effects: [] };

    return {
      state,
      effects: [
        {
          type: 'EmitEvent',
          event: {
            id: deriveId(event.ts, event.id, 'context-switch', 'project-switched'),
            type: 'event:context-switch',
            ts: event.ts,
            payload: {
              timestamp: event.ts,
              fromProject: payload.fromProjectRoot ?? payload.fromProjectName ?? 'unknown',
              toProject: payload.toProjectRoot ?? payload.toProjectName ?? 'unknown',
              fromBranch: payload.fromBranch ?? 'unknown',
              toBranch: payload.toBranch ?? 'unknown',
              fromProcess: state.lifeEvent.lastMomentProcess ?? 'unknown',
              toProcess: state.lifeEvent.lastMomentProcess ?? 'unknown',
            },
          },
        },
      ],
    };
  }

  if (event.type !== 'window:changed') return { state, effects: [] };

  const closingMoment = state.moment;
  const previousProjectId = state.lifeEvent.lastMomentProject;

  const effects: Effect[] = [];
  if (closingMoment && closingMoment.projectId && previousProjectId && closingMoment.projectId !== previousProjectId) {
    effects.push({
      type: 'EmitEvent',
      event: {
        id: deriveId(event.ts, event.id, 'context-switch', 'window-changed'),
        type: 'event:context-switch',
        ts: event.ts,
        payload: {
          timestamp: event.ts,
          fromProject: previousProjectId,
          toProject: closingMoment.projectId,
          fromProcess: state.lifeEvent.lastMomentProcess ?? 'unknown',
          toProcess: closingMoment.processName,
        },
      },
    });
  }

  return {
    state: closingMoment
      ? { ...state, lifeEvent: { ...state.lifeEvent, lastMomentProject: closingMoment.projectId ?? previousProjectId, lastMomentProcess: closingMoment.processName } }
      : state,
    effects,
  };
};
