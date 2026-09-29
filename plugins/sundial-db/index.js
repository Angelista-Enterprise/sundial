// sundial-db: Sundial's SQLite database, owned by the dsh process.
//
// One file, `$SUNDIAL_HOME/sundial.db` (plugin config `dbPath` overrides it).
// The folder is created 0700 and the file 0600 by the migration step.
//
// Named exports only — a default export drops `inject`.
import fs from 'node:fs'
import path from 'node:path'
import { getDb, initializeDatabase } from '@sundial/db/index.js'
import * as gnomonDbQueries from '@sundial/db/index.js'
import { getSundialHome } from '@sundial/helpers/config.js'
// lane H (H5): every line in logs/sundial.log gets its time. The first Sundial
// plugin with no service to wait on, so it runs before the others print.
import { stampConsole } from '@sundial/helpers/log-stamp.js'

stampConsole()

export const name = 'sundial-db'
export const inject = []

export async function apply(ctx, config = {}) {
  const dbPath = path.resolve(config.dbPath ?? path.join(getSundialHome(), 'sundial.db'))
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 })

  // Every @sundial/db call path resolves its connection via getDb() →
  // DATABASE_URL, so pin the env var AND the explicit first-call url (getDb
  // caches first-call-wins). Set before any other plugin can touch the db.
  const dbUrl = `file:${dbPath}`
  process.env.DATABASE_URL = dbUrl
  const db = getDb(dbUrl)

  await initializeDatabase()

  // The service: the live drizzle client plus every query module @sundial/db
  // exports (insertSignal, getMomentsSince, …). Consumers inject 'gnomonDb'.
  ctx.provide('gnomonDb', { db, dbPath, queries: gnomonDbQueries })
  console.log(`[sundial-db] ready (${dbPath})`)
}
