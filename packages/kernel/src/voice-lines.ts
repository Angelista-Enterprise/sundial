// Plan 15 step 3: what Gnomon says aloud while a tool still runs, after the nod. Seeded from the tool lines the
// thread shows (`shell/tool-line.js` PHRASES), said as a person would. One line per turn; never the last one again.

const BY_TOOL: Record<string, string[]> = {
  gnomon_today_summary: ['Let me look at the day.', 'One moment, reading today.'],
  gnomon_code_activity: ['Checking your commits.', 'Looking at what changed in the code.'],
  gnomon_semantic_search: ['Searching what I remember.', 'Let me find that.'],
  gnomon_entity_history: ['Looking that up.', 'Let me check what I know.'],
  gnomon_open_commitments: ['Checking what is still open.', 'Looking at your open threads.'],
  gnomon_moment_detail: ['Opening that moment.', 'Let me look at that stretch.'],
  gnomon_recent_activity: ['Looking at the last hour.', 'Checking what you just did.'],
  gnomon_current_context: ['Checking what is on your screen.', 'Looking at what you are doing.'],
  gnomon_people: ['Checking who that is.', 'Looking at the people I know.'],
  gnomon_did_i: ['Checking the record.', 'Let me see if you did.'],
};
/** How long a spoken reply can come back through the microphone. */
export const ECHO_MS = 60_000;
const wordsOf = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

/** Hearing heard Gnomon itself: most of the heard words are in a reply said in the last minute. */
export function isEcho(heard: string, said: readonly { text: string; at: string }[] | undefined, at: string): boolean {
  const words = wordsOf(heard);
  if (words.length === 0) return false;
  return (said ?? []).some((s) => {
    const age = Date.parse(at) - Date.parse(s.at);
    if (Math.abs(age) > ECHO_MS) return false;
    const spoken = new Set(wordsOf(s.text));
    return words.filter((w) => spoken.has(w)).length / words.length >= 0.6;
  });
}

const ANY = ['One moment.', 'Let me check.', 'Give me a second.', 'Looking into it.'];

/** A line for this tool that is not among `recent` (newest last); the tool's own lines first, then the general ones. */
export function pickLine(tool: string, recent: readonly string[] = []): string {
  const pool = [...(BY_TOOL[tool] ?? []), ...ANY];
  return pool.find((line) => !recent.includes(line)) ?? pool.find((line) => line !== recent.at(-1)) ?? ANY[0];
}

// Set 2 Round 1 item 5: a refused step, said with the step that follows it. Only refusals a person would narrate;
// a private app, a password, a sign-in or the owner's own hand stay silent (screen-tools.js `refusedOf` drops those).
const REFUSED: Record<string, string> = {
  'not-found': 'not found',
  'no-such-window': 'not found',
  'no-such-tab': 'not found',
  ambiguous: 'matches more than one thing',
  covered: 'is covered',
  'look again': 'moved',
  'app-changed': 'moved',
  'not-responding': 'did not answer',
  'unknown-action': 'did not work',
  'no-window': 'did not work',
  'cannot-raise': 'did not work',
  submenu: 'did not work',
  'not-in-text': 'did not work',
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Sort By not found. Open the View menu." Null when the refusal is not one to say, or nothing names the next step. */
export function refusalLine(refused: { reason?: string; name?: string }, next: string): string | null {
  const reason = refused.reason ?? '';
  const said = REFUSED[reason] ?? (reason.startsWith('ax-') ? 'did not work' : null);
  const then = next.trim().replace(/[.!?]+$/, '');
  if (!said || !then) return null;
  const name = (refused.name ?? '').split('>').at(-1)!.trim().split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
  return `${cap(name ? `${name} ${said}` : `That step ${said}`)}. ${cap(then)}.`;
}

const bare = (s: string, n: number) => s.trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '').slice(0, n).trim();

/**
 * Set 4 R1, recovery named: the slip's doing line on a refused step, so the owner sees the wall and the way around it. On the
 * refusal itself, before the model has picked the way around: "Click Sort By: not found. Trying another way."; on the step
 * that goes instead: "Click Sort By: not found. Instead: Open the View menu." From the step's own words (its `because`, else
 * the thing's name) and the refusal's reason. Every reason gets a line here, unlike `refusalLine`, which says only the ones
 * a person would narrate aloud.
 */
export function recoveryLine(refused: { reason?: string; name?: string }, because: string, next = ''): string {
  const reason = refused.reason ?? '';
  const why = REFUSED[reason] ?? (reason.startsWith('ax-') ? 'did not work' : `refused (${bare(reason, 40) || 'no reason given'})`);
  const name = (refused.name ?? '').split('>').at(-1)!.trim();
  const what = bare(because, 60) || bare(name, 40) || 'That step';
  const then = bare(next, 80);
  return `${cap(what)}: ${why}. ${then ? `Instead: ${cap(then)}.` : 'Trying another way.'}`;
}
