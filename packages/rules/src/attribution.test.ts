import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, ProjectRule } from '@sundial/kernel/types.js';
import { resolveAttribution } from './attribution.js';

function withKnown(...roots: string[]): KernelState {
  const base = createInitialState('d1');
  const known = { ...base.project.known };
  for (const root of roots) known[root] = { name: root.split('/').pop() ?? root, org: null, remote: null, branch: null };
  return { ...base, project: { ...base.project, known } };
}

function withRules(state: KernelState, projectRules: ProjectRule[], projectAliases: Record<string, string> = {}): KernelState {
  return { ...state, config: { ...state.config, projectRules, projectAliases } };
}

describe('resolveAttribution', () => {
  it('attributes an editor documentPath under a known root (certain)', () => {
    const state = withKnown('~/proj/gnomon');
    const a = resolveAttribution(state, { processName: 'Code', windowTitle: 'a.ts — gnomon', documentPath: '~/proj/gnomon/src/a.ts' });
    expect(a).toEqual({ projectId: '~/proj/gnomon', source: 'editor-doc', confidence: 'certain' });
  });

  it('picks the longest matching root for nested worktrees', () => {
    const state = withKnown('~/proj/gnomon', '~/proj/gnomon/.worktrees/feature');
    const a = resolveAttribution(state, { processName: 'Code', windowTitle: 'x', documentPath: '~/proj/gnomon/.worktrees/feature/a.ts' });
    expect(a.projectId).toBe('~/proj/gnomon/.worktrees/feature');
  });

  it('tolerates a trailing slash on a known root', () => {
    const state = withKnown('~/proj/gnomon/');
    const a = resolveAttribution(state, { processName: 'Code', windowTitle: 'x', documentPath: '~/proj/gnomon/src/a.ts' });
    expect(a.projectId).toBe('~/proj/gnomon/');
  });

  // A root has been through `fs.realpathSync.native` (true on-disk casing); a
  // documentPath is whatever the editor reported. On a case-insensitive volume
  // those are the same file, and an exact-only compare dropped the window to
  // unattributed over casing alone.
  it('attributes a documentPath that differs from the root only by case', () => {
    const state = withKnown('~/Projects/acme/gnomon');
    const a = resolveAttribution(state, { processName: 'Code', windowTitle: 'a.ts — gnomon', documentPath: '~/projects/acme/gnomon/src/a.ts' });
    expect(a).toEqual({ projectId: '~/Projects/acme/gnomon', source: 'editor-doc', confidence: 'certain' });
  });

  it('prefers an exact-case root over a case-insensitive match', () => {
    const state = withKnown('~/proj/Gnomon', '~/proj/gnomon');
    const a = resolveAttribution(state, { processName: 'Code', windowTitle: 'x', documentPath: '~/proj/gnomon/src/a.ts' });
    expect(a.projectId).toBe('~/proj/gnomon');
  });

  it('still refuses to attribute a documentPath under no known root', () => {
    const state = withKnown('~/proj/gnomon');
    const a = resolveAttribution(state, { processName: 'Code', windowTitle: 'x', documentPath: '~/proj/unrelated/src/a.ts' });
    expect(a.projectId).toBeNull();
  });

  it('attributes a terminal window to the current project (shell-cwd, certain)', () => {
    const base = withKnown('~/proj/gnomon');
    const state: KernelState = { ...base, project: { ...base.project, current: { id: '~/proj/gnomon', name: 'gnomon' } } };
    const a = resolveAttribution(state, { processName: 'Warp', windowTitle: 'zsh', documentPath: null });
    expect(a).toEqual({ projectId: '~/proj/gnomon', source: 'shell-cwd', confidence: 'certain' });
  });

  it('falls back to a title-folder match when there is no documentPath (weak)', () => {
    const state = withKnown('~/proj/drone-ufo-mvp');
    const a = resolveAttribution(state, { processName: 'Code', windowTitle: 'Welcome — drone-ufo-mvp', documentPath: null });
    expect(a).toEqual({ projectId: '~/proj/drone-ufo-mvp', source: 'title-folder', confidence: 'weak' });
  });

  it('does NOT ambient-stamp a browser/chat window with no locator', () => {
    const base = withKnown('~/proj/gnomon');
    const state: KernelState = { ...base, project: { ...base.project, current: { id: '~/proj/gnomon', name: 'gnomon' } } };
    const a = resolveAttribution(state, { processName: 'Google Chrome', windowTitle: 'Some Page - Chrome', documentPath: null });
    expect(a).toEqual({ projectId: null, source: null, confidence: null });
  });

  it('ignores a documentPath under no known root', () => {
    const state = withKnown('~/proj/gnomon');
    const a = resolveAttribution(state, { processName: 'Code', windowTitle: 'x', documentPath: '~/elsewhere/y.ts' });
    expect(a.projectId).toBeNull();
  });

  it('treats a redacted [private] documentPath as no locator', () => {
    const state = withKnown('~/proj/gnomon');
    const a = resolveAttribution(state, { processName: 'Code', windowTitle: '[hidden]', documentPath: '[private]' });
    expect(a.projectId).toBeNull();
  });
});

describe('resolveAttribution — P1 project rules', () => {
  it('routes a browser URL rule to a synthetic named:<project> when no repo matches', () => {
    const state = withRules(withKnown('~/proj/gnomon'), [{ urlContains: 'localhost:3000', project: 'overture' }]);
    const a = resolveAttribution(state, { processName: 'Google Chrome', windowTitle: 'Home — localhost:3000', documentPath: null });
    expect(a).toEqual({ projectId: 'named:overture', source: 'rule-match', confidence: 'weak' });
  });

  it('MERGES a rule match onto a known repo root when the canonical name matches (browser time joins the repo)', () => {
    const state = withRules(withKnown('~/proj/overture'), [{ urlContains: 'overture-staging', project: 'overture' }]);
    const a = resolveAttribution(state, { processName: 'Google Chrome', windowTitle: 'Article — overture-staging.studiohq.nl', documentPath: null });
    expect(a).toEqual({ projectId: '~/proj/overture', source: 'rule-match', confidence: 'weak' });
  });

  // A browser reports its page URL as documentPath. Testing `urlContains`
  // against the title alone meant a host- or path-shaped rule never fired,
  // because a page title generally does not contain the URL it came from.
  it('matches urlContains against the page URL in documentPath', () => {
    const state = withRules(withKnown(), [{ urlContains: 'github.com/Acme/app', project: 'app' }]);
    const a = resolveAttribution(state, {
      processName: 'Google Chrome',
      windowTitle: 'Rebuild the tutorial by someone · Pull Request #4435 · Acme/app - Google Chrome',
      documentPath: 'https://github.com/Acme/app/pull/4435',
    });
    expect(a).toEqual({ projectId: 'named:app', source: 'rule-match', confidence: 'weak' });
  });

  it('still matches urlContains against the title when the URL is not exposed', () => {
    const state = withRules(withKnown(), [{ urlContains: 'jira.example.com', project: 'app' }]);
    const a = resolveAttribution(state, { processName: 'Google Chrome', windowTitle: 'Board — jira.example.com', documentPath: null });
    expect(a.projectId).toBe('named:app');
  });

  it('does not let a local file path satisfy urlContains', () => {
    const state = withRules(withKnown(), [{ urlContains: 'app/src', project: 'app' }]);
    const a = resolveAttribution(state, { processName: 'Code', windowTitle: 'a.ts', documentPath: '~/elsewhere/app/src/a.ts' });
    expect(a.projectId).toBeNull();
  });

  // Both ids can coexist: the synthetic one is minted the first time a rule
  // matches a project the filesystem hasn't revealed yet, and a later detection
  // adds the real root beside it. Returning insertion order splits one project.
  it('prefers a real filesystem root over an already-registered named: id', () => {
    const state = withRules(withKnown('~/proj/overture'), [{ urlContains: 'overture-staging', project: 'overture' }]);
    // Synthetic id FIRST, so insertion order would return the wrong one.
    state.project.known = { 'named:overture': { name: 'overture', org: null, remote: null, branch: null }, ...state.project.known };
    const a = resolveAttribution(state, { processName: 'Google Chrome', windowTitle: 'x', documentPath: 'https://overture-staging.example.com/a' });
    expect(a.projectId).toBe('~/proj/overture');
  });

  it('still falls back to the named: id when no real root exists', () => {
    const state = withRules(withKnown(), [{ urlContains: 'overture-staging', project: 'overture' }]);
    state.project.known = { 'named:overture': { name: 'overture', org: null, remote: null, branch: null } };
    const a = resolveAttribution(state, { processName: 'Google Chrome', windowTitle: 'x', documentPath: 'https://overture-staging.example.com/a' });
    expect(a.projectId).toBe('named:overture');
  });

  it('honors a rule confidence override and titleContains', () => {
    const state = withRules(withKnown(), [{ titleContains: 'atlassian.net', project: 'jira', confidence: 'certain' }]);
    const a = resolveAttribution(state, { processName: 'Google Chrome', windowTitle: 'KIT-403 - studio-nl.atlassian.net', documentPath: null });
    expect(a).toEqual({ projectId: 'named:jira', source: 'rule-match', confidence: 'certain' });
  });

  it('applies aliases so a rule project collapses onto the canonical repo (casing split fixed)', () => {
    // repo folder is "WCS", rule says "wcs" — alias map collapses both to "wcs".
    const state = withRules(withKnown('~/proj/WCS'), [{ urlContains: 'github.com/org/wcs', project: 'wcs' }], { WCS: 'wcs' });
    const a = resolveAttribution(state, { processName: 'Google Chrome', windowTitle: 'PR #1 — github.com/org/wcs', documentPath: null });
    expect(a.projectId).toBe('~/proj/WCS');
    expect(a.source).toBe('rule-match');
  });

  it('editor-doc still wins over a rule (certain filesystem truth first)', () => {
    const state = withRules(withKnown('~/proj/gnomon'), [{ titleContains: 'gnomon', project: 'other' }]);
    const a = resolveAttribution(state, { processName: 'Code', windowTitle: 'a.ts — gnomon', documentPath: '~/proj/gnomon/src/a.ts' });
    expect(a.source).toBe('editor-doc');
  });

  it('requires ALL present matchers to hold (AND)', () => {
    const state = withRules(withKnown(), [{ titleContains: 'localhost', processIs: 'Google Chrome', project: 'x' }]);
    // right title, wrong process → no match
    const a = resolveAttribution(state, { processName: 'Warp', windowTitle: 'localhost:3000', documentPath: null });
    expect(a.projectId).toBeNull();
  });
});

describe('resolveAttribution — coding-agent windows', () => {
  function withAgent(state: KernelState, cwd: string | null): KernelState {
    return { ...state, agent: { session: cwd ? { cwd, branch: null } : null } };
  }

  // A Claude window exposes no locator of its own: no AX document, and a title
  // that is the constant "Claude". Its project comes from the agent's own
  // session cwd, resolved through the same registry match as editor-doc.
  it('attributes a Claude window to the agent session project (certain)', () => {
    const state = withAgent(withKnown('~/proj/gnomon'), '~/proj/gnomon');
    const a = resolveAttribution(state, { processName: 'Claude', windowTitle: 'Claude', documentPath: null });
    expect(a).toEqual({ projectId: '~/proj/gnomon', source: 'agent-session', confidence: 'certain' });
  });

  // The whole point of the staleness bound: an idle agent must attribute
  // nothing rather than the last project the owner happened to code in.
  it('leaves a Claude window unattributed when no session is active', () => {
    const state = withAgent(withKnown('~/proj/gnomon'), null);
    expect(resolveAttribution(state, { processName: 'Claude', windowTitle: 'Claude', documentPath: null }).projectId).toBeNull();
  });

  it('does not attribute a session cwd that no known root covers', () => {
    const state = withAgent(withKnown('~/proj/gnomon'), '~/elsewhere/thing');
    expect(resolveAttribution(state, { processName: 'Claude', windowTitle: 'Claude', documentPath: null }).projectId).toBeNull();
  });

  // The agent tier is scoped to agent processes, exactly as shell-cwd is scoped
  // to terminals — it must never become an ambient fallback for any app.
  it('does not apply the agent session to an unrelated app', () => {
    const state = withAgent(withKnown('~/proj/gnomon'), '~/proj/gnomon');
    expect(resolveAttribution(state, { processName: 'Slack', windowTitle: 'general', documentPath: null }).projectId).toBeNull();
  });

  it('editor-doc still wins over the agent session', () => {
    const state = withAgent(withKnown('~/proj/gnomon', '~/proj/other'), '~/proj/other');
    const a = resolveAttribution(state, { processName: 'Claude', windowTitle: 'Claude', documentPath: '~/proj/gnomon/a.ts' });
    expect(a).toEqual({ projectId: '~/proj/gnomon', source: 'editor-doc', confidence: 'certain' });
  });
});

// The owner's alias map says "this project IS that project" (`wcs → gnomon`).
// The rule-match/title-folder tiers always honoured it via canonicalProjectName;
// the locator tiers used to return the resolved root as-is, so a certain locator
// (an agent session inside the aliased checkout) silently defeated the owner's
// own declaration — measured live: two `wcs` moments no config rule could reach.
describe('resolveAttribution owner-alias remap on locator tiers', () => {
  function withAliases(state: KernelState, projectAliases: Record<string, string>): KernelState {
    return { ...state, config: { ...state.config, projectAliases } };
  }

  function withAgent(state: KernelState, cwd: string | null): KernelState {
    return { ...state, agent: { session: cwd ? { cwd, branch: null } : null } };
  }

  it('agent-session inside an aliased checkout resolves to the declared project root', () => {
    const state = withAliases(withAgent(withKnown('~/proj/wcs', '~/proj/gnomon'), '~/proj/wcs'), { wcs: 'gnomon' });
    const a = resolveAttribution(state, { processName: 'Claude', windowTitle: 'Claude', documentPath: null });
    expect(a).toEqual({ projectId: '~/proj/gnomon', source: 'agent-session', confidence: 'certain' });
  });

  it('editor-doc inside an aliased checkout remaps the same way', () => {
    const state = withAliases(withKnown('~/proj/wcs', '~/proj/gnomon'), { wcs: 'gnomon' });
    const a = resolveAttribution(state, { processName: 'Code', windowTitle: 'a.ts — wcs', documentPath: '~/proj/wcs/a.ts' });
    expect(a).toEqual({ projectId: '~/proj/gnomon', source: 'editor-doc', confidence: 'certain' });
  });

  it('no alias for the root → the resolved root is returned unchanged', () => {
    const state = withAliases(withKnown('~/proj/wcs', '~/proj/gnomon'), {});
    const a = resolveAttribution(state, { processName: 'Code', windowTitle: 'a.ts — wcs', documentPath: '~/proj/wcs/a.ts' });
    expect(a.projectId).toBe('~/proj/wcs');
  });

  it('alias whose canonical project has no known root → keep the original root', () => {
    const state = withAliases(withKnown('~/proj/wcs'), { wcs: 'gnomon' });
    const a = resolveAttribution(state, { processName: 'Code', windowTitle: 'a.ts — wcs', documentPath: '~/proj/wcs/a.ts' });
    expect(a.projectId).toBe('~/proj/wcs');
  });

  it('a processIs-only rule attributes a whole app that exposes no locator', () => {
    const state = withRules(withKnown('~/proj/gnomon'), [{ processIs: 'Gnomon', project: 'gnomon' }]);
    const a = resolveAttribution(state, { processName: 'Gnomon', windowTitle: 'No Title Found', documentPath: null });
    expect(a).toEqual({ projectId: '~/proj/gnomon', source: 'rule-match', confidence: 'weak' });
  });

  it('a processIs-only rule never leaks onto other processes', () => {
    const state = withRules(withKnown('~/proj/gnomon'), [{ processIs: 'Gnomon', project: 'gnomon' }]);
    expect(resolveAttribution(state, { processName: 'Google Chrome', windowTitle: 'No Title Found', documentPath: null }).projectId).toBeNull();
  });
});
