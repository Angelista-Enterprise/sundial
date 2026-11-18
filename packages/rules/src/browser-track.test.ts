import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { expect, it } from 'vitest';
import { browserTrack } from './browser-track.js';

const ev = (type: string, minute: number, payload: Record<string, unknown>): SanitizedEvent => ({ id: `${type}-${minute}`, type, ts: new Date(Date.parse('2026-09-01T09:00:00.000Z') + minute * 60_000).toISOString(), payload, sanitized: true });

it('W6 D1: a browser nothing can read clears the page of the other browser, until a tab is read again', () => {
  const tab = { app: 'Google Chrome', host: 'docs.example.com', path: '/guide', title: 'Guide' };
  let state = browserTrack(createInitialState('d1'), ev('browser:tab', 0, tab)).state;
  expect(state.browser.current).toMatchObject({ host: 'docs.example.com', path: '/guide' });
  state = browserTrack(state, ev('browser:status', 1, { app: 'Opera', authorized: true, supported: false, error: null })).state;
  expect(state.browser).toMatchObject({ current: null, unsupported: 'Opera', authorized: true });
  state = browserTrack(state, ev('browser:tab', 2, tab)).state;
  expect(state.browser).toMatchObject({ current: { host: 'docs.example.com' }, unsupported: null });
});
