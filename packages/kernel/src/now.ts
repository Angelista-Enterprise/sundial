// What the owner is doing RIGHT NOW, read off kernel state.
//
// The kernel has always known this — the open moment, its project, how long it
// has run, whether a sustained-focus span is under way, whether the owner has
// gone idle, how often they switched in the last hour. It was folded on every
// event and read by nothing the owner could see. An assistant that knows what
// you are doing and never lets on is not an assistant; it is a log.
//
// Two consumers, one projection: the client's presence strip, and the turn brief
// (`turn-brief.ts`) injected into every turn so the model already knows before it
// is asked. Both read THIS and nothing else, so they can never disagree about the present.
//
// Pure. `state` in, plain data out. Testable without a daemon.

import { routineForecast } from './routines.js'
import { formatParam, param } from './calibrated.js'
import { selfReportDue } from './self-report.js'
import { localDate } from '@sundial/helpers/local-day.js'

const MINUTE = 60_000

/** `~/Projects/acme/puzzlebox-studio` → `puzzlebox-studio`. A path is a fact; a name is what the owner calls it. */
export function projectName(projectId: unknown): string | null {
  if (typeof projectId !== 'string' || projectId === '') return null
  const parts = projectId.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || null
}

const minutesSince = (iso: string | null | undefined, now: number): number | null => {
  const then = Date.parse(iso ?? '')
  return Number.isFinite(then) ? Math.max(0, Math.round((now - then) / MINUTE)) : null
}

/**
 * The snapshot.
 *
 * Every field is nullable, and the client draws nothing for a null rather than
 * a zero: "0 minutes into nothing" is a sentence the record never actually
 * says. `idle` and `flowMin` are the two that matter most and pull in opposite
 * directions — flow is the owner deep in something, idle is the owner gone —
 * and the strip leads with whichever is true.
 */
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

function sleepOf(energy: any, now: number) {
  if (!energy || typeof energy.sleepHours !== 'number' || !energy.sleptTo) return null
  if (now - Date.parse(energy.sleptTo) > 20 * HOUR_MS) return null
  return { hours: energy.sleepHours, from: energy.sleptFrom, to: energy.sleptTo }
}

/** A belief the judge has not moved in this long is the prior talking, not a read. */
const BELIEF_FRESH_MS = 10 * MINUTE

function selfOf(owner: any, now: number, timeZone: string) {
  if (!owner) return null
  // The judge runs only while something reads it (a due tap, or the gate's
  // flag), so between taps the beliefs are absent rather than a stale 50%.
  const judged = Date.parse(owner.perception?.lastJudgedAt ?? '')
  const fresh = Number.isFinite(judged) && now - judged <= BELIEF_FRESH_MS
  const mean = (b: any) => (fresh && b ? b.alpha / (b.alpha + b.beta) : null)
  const iso = new Date(now).toISOString()
  const today = localDate(iso, timeZone)
  const reports = Array.isArray(owner.selfReports) ? owner.selfReports : []
  const todays = reports.filter((r: any) => localDate(r.ts, timeZone) === today)
  const last = reports.length > 0 ? reports[reports.length - 1] : null
  const due = selfReportDue(owner, iso, timeZone)
  return { pFlow: mean(owner.focus), pStuck: mean(owner.stuck), lastTap: last?.tap ?? null, lastAt: last?.ts ?? null, today: todays.length, due, brierN: owner.brier?.n ?? 0 }
}

// `state` is read field by field, every one optional: a partial or older state reads as nulls, never throws.
export function nowSnapshot(state: any, now = Date.now()) {
  const coverage = state?.coverage ?? {}
  const moment = state?.moment ?? null
  const life = state?.lifeEvent ?? {}
  const window = state?.window?.active ?? null
  const flow = life.flow ?? null
  const hourAgo = now - 60 * MINUTE

  const switchesLastHour = Array.isArray(life.recentSwitches)
    ? life.recentSwitches.filter((s: any) => Date.parse(s?.at ?? '') >= hourAgo).length
    : null

  // What the owner usually does next, from the procedural tier. The one thing
  // here that is a tendency rather than an observation, and labelled as such
  // everywhere it is shown.
  const routines = state?.routines ?? {}
  const forecast = routineForecast(Array.isArray(routines.trail) ? routines.trail : [], routines.learned ?? {})

  const deferred = Array.isArray(state?.notices?.deferred) ? state.notices.deferred.length : 0
  const recentPhasic = Array.isArray(state?.notices?.recentPhasic) ? state.notices.recentPhasic : []
  const lastSaid = recentPhasic.length > 0 ? recentPhasic[recentPhasic.length - 1] : null
  // What Gnomon noticed today, said or not. `spentToday` is the tonic count the
  // gate keeps for its own budget; phasic ones are exempt from that budget and
  // live in the ring, so they are counted from it by day. The sum is the number
  // the strip shows — the invitation to go and see what those were.
  // Both counted by the owner's day, not the UTC one: in the evening a UTC
  // date is already tomorrow, and the count fell to zero hours early.
  const timeZone = state?.config?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const localDay = typeof state?.notices?.day === 'string' ? state.notices.day : null
  const todayIso = localDate(new Date(now).toISOString(), timeZone)
  const tonicToday = localDay === todayIso || localDay === null ? (state?.notices?.spentToday ?? 0) : 0
  const phasicToday = recentPhasic.filter((p: any) => typeof p?.at === 'string' && localDate(p.at, timeZone) === todayIso).length
  const noticedToday = tonicToday + phasicToday

  return {
    at: new Date(now).toISOString(),
    app: window?.processName ?? moment?.processName ?? null,
    project: projectName(moment?.projectId),
    /** Minutes into the open moment. */
    momentMin: moment ? minutesSince(moment.startTime, now) : null,
    /** What the model already decided this moment is about, once it has. */
    intent: moment?.intent?.status === 'done' && typeof moment.intent.text === 'string' ? moment.intent.text : null,
    branch: moment?.rollup?.gitBranch ?? null,
    commits: moment?.rollup?.gitCommitCount ?? 0,
    /** Minutes of unbroken same-process typing, when a focus span is under way. */
    flowMin: flow ? minutesSince(flow.startedAt, now) : null,
    idle: life.idle?.isIdle === true,
    switchesLastHour,
    /** The app the owner usually opens next from here, when a learned routine says so. */
    nextStep: forecast === null ? null : { process: forecast.expectedProcess, support: forecast.routine.support, reliability: formatParam(param(state, 'routine.next')) },
    /**
     * Whether Jev is answering (docs/jarvis/05, degraded modes). `none` is the
     * quiet case and draws nothing; `local-fallback` (a stored value; the name predates the rename) means the text model is
     * judging in Jev's place, `off` that nothing is judging and rules are on
     * their pre-Jev paths. A kill switch you cannot see is not engaged, it is
     * forgotten — so the strip says which is on.
     */
    judging: state?.judgement?.degraded ?? 'none',
    /** Things worth saying that are waiting for a better moment. */
    held: deferred,
    /** Ambient and interrupting notices delivered today, together. */
    noticedToday,
    /** The last time Gnomon interrupted, so the strip can say how long it has been quiet. */
    lastSaidAt: lastSaid?.at ?? null,
    lastSaid: lastSaid?.observation ?? null,
    // What the paired phone reports about the hours this machine cannot see.
    // A place older than a day is a stale report, not a location — the phone
    // sends a departure when the owner leaves, so a day-old arrival with no
    // departure means the phone stopped reporting, and saying "at the office"
    // would be a guess dressed as a fact.
    place: coverage.place && coverage.placeSince && now - Date.parse(coverage.placeSince) < DAY_MS ? coverage.place : null,
    placeSince: coverage.place && coverage.placeSince ? coverage.placeSince : null,
    /** The phone's current motion state, only while it is fresh. */
    activity: coverage.activity && coverage.activitySince && now - Date.parse(coverage.activitySince) < 2 * HOUR_MS ? coverage.activity : null,
    /** When the owner woke, if the phone reported a sleep that ended today. */
    wokeAt: coverage.lastSleepEnd && new Date(coverage.lastSleepEnd).toDateString() === new Date(now).toDateString() ? coverage.lastSleepEnd : null,
    // J3.1: last night, from Health over the phone ingest — hours and span, only while it is last night's.
    sleep: sleepOf(state?.owner?.energy, now),
    // J2.1: the owner-state filter's beliefs, and the taps that grade them. The
    // strip asks three times a day, three hours apart, in waking hours.
    self: selfOf(state?.owner, now, state?.config?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
    // Fold wave one — the five slices that were logged and never read.
    /**
     * Whether the ears are open, why, and until when — so the strip can say so
     * and the owner can change it. Hearing is the one sensor that records other
     * people, so it is the one that must never be running invisibly.
     */
    hearing: {
      listening: state?.hearing?.listening === true,
      reason: state?.hearing?.reason ?? null,
      until: state?.hearing?.until ?? null,
      title: state?.hearing?.title ?? null,
      muted: typeof state?.hearing?.mutedUntil === 'string' && Date.parse(state.hearing.mutedUntil) > now,
    },
    /** An app holding the microphone right now, and for how long. */
    call: state?.av?.call ? { app: state.av.call.app, kind: state.av.call.kind, min: minutesSince(state.av.call.since, now) } : null,
    /** A command that has failed several times in a row, if the streak is fresh. */
    failing: failingStreak(state?.shell?.streak, now),
    /** The owner's coding-agent sessions: how many are working, and which wait for them. */
    agents: fleetSummary(state?.agent?.fleet, now),
    /** Commits not yet pushed, across working copies. */
    unpushed: unpushedSummary(state?.git?.unpushed),
    /** Ticket keys and PR numbers read off the screen in the last capture. */
    screenRefs: Array.isArray(state?.screen?.refs) ? state.screen.refs.slice(0, 4) : [],
    /** The file touched most today, once it has been touched three times. */
    hotFile: hottest(state?.files?.hot),
    /** Badges that have sat unchanged for hours. */
    pressure: standing(state?.pressure?.byApp, now),
    /** The page open in the browser, while the browser is what they are in. */
    page: currentPage(state?.browser, window?.processName, now),
    /** The job Gnomon is doing right now, and how many the owner has waiting behind it. */
    working: state?.workbench?.open ? { jobId: state.workbench.open.id, kind: state.workbench.open.kind, subject: state.workbench.open.subject, reason: state.workbench.open.reason ?? null, min: minutesSince(state.workbench.open.openedAt, now) } : null,
    queued: Array.isArray(state?.workbench?.queue) ? state.workbench.queue.length : 0,
    /**
     * The workbench either side of the open slot: what is waiting, what closed
     * and how it went, and how many jobs today. The Work card used to know only
     * that something was running and that `n` were queued — so every finished
     * job collapsed into an identical fold labelled "Gnomon working", and the
     * one question the card exists to answer ("what has it been doing?") had no
     * answer on it. These are the same job records the kernel already keeps;
     * nothing here is derived.
     */
    workbench: {
      queue: (Array.isArray(state?.workbench?.queue) ? state.workbench.queue : []).slice(0, 5).map((job: any) => ({ id: job.id, kind: job.kind, subject: job.subject, reason: job.reason ?? null })),
      // Newest first: the ring is written oldest-to-newest, and the card reads
      // down from what just happened.
      recent: (Array.isArray(state?.workbench?.recent) ? state.workbench.recent : [])
        .slice(-8)
        .reverse()
        .map((job: any) => ({ id: job.id, kind: job.kind, subject: job.subject, title: job.title ?? null, outcome: job.outcome, closedAt: job.closedAt, min: minutesSince(job.openedAt, Date.parse(job.closedAt ?? '') || now) })),
      today: state?.workbench?.countToday ?? 0,
    },
  }
}

export type NowSnapshot = ReturnType<typeof nowSnapshot>;

function currentPage(browser: any, frontApp: unknown, now: number) {
  const current = browser?.current
  if (!current) return null
  // Only while the browser is frontmost and the read is fresh; a page left open
  // behind the editor is not what the owner is looking at.
  if (typeof frontApp === 'string' && frontApp !== current.app) return null
  if (now - Date.parse(current.updatedAt) > 10 * MINUTE) return null
  return { app: current.app, host: current.host, path: current.path, title: current.title, min: minutesSince(current.since, now) }
}

function failingStreak(streak: any, now: number) {
  if (!streak || streak.count < 3) return null
  if (now - Date.parse(streak.lastAt) > 30 * MINUTE) return null
  // `command` is the LAST command that failed, not one that failed repeatedly:
  // the streak counts consecutive failures whatever was typed, because a person
  // at a terminal changes the command between attempts.
  return { lastCommand: streak.command, count: streak.count, exitCode: streak.exitCode }
}

function fleetSummary(fleet: any, now: number) {
  if (!Array.isArray(fleet) || fleet.length === 0) return null
  const idle = fleet
    .filter((s) => s.state !== 'working' && now - Date.parse(s.since) <= 2 * HOUR_MS)
    .map((s) => ({ project: s.cwd.split('/').filter(Boolean).pop() ?? s.cwd, state: s.state, min: minutesSince(s.since, now), ...(s.title ? { title: s.title } : {}) }))
    .sort((a, b) => (b.min ?? 0) - (a.min ?? 0))
  return { total: fleet.length, working: fleet.filter((s) => s.state === 'working').length, idle }
}

function unpushedSummary(unpushed: Record<string, { ahead?: number; since: string }> | undefined) {
  const entries = Object.entries(unpushed ?? {})
  if (entries.length === 0) return null
  let total = 0
  let oldest: string | null = null
  for (const [, entry] of entries) {
    total += entry.ahead ?? 0
    if (oldest === null || entry.since < oldest) oldest = entry.since
  }
  return total > 0 && oldest !== null ? { total, repos: entries.length, since: oldest } : null
}

function hottest(hot: Record<string, { relPath: string; changes?: number }> | undefined) {
  let best = null
  for (const file of Object.values(hot ?? {})) {
    if ((file.changes ?? 0) < 3) continue
    if (best === null || (file.changes ?? 0) > (best.changes ?? 0)) best = file
  }
  return best ? { relPath: best.relPath, changes: best.changes } : null
}

function standing(byApp: Record<string, { count?: number; since: string }> | undefined, now: number) {
  const out = []
  for (const [app, entry] of Object.entries(byApp ?? {})) {
    const age = now - Date.parse(entry.since)
    if ((entry.count ?? 0) >= 5 && age >= 2 * HOUR_MS) out.push({ app, count: entry.count, hours: Math.round(age / HOUR_MS) })
  }
  return out.sort((a, b) => b.hours - a.hours).slice(0, 3)
}
