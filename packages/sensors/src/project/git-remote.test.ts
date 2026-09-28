import { describe, it, expect } from 'vitest';
import { orgFromRemote } from './project-capture.js';

describe('orgFromRemote', () => {
  it('extracts the owner from an scp-form github remote', () => {
    expect(orgFromRemote('git@github.com:acme/foo.git')).toBe('acme');
    expect(orgFromRemote('git@github.com:acme/foo')).toBe('acme');
  });

  it('extracts the owner from an https-form remote', () => {
    expect(orgFromRemote('https://github.com/acme/foo.git')).toBe('acme');
    expect(orgFromRemote('https://github.com/acme/foo')).toBe('acme');
  });

  it('handles gitlab subgroups by taking the immediate namespace of the repo', () => {
    expect(orgFromRemote('https://gitlab.com/group/subgroup/repo.git')).toBe('subgroup');
  });

  it('works for non-github hosts', () => {
    expect(orgFromRemote('git@bitbucket.org:acme/thing.git')).toBe('acme');
  });

  it('returns null for a missing or unparseable remote', () => {
    expect(orgFromRemote(null)).toBeNull();
    expect(orgFromRemote('not-a-url')).toBeNull();
  });
});
