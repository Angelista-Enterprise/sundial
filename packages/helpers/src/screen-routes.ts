// What Gnomon learned on screen: the routes the log's `screen:step` rows hold per app.
//
// Read from the log at the moment it is needed (log over kernel mirror): `stepsOf` is the one query, the rest is
// pure over its rows. Here, in helpers, so both readers share one copy without a new dependency: `screen_act`
// (plugins/sundial-actions/screen-look.js re-exports these) tells a route once per task and replays one behind
// `screenFastRoutes`; the turn brief prints the routes of the apps of a turn (`@sundial/kernel/read/routes.ts`).

/** One `screen:step` row as the routes read it (already sanitized at ingest), with `at`, the row's time. */
export interface StepRow {
  verb?: string;
  role?: string;
  screenText?: string[];
  goal?: string | null;
  session?: string;
  ok?: boolean;
  changed?: boolean;
  typed?: number;
  key?: string;
  replaced?: boolean;
  reason?: string;
  at?: string;
  /** Not a step: the owner dropped the route of this key (`screen:route-dropped`), so it is never offered again. */
  dropped?: string;
  [field: string]: unknown;
}

export interface Route {
  goal: string | null;
  at: string | undefined;
  steps: StepRow[];
  /** The goal as it reads (or `session <id>`): what the owner's Drop names. */
  key: string;
  /** How many runs proved it. */
  n: number;
  /** Which of its typing places (`slotsOf`) the "<what was typed>" of its goal is: 0, the first, unless the goal's words matched a later one by length. */
  place?: number;
}

export const TYPED = '<what was typed>';
/** Clean runs of one goal shape after which screen_act replays its route with no switch (or the app holds its `routeWorks` fact). */
export const REPLAY_MIN = 3;
/**
 * Set 5 R1: clean runs after which a route replays by its id, the model having picked it from the list. One run is not
 * enough (a slip that landed once is not a route); the app's `routeWorks` fact or a skill the owner kept also qualify.
 */
export const ID_REPLAY_MIN = 2;

const quote = (s: unknown) => JSON.stringify(String(s ?? ''));
const hid = (s: unknown) => /^\[(private|hidden)\]$/.test(String(s ?? ''));
/** A ref given where the words on a thing go ("e162@572f"): the model's slip, never a name. */
export const looksLikeRef = (s: unknown) => /^[et]\d+(@[\w-]{4,6})?$/.test(String(s ?? '').trim());
const nameOf = (step: StepRow) => step.screenText?.[0] ?? '';
/** The goal has its own field; an older row kept it as the second screen word, blanked in a private app. */
const goalOf = (step: StepRow): string | null => step.goal || (hid(step.screenText?.[1]) ? null : step.screenText?.[1] || null);
const sameStep = (a: StepRow, b: StepRow) => a.verb === b.verb && a.role === b.role && nameOf(a) === nameOf(b) && a.key === b.key;
const worked = (s: StepRow) => s.ok === true && s.changed !== false;
/** `Array.prototype.findLastIndex`, which the kernel's lib target does not have. */
const lastIndex = <T>(list: T[], hit: (item: T) => boolean) => {
  for (let i = list.length - 1; i >= 0; i--) if (hit(list[i]!)) return i;
  return -1;
};

/**
 * The typed words show in a later step's name. A field or button named the words alone is its own label, not what was typed:
 * runs 179-182 took the goal's "message" and "discard" for typed words in the field "Message" and the button "Discard". A row
 * named the words alone is a search result ("Giant Steps"), so it counts.
 */
const shows = (s: StepRow, part: string, re: RegExp) =>
  nameOf(s).search(re) >= 0 && !(nameOf(s).trim().toLowerCase() === part.toLowerCase() && (/^(focus|type|set-value)$/.test(s.verb ?? '') || /button|field|text area|combo/i.test(s.role ?? '')));

/**
 * The words of the goal a run typed, as a pattern for the names after its first typing step: "giant steps" of "queue giant
 * steps" in "More options for Giant Steps". The log keeps a typed value's length, never its words, so the goal is the
 * evidence: its longest run of words (2 or more, or 6 characters or more) no longer than the longest value typed.
 */
function typedPart(goal: string | null, steps: StepRow[], others: ReadonlySet<string>): { re: RegExp; first: number; part: string; place: number } | null {
  const first = steps.findIndex((s) => s.typed);
  const most = Math.max(0, ...steps.map((s) => s.typed ?? 0));
  if (!goal || hid(goal) || first < 0) return null;
  const words = goal.trim().split(/\s+/);
  for (let n = words.length; n > 0; n--)
    for (let i = 0; i + n <= words.length; i++) {
      const part = words.slice(i, i + n).join(' ');
      if ((n < 2 && part.length < 6) || part.length > most) continue;
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu');
      if (steps.slice(first + 1).some((s) => shows(s, part, re))) return { re, first, part, place: 0 };
    }
  // Runs 218 to 226 (T27): a draft's subject shows in no later name, so each run's goal kept its own ("... the subject skill
  // run224, then"), no shape ever had 3 runs, and the route never replayed. Then the evidence is the other runs: the longest
  // run of words (punctuation off its ends) exactly as long as a value typed, where another run's goal has other words and
  // the same words around them. One goal alone, or the same goal every run, is never cut.
  const lengths = new Set(steps.map((s) => s.typed));
  for (let n = words.length; n > 0; n--)
    for (let i = 0; i + n <= words.length; i++) {
      const raw = words.slice(i, i + n).join(' ');
      const part = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if ((n < 2 && part.length < 6) || !lengths.has(part.length)) continue;
      const at = raw.indexOf(part);
      const before = [...words.slice(0, i), raw.slice(0, at)].join(' ').trimEnd();
      const after = [raw.slice(at + part.length), ...words.slice(i + n)].join(' ').trimStart();
      const fits = (g: string) => g !== goal && g.length > before.length + after.length + 1 && g.startsWith(before) && g.endsWith(after);
      if ([...others].some(fits)) return { re: new RegExp(`(?<![\\p{L}\\p{N}])${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu'), first, part, place: Math.max(0, steps.filter((s) => s.typed).findIndex((s) => s.typed === part.length)) };
    }
  return null;
}

/**
 * The routes the log holds for one app (`screen:step` rows): per goal (no goal: per session), the performed steps of the
 * latest run whose last step changed the screen, in order. A run is one goal in one session. What the run typed is
 * `<what was typed>` in its goal and its later names, so the route replays for the next song; of two routes alike after
 * that, the newest. Newest first. A route the owner dropped (a `dropped` row of its key) is left out, however often it
 * worked before or after.
 */
export function routesOf(rows: readonly StepRow[] | null | undefined): Route[] {
  const dropped = new Set((rows ?? []).map((r) => r?.dropped).filter((k): k is string => typeof k === 'string'));
  const proved = new Map<string, number>();
  const runs = new Map<string, StepRow[]>();
  for (const step of [...(rows ?? [])].filter((r) => r?.verb).sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    const key = goalOf(step) ?? (step.session ? `session ${step.session}` : null);
    // A replay sent by a route's id (screen_act {route: true, goal: "r12345"}) ran that route's own steps: nothing new to learn.
    if (!key || isRouteId(key)) continue;
    const id = `${key}\n${step.session ?? ''}`;
    runs.set(id, [...(runs.get(id) ?? []), step]);
  }
  const goals = new Set([...runs.values()].map((run) => goalOf(run[0]!)).filter((g): g is string => g !== null && !hid(g)));
  const best = new Map<string, Route>();
  for (const run of runs.values()) {
    // The final attempt only (runs 9 and 10 learned retries and toggles): what came after the last failed step,
    // without an empty set-value (a probe, not a move).
    const end = lastIndex(run, (s) => s.ok === true && s.changed === true);
    const start = lastIndex(run.slice(0, Math.max(0, end)), (s) => s.ok !== true) + 1;
    const tried = run.slice(start, end + 1).filter((s) => s.ok === true && !(s.verb === 'set-value' && !((s.typed ?? 0) > 0)));
    // Run 218 T03: run 217 typed the address with no field aimed at, then clicked To and typed it again; the route kept both,
    // and its copy typed the address twice into To. A typing into a field that is clicked again and typed again later is the
    // miss, not a step. Typing twice into one field with no click between (a title, Return, the body) stays.
    const typing = (s: StepRow) => s.verb === 'type' || s.verb === 'set-value';
    const same = (a: StepRow, b: StepRow) => a.role === b.role && nameOf(a) === nameOf(b);
    const done = tried.filter((s, i) => {
      if (!typing(s)) return true;
      const aim = tried.findIndex((o, j) => j > i && /^(click|focus|press)$/.test(o.verb ?? '') && same(o, s));
      // Runs 222 to 226: T14 and T27 ran one draft twice in one chat; a typing, then another field and Discard, is the whole block once.
      const between = aim < 0 ? [] : tried.slice(i + 1, aim);
      return aim < 0 || between.some((o) => typing(o) || o.verb === 'press') || !tried.slice(aim + 1).some((o) => typing(o) && same(o, s));
    });
    const last = done.at(-1);
    // Only a proven end is a route: a private app's step cannot say the screen changed, so its run is never one.
    // A ref where a name goes was a slip that landed by luck: it would not plan again.
    if (!last || last.changed !== true || done.some((s) => looksLikeRef(nameOf(s)))) continue;
    // Run 14: "put the screen back before you answer" made Gnomon restore a search box, and those became the
    // app's top routes, so the next task was taught to tidy instead of to work. Tidying is not a route.
    if (/\b(restore|restoring|put back|putting back|revert|undo)\b/i.test(goalOf(last) ?? '')) continue;
    // Run 11: a set-value that replaced a note was learned as "append", and the replay wiped it; an Escape only closed what a slip opened.
    if (done.some((s) => s.replaced === true && /text ?area/i.test(s.role ?? '')) || (last.verb === 'key' && /^esc/i.test(String(last.key ?? '')))) continue;
    const goal = goalOf(last);
    const once = done.filter((s, i) => i === 0 || !sameStep(s, done[i - 1]!));
    // A block done twice in a row (run 11 queued a song twice) is learned once.
    const half = once.length / 2;
    const kept = (Number.isInteger(half) && half > 0 && once.slice(0, half).every((s, i) => sameStep(s, once[half + i]!)) ? once.slice(0, half) : once).slice(0, 8);
    // The same move three times or more is going in circles (a pause that toggled four times), not a route.
    const counts = new Map<string, number>();
    for (const s of kept) counts.set(`${s.verb} ${nameOf(s)}`, (counts.get(`${s.verb} ${nameOf(s)}`) ?? 0) + 1);
    if ([...counts.values()].some((n) => n >= 3)) continue;
    const part = typedPart(goal, kept, goals);
    const steps = part ? kept.map((s, i) => (i > part.first && shows(s, part.part, part.re) ? { ...s, screenText: [nameOf(s).replace(part.re, TYPED)] } : s)) : kept;
    const shown = part && goal ? goal.replace(part.re, TYPED) : goal;
    const named = shown ?? `session ${last.session}`;
    proved.set(named, (proved.get(named) ?? 0) + 1);
    const key = goal ?? `session ${last.session}`;
    if (!best.has(key) || String(best.get(key)!.at) < String(last.at)) best.set(key, { goal: shown, at: last.at, steps, key: named, n: 0, ...(part ? { place: part.place } : {}) });
  }
  const shapes = new Set<string>();
  return [...best.values()]
    .filter((r) => !dropped.has(r.key))
    .map((r) => ({ ...r, n: proved.get(r.key) ?? 1 }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .filter((r) => {
      const shape = JSON.stringify(r.steps.map(stepCall));
      return !shapes.has(shape) && Boolean(shapes.add(shape));
    });
}

/** The steps the app refused here and that never worked after, newest first, one each, with how often they failed (`times`). */
export function deadEndsOf(rows: readonly StepRow[] | null | undefined): (StepRow & { times: number })[] {
  const all = [...(rows ?? [])].filter((r) => r?.verb && !looksLikeRef(nameOf(r))).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return all
    .filter((s, i) => s.ok === false && !all.slice(0, i).some((o) => sameStep(o, s) && (o.ok === false || worked(o))))
    .slice(0, 3)
    .map((s) => ({ ...s, times: all.filter((o) => o.ok === false && sameStep(o, s)).length }));
}

/** One step as screen_act takes it again by name: `press {role: "button", label: "New Note"}`. */
export function stepText(step: StepRow): string {
  const name = nameOf(step);
  if (step.verb === 'open') return 'open';
  if (step.verb === 'key') return `key ${quote(step.key ?? '')}`;
  if (step.verb === 'raise' && !hid(name)) return `raise {window: ${quote(name)}}`;
  if (step.verb === 'pick-menu' && !hid(name)) return `pick-menu ${quote(name)}`;
  const fields = [step.role && step.role !== 'text' ? `role: ${quote(step.role)}` : '', name && !hid(name) ? `${step.role === 'text' ? 'text' : 'label'}: ${quote(name)}` : ''].filter(Boolean);
  return `${step.verb}${fields.length ? ` {${fields.join(', ')}}` : ''}${hid(name) ? ' (its name is off the record)' : ''}${step.typed ? ` (a value, ${step.typed} characters)` : ''}`;
}

/** One kept step as a step of a screen_act call. A typed value was never kept: the model fills it in. */
export function stepCall(step: StepRow): Record<string, unknown> {
  const name = nameOf(step);
  const named = name && !hid(name);
  // S5R1 gap 3: a key on a thing replays on that thing (by its role and words; a ref is one look's), so the gate reads it as it ran.
  if (step.verb === 'key') return { action: 'key', value: step.key ?? '', ...(named && !looksLikeRef(name) && step.role && step.role !== 'key' ? { role: step.role, [step.role === 'text' ? 'text' : 'label']: name } : {}) };
  if (step.verb === 'pick-menu' && named) return { action: 'pick-menu', value: name };
  if (step.verb === 'raise') return { action: 'raise', ...(named ? { window: name } : {}) };
  if (step.verb === 'tab' && named) return { tab: name };
  if (step.verb === 'open' && /^https?:\/\//.test(name)) return { url: `${name}/<the rest of the address>` };
  return {
    action: step.verb,
    ...(step.role && step.role !== 'text' ? { role: step.role } : {}),
    ...(named ? { [step.role === 'text' ? 'text' : 'label']: name } : {}),
    ...(step.typed ? { value: '<what to type>' } : {}),
  };
}

/** A route id as `routeIdOf` spells it: "r" and five digits, never a word a goal could be. */
export const isRouteId = (s: unknown): boolean => /^r\d{5}$/.test(String(s ?? '').trim());

/**
 * A route's short stable id (Set 5 2A): a hash of the app and its `routeKeyOf`, so the same steps in the same app keep one
 * id across runs, chats and restarts. FNV-1a, so the rules can call it too.
 */
export const routeIdOf = (app: string, steps: readonly StepRow[]): string => routeIdOfKey(app, routeKeyOf(steps));

/** `routeIdOf` from a route's key, as a kept skill holds it (`selfReview.skills`, `routeKey`). */
export function routeIdOfKey(app: string, key: string): string {
  let h = 0x811c9dc5;
  for (const c of `${String(app).trim().toLowerCase()}\n${key}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return `r${10000 + (h % 90000)}`;
}

/**
 * The named places a route types into, in order: each typing step's field label ("To", "Subject"), a second typing into
 * the same field numbered ("Message 2"), its role when it has no name, "place N" when its name is off the record.
 */
export function slotsOf(steps: readonly StepRow[]): string[] {
  const seen = new Map<string, number>();
  return steps.filter((s) => s.typed).map((s, i) => {
    const name = hid(nameOf(s)) ? `place ${i + 1}` : nameOf(s).trim().slice(0, 30) || (s.role && s.role !== 'text' ? s.role : `place ${i + 1}`);
    const n = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), n);
    return n > 1 ? `${name} ${n}` : name;
  });
}

/** Where a goal's own values begin: a placeholder, a word with a digit, an address or path, a quote; or a word that brings one. */
const VALUE_WORD = /[<[\d@./\\"'“”]|^(to|named|called|titled|saying|about|subject|with)$/;
const TAIL = /^(a|an|the|and|then|my|your|its|new)$/;
/**
 * A route's name with no value of any run in it (runs 211 to 230: the model copied "the subject skill run224" from the list):
 * its goal's words up to the first one that is or brings a value, six at most. A route with no goal, one off the record or
 * one that is all values is named by its first step. "start a new message to [email] with the subject <what was typed>"
 * is "start a new message".
 */
export function routeName(route: Pick<Route, 'goal' | 'steps'>): string {
  const first = route.steps[0];
  return goalName(route.goal) ?? (first ? stepWord(first) : 'a task');
}

/** A goal's words up to its first value (`routeName`), or null when it is all values, off the record or none. */
export function goalName(goal: string | null | undefined): string | null {
  const words = hid(goal) || isRouteId(goal) ? [] : String(goal ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const cut = words.findIndex((w, i) => i > 0 && VALUE_WORD.test(w));
  const kept = words.slice(0, Math.min(cut < 0 ? words.length : cut, 6));
  while (kept.length > 1 && TAIL.test(kept.at(-1)!)) kept.pop();
  return kept.length && !/[<[\d@./\\"'“”]/.test(kept[0]!) ? kept.join(' ').replace(/[,:;]+$/, '') : null;
}

/**
 * Set 5 R1: a kept skill as a line names it. Its name is the goal of the run that offered it, with that run's values in it
 * ("... the subject kestrel 214"): it is named by its route id and the goal's words before any value, `r12345 "start a new
 * message"`, so no earlier value is printed for the model to copy.
 */
export function skillLabel(app: string, name: string, routeKey: string): string {
  const words = goalName(name);
  return `${routeIdOfKey(app, routeKey)}${words ? ` ${JSON.stringify(words)}` : ''}`;
}

/**
 * One step of a route as the list says it: the verb and the thing's own name; a window, tab, file or page by its verb alone, and
 * a row, a cell or a menu item by its role (review L5), since those names are a run's own. A button or a field keeps its name.
 */
function stepWord(s: StepRow): string {
  if (s.verb === 'key') return `key ${s.key ?? ''}`.trim();
  const name = nameOf(s);
  const runs = s.verb === 'pick-menu' || /\b(?:row|cell|menu ?item)\b/i.test(s.role ?? '');
  if (runs) return `${s.verb} ${s.verb === 'pick-menu' ? 'a menu item' : s.role}`;
  return /^(raise|tab|rename|open)$/.test(s.verb ?? '') || !name || hid(name) ? String(s.verb ?? 'step') : `${s.verb} ${JSON.stringify(name.slice(0, 60))}`;
}

/** One route as the list prints it: `r12345: start a new message (To, Subject): type "To" > type "Subject" > press "Discard"`. No value of any run. */
export function routeLine(app: string, r: Route): string {
  const slots = slotsOf(r.steps);
  const typing = r.steps.filter((s) => s.typed);
  const steps = r.steps.map((s) => (s.typed ? `type ${slots[typing.indexOf(s)]}` : stepWord(s))).join(' > ');
  // Set 5 R1: a route that ran once does not replay by id (`ID_REPLAY_MIN`): the list says so, so no call is spent on it.
  const runs = r.n >= ID_REPLAY_MIN ? `, worked ${r.n} times` : `, worked once: do its steps yourself, by id after ${ID_REPLAY_MIN} runs`;
  return `${routeIdOf(app, r.steps)}: ${routeName(r)} (${slots.length ? slots.join(', ') : 'nothing typed'})${runs}: ${steps}`;
}

const FILLER = new Set(['the', 'and', 'with', 'then', 'from', 'that', 'this', 'into', 'for', 'its', 'you', 'your']);
const wordsIn = (text: string | null | undefined): Set<string> => new Set((String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !FILLER.has(w)));

/**
 * What the model reads about one app from its own past: at most 5 routes and 3 dead ends. Empty when there is none.
 * `text`, the owner's message: the routes whose goal shares the most of its words come first, the newest on a tie. Run 183
 * T19: the same task again, nine minutes after the first, and five newer routes of other tasks in the app had pushed its
 * route out of the five, so the turn began with a look. Set 5 2A: a route is listed by its id, name and named places, never
 * an earlier run's goal or values (runs 211 to 230: 12 of 24 route calls were refused before a move, most on copied values).
 */
export function learned(rows: readonly StepRow[] | null | undefined, app: string, text?: string): string {
  const asked = wordsIn(text);
  const fit = (r: Route): number => [...wordsIn(r.goal)].filter((w) => asked.has(w)).length;
  const routes = (asked.size ? [...routesOf(rows)].sort((a, b) => fit(b) - fit(a)) : routesOf(rows)).slice(0, 5);
  const dead = deadEndsOf(rows);
  const call = JSON.stringify({ app, route: '<id>', values: { '<place>': '<its text>' } });
  return [
    routes.length ? `Worked here before in ${app}. Run one in one call with no look first: gnomon_skill ${call}, a text for each named place, taken from this task (never from an earlier one). Look only when a step fails.` : '',
    ...routes.map((r) => (r.steps.some((s) => hid(nameOf(s))) ? `- ${routeName(r)}: its names are off the record, so look before each step` : `- ${routeLine(app, r)}`)),
    dead.length ? `Did not work here: ${dead.map((s) => `${stepText(s)} (${s.reason ?? 'refused'}${s.times > 1 ? `, ${s.times} times` : ''})`).join('; ')}` : '',
  ].filter(Boolean).join('\n');
}

/** One step of a route as a `routeWorks` key spells it: `press button "Play"`, `key cmd+l`. */
export const part = (s: StepRow): string =>
  [s.verb, s.role, s.verb === 'key' ? s.key : s.screenText?.[0] ? JSON.stringify(s.screenText[0].slice(0, 40)) : undefined].filter((x): x is string => typeof x === 'string' && x !== '').join(' ');

/** A route's `routeWorks` key (rules route-promote.ts writes it, screen_act's replay reads it): its steps' parts. */
export const routeKeyOf = (steps: readonly StepRow[]): string => steps.map(part).join(' > ').slice(0, 240);

/** A step on the screen rig's own test pages (lab/screen-rig): a Testbox, or a page titled "Rig fixture: ...". */
const RIG_PAGE = /Testbox|^Rig fixture:/;

/**
 * The steps the owner's own chat may learn from: a session that ran any step on a rig test page is the rig's, and
 * all of it goes, so a route the rig taught never surfaces in the owner's chat when that app is in front.
 */
export function ownSteps(rows: readonly StepRow[]): StepRow[] {
  const rig = (row: StepRow) => RIG_PAGE.test(String(row.windowTitle ?? ''));
  const sessions = new Set(rows.filter((row) => rig(row) && row.session).map((row) => row.session));
  return rows.filter((row) => !rig(row) && !(row.session && sessions.has(row.session)));
}

/** The log reads `stepsOf` needs: the two signal queries of `@sundial/db` (the `gnomonDb` service's `queries`). */
export interface StepQueries {
  countSignalsInRange(from: string, to: string, types?: string[], contains?: string): Promise<number>;
  getSignalsInRange(from: string, to: string, limit?: number, types?: string[], offset?: number, contains?: string): Promise<{ data: Record<string, unknown>; capturedAt: string }[]>;
}

/**
 * The steps screen_act took in one app (`screen:step`), the last 30 days, the newest 200: what Gnomon learned there. A hidden
 * app's name is not in the log, so it has none. Every route the owner dropped there rides along as a `dropped` row, from
 * any day, so `routesOf` never offers it again.
 */
export async function stepsOf(queries: StepQueries, app: unknown, nowMs: number): Promise<StepRow[]> {
  const name = String(app ?? '').trim().toLowerCase();
  if (!name || name.startsWith('[')) return [];
  const [from, to, types, contains] = [new Date(nowMs - 30 * 86_400_000).toISOString(), new Date(nowMs + 5_000).toISOString(), ['screen:step'], `"processname":${JSON.stringify(name)}`];
  const total = await queries.countSignalsInRange(from, to, types, contains);
  const rows = await queries.getSignalsInRange(from, to, 200, types, Math.max(0, total - 200), contains);
  // ponytail: the first 500 drops of an app from all time; a drop is one owner's press, so a page is enough.
  const drops = await queries.getSignalsInRange(new Date(0).toISOString(), to, 500, ['screen:route-dropped'], 0, `"app":${JSON.stringify(name)}`);
  return [...rows.map((row) => ({ ...row.data, at: row.capturedAt })), ...drops.map((row) => ({ dropped: String(row.data.routeKey ?? ''), at: row.capturedAt }))];
}

