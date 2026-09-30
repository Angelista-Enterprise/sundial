import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { projectTrack } from './project-track.js';

function projectDetectedEvent(projectRoot: string, projectName: string): SanitizedEvent {
  return {
    id: 'e1',
    type: 'project:detected',
    ts: '2026-01-01T00:00:00.000Z',
    payload: { projectRoot, projectName },
    sanitized: true,
  };
}

describe('projectTrack', () => {
  it('ignores events other than project:detected', () => {
    const state = createInitialState('device-1');
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T00:00:00.000Z', payload: {}, sanitized: true };

    const { state: next, effects } = projectTrack(state, event);

    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('writes state.project.current with the CANONICAL (home-collapsed) root path as a deterministic id', () => {
    const state = createInitialState('device-1');

    const { state: next } = projectTrack(state, projectDetectedEvent('/Users/x/Projects/gnomon', 'gnomon'));

    // Identity is tier-independent: the absolute path collapses to `~` so a redaction-tier change can't refork the id.
    expect(next.project.current).toEqual({ id: '~/Projects/gnomon', name: 'gnomon' });
    expect(next.project.org).toBeNull(); // no org-assignment mechanism exists yet
  });

  it('gives the same canonical id whether the root arrives absolute (tier 1) or home-collapsed (tier 2+)', () => {
    const state = createInitialState('device-1');

    const abs = projectTrack(state, projectDetectedEvent('/Users/x/Projects/gnomon', 'gnomon'));
    const tilde = projectTrack(state, projectDetectedEvent('~/Projects/gnomon', 'gnomon'));

    expect(abs.state.project.current?.id).toBe('~/Projects/gnomon');
    expect(tilde.state.project.current?.id).toBe('~/Projects/gnomon');
  });

  it('emits a WriteDB effect to persist the project, keyed by the canonical root path', () => {
    const state = createInitialState('device-1');

    const { effects } = projectTrack(state, projectDetectedEvent('/Users/x/Projects/gnomon', 'gnomon'));

    expect(effects).toEqual([
      {
        type: 'WriteDB',
        table: 'projects',
        row: { id: '~/Projects/gnomon', name: 'gnomon', rootPath: '~/Projects/gnomon', organizationId: null },
      },
    ]);
  });

  it('lets state.config.orgByPath (longest-prefix) override the remote-derived org', () => {
    const base = createInitialState('device-1');
    const state = { ...base, config: { ...base.config, orgByPath: { '~/Playground': 'playground', '~/Projects/acme': 'Acme' } } };
    const event: SanitizedEvent = {
      id: 'e1',
      type: 'project:detected',
      ts: '2026-01-01T00:00:00.000Z',
      // remote says "pewdiepie-archdaemon" (a fork owner); the curated path map must win.
      payload: { projectRoot: '/Users/x/Playground/odysseus', projectName: 'odysseus', remote: 'git@github.com:pewdiepie-archdaemon/odysseus.git', org: 'pewdiepie-archdaemon' },
      sanitized: true,
    };

    const { effects } = projectTrack(state, event);

    expect(effects).toEqual([
      { type: 'WriteDB', table: 'projects', row: { id: '~/Playground/odysseus', name: 'odysseus', rootPath: '~/Playground/odysseus', organizationId: 'playground' } },
    ]);
  });

  it('populates state.project.known with org/remote/branch from the event', () => {
    const state = createInitialState('device-1');
    const event: SanitizedEvent = {
      id: 'e1',
      type: 'project:detected',
      ts: '2026-01-01T00:00:00.000Z',
      payload: { projectRoot: '~/Projects/acme/foo', projectName: 'foo', branch: 'main', remote: 'git@github.com:acme/foo.git', org: 'acme' },
      sanitized: true,
    };

    const { state: next } = projectTrack(state, event);

    expect(next.project.known['~/Projects/acme/foo']).toEqual({ name: 'foo', org: 'acme', remote: 'git@github.com:acme/foo.git', branch: 'main' });
  });

  it('derives organizationId and emits both project and organization rows', () => {
    const state = createInitialState('device-1');
    const event: SanitizedEvent = {
      id: 'e1',
      type: 'project:detected',
      ts: '2026-01-01T00:00:00.000Z',
      payload: { projectRoot: '~/Projects/acme/foo', projectName: 'foo', org: 'acme' },
      sanitized: true,
    };

    const { effects } = projectTrack(state, event);

    expect(effects).toEqual([
      { type: 'WriteDB', table: 'projects', row: { id: '~/Projects/acme/foo', name: 'foo', rootPath: '~/Projects/acme/foo', organizationId: 'acme' } },
    ]);
  });

  it('does nothing when the payload has no projectRoot', () => {
    const state = createInitialState('device-1');
    const event: SanitizedEvent = { id: 'e1', type: 'project:detected', ts: '2026-01-01T00:00:00.000Z', payload: {}, sanitized: true };

    const { state: next, effects } = projectTrack(state, event);

    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });


  /**
   * The C09 defect: `current` used to move on every detection, and the detection
   * stream is a poll over rotating locators, not a sequence of decisions. 21,212
   * real detections produced 18,194 pointer moves at a median hold of 0s, and
   * `shell-cwd` attribution plus `momentClose`'s `git-activity` fallback stamped
   * that churn into 59% of all A→B→A reversals in stored moments.
   */
  describe('entry hysteresis on state.project.current', () => {
    /** Folds a run of detections and returns the resulting state. */
    function detect(state: ReturnType<typeof createInitialState>, ...roots: string[]) {
      let s = state;
      for (const root of roots) s = projectTrack(s, projectDetectedEvent(root, root.split('/').pop() ?? root)).state;
      return s;
    }

    // From a cold start one observation is a majority of one, so the pointer
    // takes it rather than sitting null through the first minutes of a session.
    // Damping applies as soon as the window has anything to disagree with.
    it('adopts the first detection, having nothing to contradict it', () => {
      const s = detect(createInitialState('d1'), '~/p/a');
      expect(s.project.current).toMatchObject({ id: '~/p/a', name: 'a' });
    });

    it('refuses a challenger that does not hold a majority', () => {
      const s = detect(createInitialState('d1'), '~/p/a', '~/p/b');
      // 1 vs 1 — no strict majority, so the incumbent stays.
      expect(s.project.current?.id).toBe('~/p/a');
    });

    it('still registers every detected root in `known`, undamped', () => {
      const s = detect(createInitialState('d1'), '~/p/a', '~/p/b', '~/p/c');
      expect(Object.keys(s.project.known).sort()).toEqual(['~/p/a', '~/p/b', '~/p/c']);
    });

    it('holds the pointer steady while two locators alternate', () => {
      let s = detect(createInitialState('d1'), '~/p/a', '~/p/a', '~/p/a', '~/p/a', '~/p/a', '~/p/a');
      expect(s.project.current?.id).toBe('~/p/a');

      // Perfect alternation: neither root can hold a strict majority, so the
      // pointer must not flap. This is the exact shape of the measured defect.
      s = detect(s, '~/p/b', '~/p/a', '~/p/b', '~/p/a', '~/p/b', '~/p/a', '~/p/b', '~/p/a');
      expect(s.project.current?.id).toBe('~/p/a');
    });

    it('follows a genuine, sustained switch', () => {
      let s = detect(createInitialState('d1'), '~/p/a', '~/p/a', '~/p/a');
      expect(s.project.current?.id).toBe('~/p/a');

      s = detect(s, ...Array(8).fill('~/p/b'));
      expect(s.project.current?.id).toBe('~/p/b');
    });

    it('bounds the window so the snapshot cannot grow without limit', () => {
      const s = detect(createInitialState('d1'), ...Array(500).fill(0).map((_, i) => `~/p/r${i % 7}`));
      expect(s.project.recentDetections.length).toBeLessThanOrEqual(10);
    });

    it('names the pointer from the registry, not from whichever event happened to arrive', () => {
      // `b` is detected once (so it is in `known`), then `a` dominates.
      let s = detect(createInitialState('d1'), '~/p/b');
      s = detect(s, '~/p/a', '~/p/a', '~/p/a', '~/p/a', '~/p/a', '~/p/a');
      expect(s.project.current).toMatchObject({ id: '~/p/a', name: 'a' });
    });
  });

  it('asks for a synthetic named: project to be merged when its real root is detected', () => {
    const state = createInitialState('device-1');
    const withSynthetic = projectTrack(state, projectDetectedEvent('named:overture', 'overture')).state;
    expect(Object.keys(withSynthetic.project.known)).toEqual(['named:overture']);

    const { effects } = projectTrack(withSynthetic, projectDetectedEvent('/Users/x/Projects/acme/overture', 'overture'));
    const merge = effects.find((e) => e.type === 'EmitEvent');
    expect(merge).toMatchObject({ type: 'EmitEvent', event: { type: 'project:merged', payload: { from: 'named:overture', into: '~/Projects/acme/overture' } } });
  });

  it('does not ask for a merge between two real roots that share a name', () => {
    const state = createInitialState('device-1');
    const a = projectTrack(state, projectDetectedEvent('/Users/x/a/app', 'app')).state;
    const { effects } = projectTrack(a, projectDetectedEvent('/Users/x/b/app', 'app'));
    expect(effects.filter((e) => e.type === 'EmitEvent')).toEqual([]);
  });

  it('folds project:merged: the synthetic leaves the registry, pointers follow, and the rows are asked to move', () => {
    const state = createInitialState('device-1');
    let s = projectTrack(state, projectDetectedEvent('named:overture', 'overture')).state;
    s = projectTrack(s, projectDetectedEvent('/Users/x/Projects/acme/overture', 'overture')).state;
    s = { ...s, project: { ...s.project, current: { id: 'named:overture', name: 'overture' }, lastClosedMoment: { projectId: 'named:overture', confidence: 'weak' } } };

    const merged: SanitizedEvent = { id: 'm1', type: 'project:merged', ts: '2026-01-01T00:00:01.000Z', payload: { from: 'named:overture', into: '~/Projects/acme/overture' }, sanitized: true };
    const { state: next, effects } = projectTrack(s, merged);
    expect(Object.keys(next.project.known)).toEqual(['~/Projects/acme/overture']);
    expect(next.project.current).toEqual({ id: '~/Projects/acme/overture', name: 'overture' });
    expect(next.project.lastClosedMoment).toEqual({ projectId: '~/Projects/acme/overture', confidence: 'weak' });
    expect(next.project.recentDetections).not.toContain('named:overture');
    expect(effects).toEqual([{ type: 'MergeProject', from: 'named:overture', into: '~/Projects/acme/overture' }]);
    // A second fold of the same event changes nothing and asks for nothing.
    expect(projectTrack(next, merged)).toEqual({ state: next, effects: [] });
  });
});
