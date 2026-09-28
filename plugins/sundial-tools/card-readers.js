import { threadRows as threadRowsOf } from './threads.js';
import { INSTRUMENT_ROUTES } from '../sundial-theme/shell/cards.js';
import { lensProblem, runLens } from '../sundial-theme/shell/lens-core.js';

/**
 * What `gnomon_look` answers for each kind of card on the board.
 *
 * One reader per kind, keyed by `CARD_KINDS` — the record's own list — so the
 * question "can Gnomon read this card" has one answer in one place, and a card
 * kind that gains a renderer without gaining a reader fails a test instead of
 * failing silently in front of the owner. That silence is why this file exists:
 * the client drew a `dial` card nothing could read, while this chain answered
 * for a `today` id the client draws under five other names, and neither half
 * could see the other's list.
 *
 * A reader takes the card's key (the part after the colon, empty for a
 * singleton like `shelf`), the card's own record row, and the caller's extra
 * arguments. It returns what the card SHOWS — not the route's raw answer. When
 * the two differ, the card wins: a reading of rows the owner cannot see is
 * worse than no reading at all.
 */

/**
 * Whole minutes from an instant until `now`, or null when there is no instant.
 *
 * The same arithmetic `nowSnapshot` does for the Work card. The card says "for
 * 12 min"; a reader handing back a raw `openedAt` would make the model do this
 * sum itself, and it would do it against ITS idea of now.
 */
const minutesSince = (iso, now = Date.now()) => {
  const then = Date.parse(iso ?? '');
  return Number.isFinite(then) ? Math.max(0, Math.round((now - then) / 60_000)) : null;
};

/**
 * The instrument tabs, by the id after `inst:` — from the card catalog the
 * client's panels read too, so the two can no longer part.
 */
export { INSTRUMENT_ROUTES };

/** Cards whose whole content lives on the card itself — the client renders it, the record only holds its text. */
const fromCardText = (what) => (_key, card) => ({
  is: what,
  text: card?.text ?? null,
  by: card?.by ?? null,
  ...(card ? {} : { unavailable: 'No such card on the board.' }),
});

/**
 * @param route  reads one of the shell's own JSON routes, e.g. '/gnomon/day'
 * @param tool   runs one of Gnomon's read tools by name
 * @param state  the live KernelState, or null before boot
 */
export function createCardReaders({ route, tool, state }) {
  /** One moment, in the fields the ring and the "Just now" list are drawn from. */
  const momentRow = (m) => ({
    id: m.id,
    at: m.startTime,
    min: m.durationMin,
    active: m.activeMin,
    app: m.processName,
    project: m.projectId,
    focus: m.focusQuality,
    intent: m.intent ?? m.title,
  });

  /** The moments of one day, or just the ones under a given hour of it. */
  const momentsOf = (day, hour) =>
    (day.moments ?? [])
      .filter((m) => {
        if (hour === null) return (m.activeMin ?? m.durationMin ?? 0) >= 1;
        const at = new Date(m.startTime);
        const h = at.getHours() + at.getMinutes() / 60;
        return h <= hour + 0.5 && h + (m.durationMin ?? 0) / 60 >= hour - 0.5;
      })
      .map(momentRow);

  return {
    // The brief: one sentence about the day, and what Gnomon left that still
    // waits for a verdict. NOT the moment list — that is the dial beside it,
    // and answering with moments described a card the owner was not looking at.
    today: async () => {
      const [day, shelf] = await Promise.all([route('/gnomon/today'), route('/gnomon/shelf')]);
      return {
        date: day.date ?? null,
        observedMin: day.coverage?.trackedMin ?? null,
        projects: day.projects ?? [],
        meetings: day.meetings ?? 0,
        noticed: (day.noticed ?? []).length,
        // The brief lists only what has no verdict yet, five at a time.
        leftForYou: (shelf.items ?? []).filter((i) => i.verdict === null || i.verdict === undefined).slice(0, 5),
      };
    },

    // The face: the ring, the focus bar, and the two columns beside them. Three
    // routes, because the card reads three.
    dial: async (_key, card, args = {}) => {
      const hour = typeof args.hour === 'number' ? args.hour : null;
      const on = card?.filters?.date ? `?date=${card.filters.date}` : '';
      const [figure, day, today] = await Promise.all([route(`/gnomon/dial${on}`), route(`/gnomon/day${on}`), route(`/gnomon/today${on}`)]);
      return {
        date: day.date ?? today.date ?? null,
        hour,
        observedMin: today.coverage?.trackedMin ?? figure.observedMin ?? null,
        wallClockMin: today.coverage?.wallClockMin ?? figure.wallClockMin ?? null,
        focus: today.focus ?? null,
        projects: today.projects ?? [],
        noticed: today.noticed ?? [],
        moments: momentsOf(day, hour),
        files: today.hotFiles ?? [],
      };
    },

    // `/gnomon/shape` defaults to 14 days and the week strip takes that default;
    // asking for 8 here answered about a different window than the card draws.
    // What Gnomon noticed and said, and what it asked; set to a view, one half.
    voice: async (_key, card) => {
      const [unsaid, asks] = await Promise.all([route('/gnomon/unsaid'), route('/gnomon/asks')]);
      const all = { noticing: unsaid, asks };
      const view = card?.filters?.view;
      return view && all[view] ? { view, [view]: all[view] } : all;
    },
    // The fortnight's shape; set to a view, only that section.
    rhythm: async (_key, card) => {
      const [shape, rhythm, habits] = await Promise.all([route('/gnomon/shape'), route('/gnomon/rhythm'), route('/gnomon/habits')]);
      const all = { strata: shape, days: shape.days ?? [], arcs: rhythm, habits: { ...habits, commitments: undefined } };
      const view = card?.filters?.view;
      return view && all[view] !== undefined ? { view, [view]: all[view] } : all;
    },
    // Goals and every open commitment; set to a project, only its commitments.
    play: async (_key, card) => {
      const [goals, habits] = await Promise.all([route('/gnomon/goals'), route('/gnomon/habits')]);
      const project = card?.filters?.project ?? null;
      const open = habits.commitments?.open ?? [];
      return { ...(project ? { project } : {}), commitments: project ? open.filter((c) => c.project === project) : open, goals: goals.goals ?? [] };
    },
    // What the card shows: only what still waits, across everything that waits.
    shelf: async () => {
      const [shelf, untracked, assistant, drafts, asks] = await Promise.all([route('/gnomon/shelf'), route('/gnomon/attribution/proposals'), route('/gnomon/assistant/proposals'), route('/gnomon/drafts'), route('/gnomon/asks')]);
      const items = shelf.items ?? [];
      return {
        waiting: items.filter((i) => i.verdict === null || i.verdict === undefined),
        answered: items.filter((i) => i.verdict !== null && i.verdict !== undefined).length,
        untracked: untracked.proposals ?? [],
        suggestions: assistant.proposals ?? [],
        drafts: drafts.open ?? [],
        asks: (asks.asks ?? []).filter((a) => !a.outcome),
      };
    },
    // The Engine room reads its tab. Cost is the Ledger — no `?window=`: the
    // route follows the board's span, as the card does (a fixed 7 days here
    // once made the reading and the card disagree).
    engine: async (_key, card) => {
      const tab = card?.filters?.tab ?? 'cost';
      if (tab === 'cost') return { tab, ...(await route('/gnomon/ledger')) };
      if (!INSTRUMENT_ROUTES[tab]) return { error: `The Engine room has no "${tab}" tab.`, tabs: ['cost', ...Object.keys(INSTRUMENT_ROUTES)] };
      return { tab, ...(await route(INSTRUMENT_ROUTES[tab])) };
    },

    // Three tabs, so three readings. "Just now" was missing entirely.

    kanban: async () => {
      const [goals, habits, asks, shelf, untracked, assistant] = await Promise.all([
        route('/gnomon/goals'),
        route('/gnomon/habits'),
        route('/gnomon/asks'),
        route('/gnomon/shelf'),
        route('/gnomon/attribution/proposals'),
        route('/gnomon/assistant/proposals'),
      ]);
      return {
        goals: goals.goals,
        threads: habits.commitments?.open,
        asks: (asks.asks ?? []).filter((a) => !a.outcome),
        shelf: (shelf.items ?? []).map((s) => ({ title: s.title, verdict: s.verdict })),
        // The card has a proposals column; this had no answer for it.
        proposals: { untracked, assistant },
      };
    },

    threads: async () => threadRowsOf(await route('/gnomon/api/sessions')),
    // The conversation card shows the thread the model is already in.
    chat: async () => ({ note: 'This card is the conversation you are speaking in; its words are your own thread.' }),
    entity: async (key) => ({ matches: await tool('gnomon_entity_history', { name: key }) }),
    moment: async (key) => ({ moment: await tool('gnomon_moment_detail', { momentId: key }) }),

    // The roster the Explore card opens on: what Gnomon holds beliefs about, by
    // kind. The search box itself has no state to read.
    explore: async (_key, card) => {
      // Set to a query, the card opens on its search results: read those.
      const query = card?.filters?.query;
      if (query) return { query, hits: await tool('gnomon_semantic_search', { query }) };
      // Set to a day or a meeting, the card opens on Said: read what it shows.
      const { date, meeting } = card?.filters ?? {};
      if (date || meeting) {
        const on = date ?? new Date().toLocaleDateString('sv');
        const meetings = (await route(`/gnomon/meetings?date=${on}`)).meetings ?? [];
        const m = meeting ? meetings.find((x) => x.title.toLowerCase().includes(String(meeting).toLowerCase())) ?? null : null;
        const hhmm = (iso) => new Date(iso).toTimeString().slice(0, 5);
        const args = { date: on, signalType: 'audio:transcript', limit: 60, ...(m ? { from: hhmm(m.start), to: hhmm(m.end) } : {}) };
        const heard = await tool('gnomon_signals', args);
        return {
          said: { date: on, meeting: m ? { title: m.title, from: hhmm(m.start), to: hhmm(m.end) } : meeting ? { unavailable: `No meeting called "${meeting}" on ${on}.` } : null },
          meetings: meetings.map((x) => ({ title: x.title, from: hhmm(x.start), to: hhmm(x.end) })),
          total: heard.total ?? 0,
          utterances: (heard.signals ?? []).map((s) => ({ at: hhmm(s.data?.utteranceStartedAt ?? s.capturedAt), text: s.data?.spokenText, language: s.data?.language, ...(s.data?.channel === 'system' ? { from: 'the call' } : {}) })),
          ...(heard.nextOffset ? { more: `${heard.total - heard.nextOffset} more — call gnomon_signals with ${JSON.stringify({ ...args, offset: heard.nextOffset })}` } : {}),
        };
      }
      const [memory, people, lenses] = await Promise.all([route('/gnomon/memory'), route('/gnomon/people'), route('/gnomon/lenses')]);
      const kind = card?.filters?.kind;
      const entities = (memory.entities ?? []).filter((e) => !kind || e.kind === kind);
      const kinds = {};
      for (const e of entities) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
      return {
        counts: kinds,
        entities: entities
          .slice()
          .sort((a, b) => (b.factCount ?? 0) - (a.factCount ?? 0))
          .slice(0, 40)
          .map((e) => ({ name: e.canonicalName ?? e.id, kind: e.kind, facts: e.factCount ?? 0 })),
        people: { people: (people.people ?? []).slice(0, 20), unnamed: (people.unnamed ?? []).length, notPeople: (people.notPeople ?? []).length },
        lenses: (lenses.lenses ?? []).map((l) => l.title ?? l.id),
      };
    },

    // The work card shows the bench, which is state, not a route.
    //
    // The slices below are `nowSnapshot`'s, not this file's choice, and the
    // reason is the whole point of this module: `recent` is a RING, written
    // oldest to newest. Reading the first five of it hands back the five oldest
    // jobs — the ones the card is not showing — while the card takes the last
    // eight and reverses them. A reader that "worked" would have described
    // yesterday's failures as what is on screen.
    work: async (_key, card) => {
      const bench = state()?.workbench ?? null;
      if (bench === null) return { unavailable: 'The bench has not been read yet.' };
      const open = bench.open ?? null;
      const all = {
        wakeups: state()?.wakeups?.open ?? [],
        open:
          open === null
            ? null
            : { jobId: open.id, kind: open.kind, subject: open.subject, reason: open.reason ?? null, min: minutesSince(open.openedAt) },
        waiting: (bench.queue ?? []).length,
        today: bench.countToday ?? 0,
        queue: (bench.queue ?? []).slice(0, 5).map((job) => ({ id: job.id, kind: job.kind, subject: job.subject, reason: job.reason ?? null })),
        recent: (bench.recent ?? [])
          .slice(-8)
          .reverse()
          .map((job) => ({
            id: job.id,
            kind: job.kind,
            subject: job.subject,
            title: job.title ?? null,
            outcome: job.outcome,
            closedAt: job.closedAt,
            min: minutesSince(job.openedAt, Date.parse(job.closedAt ?? '') || Date.now()),
          })),
      };
      // Set to a view, that part (the card marks its seat); set to a job, that job.
      const { view, job } = card?.filters ?? {};
      if (job) return { job, row: [...(bench.queue ?? []), ...(bench.recent ?? [])].find((j) => j.id === job) ?? { unavailable: `No job ${job} on the bench.` } };
      const parts = { now: { open: all.open, waiting: all.waiting, today: all.today, queue: all.queue }, history: { recent: all.recent }, wakeups: { wakeups: all.wakeups }, can: { note: 'The card lists what Gnomon can do, grouped with example questions.' } };
      return view && parts[view] ? { view, ...parts[view] } : all;
    },

    // What the owner set, as the Settings card shows it.
    settings: async () => ({ settings: state()?.settings ?? null }),

    // Four kinds the client renders from the card's own text and nothing else.
    // Saying so is the honest answer; inventing a route for them would be a
    // second source of truth for something the record already holds.
    note: fromCardText('a note the owner or Gnomon wrote'),
    web: (key, card) => ({ is: 'a web page on the board', url: key, text: card?.text ?? null }),
    // A page Gnomon is working on: its text is the last step; read the page itself with web_page read.
    browser: (key, card) => ({ is: 'a page open in Gnomon\'s browser', page: key, lastStep: card?.text ?? null, read: 'web_page action read with this page id' }),
    // A lens is read by RUNNING it, as the card does: the spec alone told the
    // agent nothing about the bars it then pointed at.
    lens: async (_key, card) => {
      let spec = null;
      try {
        spec = JSON.parse(card?.text ?? '');
      } catch {
        spec = null;
      }
      const problem = lensProblem(spec, (name) => typeof name === 'string' && name.startsWith('gnomon_'));
      if (problem) return { is: 'a lens with no readable spec — the card shows nothing', problem };
      return { is: 'a lens', title: spec.title, rows: runLens(spec, await tool(spec.source.tool, spec.source.args ?? {})) };
    },
    // Drawn answers carry what they show as their text, written by the client
    // when it lifts them onto the board.
    surface: fromCardText('a surface Gnomon drew in the conversation and stood on the board; its text is what it shows'),
    figure: fromCardText('a figure Gnomon drew; its text is what it shows'),
  };
}
