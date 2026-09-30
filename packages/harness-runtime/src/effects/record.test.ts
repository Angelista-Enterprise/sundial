import { describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ insertKnowledgeEntry: vi.fn(async () => true) }));
vi.mock('@sundial/db/index.js', async (original) => ({ ...(await original<object>()), insertKnowledgeEntry: db.insertKnowledgeEntry }));
vi.mock('@sundial/kernel/week-review.js', () => ({ buildWeekReview: async () => ({ from: '2026-09-28', to: '2026-10-02', lines: ['Shipped: 3 commits.', 'Promises: 1 kept.'] }) }));

import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelRuntime } from '../runtime.js';
import { EFFECT_HANDLERS } from './index.js';

describe('ComposeWeekReview (W4 step 7)', () => {
  it('keeps the week as a week-review entry and answers brief:week-composed', async () => {
    const state = createInitialState('d');
    state.config.timezone = 'Europe/Amsterdam';
    const appendSignal = vi.fn(async () => {});
    const deferred: (() => void)[] = [];
    const host = { getState: () => state, defer: (fn: () => void) => deferred.push(fn), appendSignal } as unknown as KernelRuntime;
    await EFFECT_HANDLERS.ComposeWeekReview(host, { type: 'ComposeWeekReview', at: '2026-10-02T11:30:00.000Z' });
    expect(appendSignal).not.toHaveBeenCalled(); // off the lane
    deferred[0]!();
    await vi.waitFor(() => expect(appendSignal).toHaveBeenCalled());
    expect(db.insertKnowledgeEntry).toHaveBeenCalledWith(expect.objectContaining({ kind: 'week-review', dedupeKey: 'week-review:2026-09-28:2026-10-02', body: 'Shipped: 3 commits.\nPromises: 1 kept.' }));
    expect(appendSignal).toHaveBeenCalledWith('brief:week-composed', { from: '2026-09-28', to: '2026-10-02', lines: ['Shipped: 3 commits.', 'Promises: 1 kept.'], at: '2026-10-02T11:30:00.000Z' });
  });
});
