import { isRigSession } from './sandbox.js';

/**
 * Set 5 R2: what an app does to Gnomon's own steps, mined from them (`appNotes` in packages/rules app-learn.ts) and
 * read here, where both the kernel and the screen tools can reach it.
 *
 * A note is one kind of failed step in one app followed, in the same task, by the same other move that worked, in
 * `n` distinct tasks: "raise is refused here (no-such-window); open worked after it". The owner's chats and the
 * rig's are folded apart, so a bench never writes a note the owner's chats are shown.
 */
export interface AppNote {
  app: string;
  note: string;
  /** Distinct tasks the failure and its fix were seen in. */
  n: number;
  lastAt: string;
}

/** A pattern still counting toward a note: its distinct tasks so far and the newest few task ids that counted. */
export interface AppNoteTally {
  app: string;
  note: string;
  n: number;
  tasks: string[];
  lastAt: string;
}

export interface AppNotesSide {
  tally: Record<string, AppNoteTally>;
  notes: AppNote[];
}

export interface AppNotesSlice {
  /** Per chat and app, the newest failed step still waiting for the move that worked after it; a rig chat's marked, each side kept apart. */
  open: Record<string, { task: string; reason: string; failed: string; at: string; rig?: boolean }>;
  owner: AppNotesSide;
  rig: AppNotesSide;
  /** Set 5 R3: the owner's answer on the proposals card, by `noteKey`: kept (shown no more) or dropped (never used or mined again). Newest 24. */
  answered?: Record<string, 'kept' | 'dropped'>;
}

/** One note's key on the proposals card and in `answered`. */
export const noteKey = (n: { app: string; note: string }): string => `${n.app}\n${n.note}`;

interface Host {
  appNotes?: AppNotesSlice;
  rigSessions?: Record<string, string>;
}

/** The notes for `app` that this chat may see: the rig's own in a rig chat, the owner's anywhere else. Most tasks first. */
export function appNotesFor(state: Host | null | undefined, app: unknown, session?: unknown): AppNote[] {
  if (typeof app !== 'string' || app.trim() === '') return [];
  const side = isRigSession(state, session) ? state?.appNotes?.rig : state?.appNotes?.owner;
  const name = app.trim().toLowerCase();
  const answered = state?.appNotes?.answered ?? {};
  return (side?.notes ?? []).filter((n) => n.app.toLowerCase() === name && answered[noteKey(n)] !== 'dropped').sort((a, b) => b.n - a.n);
}

/** The lines a look or an act prints about `app`, the n beside each note, or '' when there is none. */
export function appNotesText(state: Host | null | undefined, app: unknown, session?: unknown): string {
  const notes = appNotesFor(state, app, session);
  return notes.length ? `What this app did to your own steps before (n = tasks it was seen in):\n${notes.map((n) => `- ${n.note} (n ${n.n})`).join('\n')}` : '';
}
