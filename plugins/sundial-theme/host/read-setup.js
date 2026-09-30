// Setup's one reading: permissions from the sidecars' own grant flags (null = not reported yet, never a guess), whether a model is configured (host and model, never the key), how much the record holds, and the machine's health.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSundialHome } from '@sundial/helpers/config.js'
import { getPermissionStatus } from '@sundial/helpers/permission-status.js'
import { getLatestMoments, getSignalTotals } from '@sundial/db/index.js'
import { lastBackupDate } from '@sundial/helpers/backup-dir.js'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'
import { localDate } from '@sundial/helpers/local-day.js'

// lane H: Sundial's own health, for Settings — what stands broken now (the
// `sensorHealth` fold's troubles), the last push, the last daily copy, and
// the budgets that ran out today. Read from state and the backup folder; nothing is recomputed.
function healthReading(state, now) {
  const h = state?.sensorHealth ?? null
  const today = localDate(new Date(now).toISOString(), loadSundialConfig().timezone)
  return {
    troubles: Object.entries(h?.troubles ?? {}).map(([key, t]) => ({ key, since: t.since, observation: t.observation, said: t.raisedAt !== null })),
    push: { configured: Boolean(loadSundialConfig().notifications.ntfy), ...(h?.push ?? { lastOkAt: null, lastFailedAt: null, lastError: null }) },
    lastBackup: lastBackupDate(),
    budgetsOutToday: Object.entries(h?.budgetExhausted ?? {}).filter(([, day]) => day === today).map(([purpose]) => purpose),
  }
}

export async function readSetup({ state, now }) {
  const home = getSundialHome()
  const base = process.env.SUNDIAL_LLM_BASE_URL ?? ''
  const host = URL.canParse(base) ? new URL(base).host : null
  // Shown to the person, so ~ rather than /Users/<name>.
  const tilde = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p)
  const label = process.env.SUNDIAL_LABEL ?? 'dev.sundial.agent'
  return {
    home: tilde(home),
    // Where the app is, for the "add this to the list" step: /Applications for the real install.
    app: tilde(process.env.SUNDIAL_APP_PATH || join(home, 'Sundial.app')),
    bundleId: process.env.SUNDIAL_BUNDLE_ID ?? (label === 'dev.sundial.agent' ? 'dev.sundial.daemon' : label),
    envFile: tilde(join(home, '.env')),
    permissions: getPermissionStatus(),
    llm: { configured: Boolean(base), host, model: process.env.SUNDIAL_LLM_MODEL ?? null, local: host !== null && /^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(host) },
    record: await getSignalTotals(),
    moments: (await getLatestMoments(3)).map((m) => ({ start: m.startTime, end: m.endTime, app: m.processName, title: Array.isArray(m.data.windowTitles) ? m.data.windowTitles[0] ?? null : null })),
    health: healthReading(state, now),
  }
}
