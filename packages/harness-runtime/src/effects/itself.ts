// Effects that act on Gnomon itself: an event it emits, and a job or helper it stops.
import { markEffectEmitted, signalExists } from '@sundial/db/index.js';
import type { Handlers } from './index.js';

export const ITSELF = {
  EmitEvent: async (host, effect, { eventId, effectIndex }) => {
    // K0.5 — the call-tree's edge, written before the child runs so it
    // survives the child throwing. This is the id the executor INTENDED to
    // ingest: an emit the ingest gate dedupes as an unchanged observation
    // still records it, and the join simply finds no rows, which is the
    // truth about that hop.
    await markEffectEmitted(eventId, effectIndex, effect.event.id);
    // A crash after the child reached the log but before this effect was
    // marked completed makes boot replay run it again. The child's row is
    // already in the tail, and replay folds it in its own turn; logging it
    // a second time would be a primary-key conflict that stops the boot.
    if (!(await signalExists(effect.event.id))) await host.ingestAndApply(effect.event);
  },
  StopJob: (host, effect) => host.act(effect),
  StopSubagent: (host, effect) => host.act(effect),
} satisfies Handlers;
