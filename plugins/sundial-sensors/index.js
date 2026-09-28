// sundial-sensors: Gnomon's 20 sensors, re-attached to the dsh process
// (Phase 3 of PLAN.md).
//
// Thin adapter over @sundial/harness-runtime's SensorRuntime (ported from
// apps/daemon/src/daemon/index.ts — sensor construction, the 1s poll tick
// with overlap-drop, the cross-sensor wiring, boot rehydration of known
// project roots). Every emission goes through ctx.gnomonKernel.appendSignal
// (sanitize-at-ingest + fold, serialized on the kernel's one event lane).
//
// INVARIANT (PLAN.md #6): this process NEVER spawns TCC-gated subprocesses.
// The macOS-permission-gated sensors read sidecar JSON files written by the
// Swift launcher's children (~/.sundial/Sundial.app — started separately
// via `node apps/harness/bin/sundial-sidecars.js start`, direct spawn, never
// `open -a`). Sidecar staleness is surfaced by the provided service's
// getSensorHealth(); nothing is EVER respawned from here.
//
// SANCTIONED EXCEPTION — calendar (grandfathered, Phase 3 decision): the
// calendar sensor still exec's `sundial-calendar-helper` from the app bundle
// on demand, exactly as the daemon did. EventKit answers a query rather than
// streaming state, so it has no sidecar-file shape, and the helper carries
// the bundle's code identity. NOTE: the TCC responsibility chain now bottoms
// out at whatever starts dsh (your terminal or launchd), so Calendar consent
// may need re-granting after the cutover.
//
// Phone ingest (decision: loopback HTTP listener, port 8767): the paired iOS
// app's write path, replacing the old daemon's POST /ingest/phone on 8765
// (that port is now the legacy-daemon liveness probe and must stay dark).
// Same bearer-token file (~/.sundial/.daemon/api-token), same phone:*-only
// guard; see plugins/sundial-sensors/README.md for the iOS app change.
//
// Named exports only — a default export drops `inject`.
import { SensorRuntime, startPhoneIngestServer, PHONE_INGEST_PORT } from '@sundial/harness-runtime/index.js'

export const name = 'sundial-sensors'
export const inject = ['gnomonKernel', 'gnomonDb']

export async function apply(ctx, config = {}) {
  const runtime = new SensorRuntime({
    appendSignal: (type, payload, ts) => ctx.gnomonKernel.appendSignal(type, payload, ts),
    getState: () => ctx.gnomonKernel.getState(),
    getAllProjects: () => ctx.gnomonDb.queries.getAllProjects(),
  })

  // Sensors: boot rehydration + git sweep + the 1s poll tick, all torn down
  // by the disposer on unload (HMR-safe).
  await ctx.effect(async () => {
    await runtime.start()
    return () => runtime.stop()
  }, 'sundial-sensors poll loop')

  // Phone ingest listener — loopback only, closed in the disposer. Off unless
  // SUNDIAL_PHONE_INGEST=1 (in $SUNDIAL_HOME/.env): a listener nobody sends to
  // is attack surface for nothing.
  if (process.env.SUNDIAL_PHONE_INGEST === '1') await ctx.effect(async () => {
    const server = await startPhoneIngestServer({
      appendSignal: (type, payload, ts) => ctx.gnomonKernel.appendSignal(type, payload, ts),
      port: config.phoneIngestPort ?? PHONE_INGEST_PORT,
    })
    console.log(`[sundial-sensors] phone ingest listening on 127.0.0.1:${config.phoneIngestPort ?? PHONE_INGEST_PORT}`)
    return () => new Promise((resolve) => server.close(() => resolve()))
  }, 'sundial-sensors phone ingest')

  ctx.provide('gnomonSensors', {
    /** Sidecar freshness + TCC grant snapshot. Report-only; nothing is respawned. */
    getSensorHealth: () => runtime.getSensorHealth(),
  })
  console.log('[sundial-sensors] ready')
}
