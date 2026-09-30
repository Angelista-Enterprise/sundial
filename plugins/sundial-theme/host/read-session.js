// One thread's log as the frames that redraw it: the recent turns, unless the page asked for all of
// them (its "Earlier" fold). A fresh install has no companion conversation yet: that is empty, not broken.
import { recentTurns, replayFrames, titleFrom } from '../shell/frames.js'

/** How many turns opening a session replays; the rest wait behind "Earlier". */
const REPLAY_TURNS = 30

export async function readSession({ id, all, model, readSnapshot }) {
  const snapshot = await readSnapshot(id).catch((error) => {
    if (/not found/i.test(error instanceof Error ? error.message : '')) return null
    throw error
  })
  if (snapshot === null) return { id, title: '', frames: [], model }
  const replay = replayFrames(snapshot.events)
  const { frames, earlier } = all ? { frames: replay, earlier: 0 } : recentTurns(replay, REPLAY_TURNS)
  return { id, title: titleFrom(snapshot.events, ''), frames, earlier, model }
}
