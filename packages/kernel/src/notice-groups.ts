// What Gnomon may say first, by group: the owner's quiet switches.
//
// A group is a set of notice kinds the owner thinks of as one thing ("the
// agents", "promises"). `settings.quiet` holds the ids the owner turned off;
// the gate suppresses their candidates with reason `owner-quiet`, so the
// Unsaid list still says what was held back and why. An owner question, a
// reminder the owner asked for (`wakeup`), a request, and anything in no group
// are never quieted here: the autonomy switch is the one that silences all.
//
// Pure, shared by the gate rule and the Settings card.

export interface NoticeGroup {
  id: string;
  label: string;
  what: string;
  kinds: readonly string[];
  prefixes?: readonly string[];
}

export const NOTICE_GROUPS: readonly NoticeGroup[] = [
  { id: 'agents', label: 'Coding agents', what: 'A Claude session waits, asks, fails, loops or collides with you.', kinds: [], prefixes: ['agent-'] },
  { id: 'briefs', label: 'Standup and meeting prep', what: 'Ten minutes before: the standup draft, and what is open with the people you meet.', kinds: ['standup-draft', 'meeting-prep'] },
  { id: 'promises', label: 'Promises', what: 'A promise fading, due at a meeting, or gone quiet.', kinds: ['promise-fading', 'commitment-fading', 'commitment-quiet'] },
  { id: 'returns', label: 'Where was I', what: 'Back from a break: what you were doing, and what you meant to do next.', kinds: ['return-from-break'], prefixes: ['absent:'] },
  { id: 'mail', label: 'Mail that matters', what: 'Mail from someone a promise is with.', kinds: ['mail-matters'] },
  { id: 'day', label: 'Your day and week', what: 'The day running long, a day end or a trend that moved.', kinds: ['day-ending', 'day-runs-long', 'day-end-drift', 'weekly-drift'], prefixes: ['drift:'] },
  { id: 'forecasts', label: 'Forecasts', what: 'A fragmented hour or a project touch Gnomon expects.', kinds: ['hour-fragmented', 'project-touched'], prefixes: ['tournament:'] },
  { id: 'work', label: "Gnomon's own work", what: 'A job shelved or closed, a goal step, an action it could not check.', kinds: ['work-shelved', 'work-closed', 'action-unverified'], prefixes: ['goal-'] },
  { id: 'shell', label: 'Failing commands', what: 'The same command failing again and again.', kinds: ['shell-failing-streak'] },
  { id: 'rules', label: 'Your watch rules', what: 'Rules you made by talking, and the unusual-activity alerts.', kinds: [], prefixes: ['watch:', 'activity-'] },
  // lane H
  { id: 'health', label: "Sundial's own health", what: 'A permission dropped, a sensor stopped, hearing broke, a model refused its key, or config.json could not be read.', kinds: ['sensor-health'] },
];

/** The group a notice kind belongs to, or null (never quieted by group). */
export function noticeGroupOf(kind: unknown): string | null {
  if (typeof kind !== 'string') return null;
  for (const g of NOTICE_GROUPS) if (g.kinds.includes(kind) || (g.prefixes ?? []).some((p) => kind.startsWith(p))) return g.id;
  return null;
}

/** Whether the owner turned this kind's group off. */
export const isQuieted = (quiet: readonly string[] | undefined, kind: unknown): boolean => {
  const group = noticeGroupOf(kind);
  return group !== null && (quiet ?? []).includes(group);
};

// lane H (H4)
/** Kinds in no group that still have a name a push can wear. */
const UNGROUPED_TITLES: Record<string, string> = { 'owner-question': 'Question', wakeup: 'Reminder' };

/** A push's title: what kind of thing this is, in the owner's words (the group's label). */
export function noticeTitle(kind: unknown): string {
  if (typeof kind === 'string' && UNGROUPED_TITLES[kind]) return UNGROUPED_TITLES[kind]!;
  const group = NOTICE_GROUPS.find((g) => g.id === noticeGroupOf(kind));
  return group?.label ?? 'Gnomon';
}
