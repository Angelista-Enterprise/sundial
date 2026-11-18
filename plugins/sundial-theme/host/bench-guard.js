// Bench mode (docs/release/27 section 4): the identity check that keeps a bench answer off the owner's install lives in
// @sundial/helpers (bench-guard.ts), where the kernel's clock, the privacy config and plugins/sundial-bench read it too.
// Re-exported here for the approve and ingest routes and for lab/bench/bench-env.mjs.
export { BENCH_DIR, BENCH_LABEL, benchRefusal, benchSetup } from '@sundial/helpers/bench-guard.js'
