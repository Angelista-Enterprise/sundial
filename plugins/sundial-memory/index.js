// sundial-memory: @sundial/memory as a Cordis service.
//
// SECURITY INVARIANT (carried over from the daemon, non-negotiable):
// embeddings are computed by an on-device model over already-sanitized text.
// There is NO remote-embedding code path in @sundial/memory and none may be
// added here — see almanac/decisions/embeddings-local-model-evolution.md.
//
// Named exports only — a default export drops `inject`.
import * as gnomonMemoryModule from '@sundial/memory/index.js'

export const name = 'sundial-memory'
export const inject = []

export function apply(ctx) {
  // The whole @sundial/memory surface: computeEmbedding (local model),
  // fuse/score retrieval helpers. The kernel's effect executor and Phase 4
  // tools consume this via inject: ['gnomonMemory'].
  ctx.provide('gnomonMemory', gnomonMemoryModule)
  console.log('[sundial-memory] ready (local embedding model only)')
}
