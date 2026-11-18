// experiments.screenStage (off unless true): the windows Gnomon works in sit side by side on the free screen, three at
// most, placed by code (Sundial.app's `place`), and each put back where it was (`unplace`) when the turn ends.

/** The slots for one, two and three windows: [x, y, w, h] in parts of the free screen. */
export const SLOTS = [[[0, 0, 1, 1]], [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]], [[0, 0, 0.5, 1], [0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]]]

/**
 * The stage once `app` is used by a chat (`session`). `slots` is [{app, used, session}] in slot order. An app on it keeps
 * its slot (placed again: a window it opened since gets the slot too); a new one takes the next slot and the rest move up
 * to the new layout; a fourth replaces the one used longest ago, which goes back where it was. `send`: the app commands, in order.
 */
export function staged(slots, app, session, now = Date.now()) {
  const slot = { app, used: now, session }
  const at = slots.findIndex((s) => s.app === app)
  if (at >= 0) return { slots: slots.with(at, slot), send: [{ type: 'place', app, slot: SLOTS[slots.length - 1][at] }] }
  if (slots.length < 3) {
    const next = [...slots, slot]
    return { slots: next, send: next.map((s, i) => ({ type: 'place', app: s.app, slot: SLOTS[next.length - 1][i] })) }
  }
  const old = slots.reduce((a, s, i) => (s.used < slots[a].used ? i : a), 0)
  return { slots: slots.with(old, slot), send: [{ type: 'unplace', app: slots[old].app }, { type: 'place', app, slot: SLOTS[2][old] }] }
}

/**
 * The stage for one plugin. `use(app, session, window?)` sends the place commands before a look or a step (for the window
 * `window` names, else the app's front one) and gives a ticket; `settle(ticket, placed)` takes the slot once the look after
 * says the app placed the window (true), gives a new app's slot back when it did not (false), and keeps it when nothing says
 * (undefined: an unplace of a window never placed does nothing). `end(session)` puts back that chat's windows only.
 */
export function screenStage(send, isOn) {
  const held = { slots: [] }
  return {
    use(app, session, window) {
      if (!app || !isOn()) return null
      const r = staged(held.slots, app, session)
      for (const command of r.send) send(window && command.app === app && command.slot ? { ...command, window } : command)
      return { app, known: held.slots.some((s) => s.app === app), after: r.slots }
    },
    settle(ticket, placed) {
      if (!ticket) return ''
      if (placed !== false || ticket.known) {
        held.slots = ticket.after
        return placed === true && !ticket.known ? `\nOn the screen stage, side by side, each in its own part of the free screen: ${held.slots.map((s) => s.app).join(', ')}.` : ''
      }
      held.slots = ticket.after.filter((s) => s.app !== ticket.app)
      held.slots.forEach((s, i) => send({ type: 'place', app: s.app, slot: SLOTS[held.slots.length - 1][i] }))
      return ''
    },
    has: (app) => held.slots.some((s) => s.app === app),
    /** Before a step that quits the app or closes its window: put it back now, or macOS keeps the small frame for its next launch (run 27). */
    free(app) {
      if (!held.slots.some((s) => s.app === app)) return
      held.slots = held.slots.filter((s) => s.app !== app)
      send({ type: 'unplace', app })
    },
    end(session) {
      const mine = held.slots.filter((s) => s.session === session)
      held.slots = held.slots.filter((s) => s.session !== session)
      for (const s of mine) send({ type: 'unplace', app: s.app })
    },
  }
}

/** The `session/event` hook: a chat's turn is over (done, failed or stopped: dsh appends `turn/end` in a finally), so its windows go back. */
export const turnEnded = (stage) => (session, event) => event?.type === 'turn/end' && stage.end(session?.id)
