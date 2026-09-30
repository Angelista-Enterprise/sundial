// The board: the owner's cards, scenes, lenses and span, as the record holds them.

/** KernelState's Board fields; `KernelState` extends this. */
export interface BoardSlices {
  /**
   * The board: the owner's space, and Gnomon's. By `boardTrack` from
   * `board:*` — placed, moved, grouped, removed, saved as a scene and loaded
   * again — written by the owner's hands through the client and by Gnomon
   * through `gnomon_board`. Both go through the log, so the space replays.
   */
  board: {
    cards: Record<string, BoardCard>;
    /** Named arrangements of the unpinned cards, saved to be loaded later. */
    scenes: Record<string, { cards: BoardCard[]; savedAt: string }>;
    /**
     * Every lens ever composed, by card id — the shelf that outlives the card.
     *
     * A lens is a QUESTION someone worked out how to ask: which read tool,
     * which filters, which shape. The card carrying it was disposable from the
     * first day (remove, clear, load a scene all take it), and the question
     * went with it, so the same lens had to be invented again from prose. This
     * keeps the spec when the card goes, which is the only part worth keeping —
     * the rows were always re-read anyway.
     *
     * Kept forever and never pruned: a spec is a few hundred bytes, and a shelf
     * that forgets is a shelf nobody trusts to look on.
     */
    lenses: Record<string, { title: string; spec: string; at: string }>;
    /**
     * The last size the owner gave each card, by card id and by kind — kept
     * when the card goes, so a card opened again comes back at the owner's
     * width instead of the default. Optional: snapshots from before it lack it.
     */
    sizes?: Record<string, [number, number]>;
    /** What Gnomon last asked the owner's view to fit, with a line about it; the client animates there. */
    /** `mark`: words to light INSIDE those cards (a row, a day, a name) — the client finds them; the record only carries them. */
    focus: { ids: string[]; text: string | null; mark?: string | null; at: string } | null;
    /**
     * A notice: one line that arrives as a thin row at the top of the board and
     * leaves again. Gnomon speaking about NOW — not about any card, which is
     * what separates it from `focus`'s caption.
     *
     * `ms` is how long it stands; `0` means it stands until the owner answers
     * or dismisses it, which is what a question needs. `actions` are the
     * owner's replies: pressing one says `say` to Gnomon in the owner's own
     * voice, so an answer is an ordinary turn and not a second channel.
     */
    notice: { text: string; kind: 'say' | 'ask'; ms: number; actions: { label: string; say: string }[]; at: string } | null;
    /**
     * A walkthrough: steps the owner pages through at their own pace, each
     * fitting some cards and saying one thing about them. How Gnomon gives a
     * play-by-play instead of a wall of prose.
     */
    walk: { steps: { ids: string[]; text: string; weight: 'light' | 'heavy' }[]; cursor: number; autoAdvanceMs: number | null; at: string } | null;
    /** The plan as the owner last edited it (skip, reorder, add); the model's next todo_write replaces it. */
    plan: { steps: { content: string; status: 'pending' | 'in_progress' | 'completed' | 'skipped' }[]; at: string } | null;
    /**
     * WHEN the board is looking at, for every card at once.
     *
     * One span, not one per card. Before this there were three unrelated
     * mechanisms — a day ruler that moved only the four day-bound parts, a
     * private `7d`/`30d` tab strip inside the ledger that nothing else could
     * read, and a fourteen-day span hardcoded into two copies of a route
     * table — so "show me last week" had three different answers depending on
     * which card you asked. The owner's rule from the trace card: one time
     * control for all cards, decided before anything is built on it.
     *
     * It lives in the RECORD rather than in the client because Gnomon reads
     * cards too: a reader answering about a card the owner has wound back to
     * Tuesday must answer about Tuesday. Both hands move the same control.
     *
     * `from` and `to` are inclusive owner-local dates, `YYYY-MM-DD`. A single
     * day is `from === to`. `label` is the preset that produced it, kept so the
     * chip can show which one is lit and so a rolling span can be recomputed at
     * the day boundary rather than going stale at midnight. `null` is "today",
     * the default a fresh board wakes up in.
     */
    span: { from: string; to: string; label: string; at: string } | null;
    /** The last eight changes to the space, oldest first — what the owner (or Gnomon) just did. */
    /** The last few changes: what, to what, by whom — and `because`, the one line Gnomon gave for it, shown to the owner as a caption. */
    recent: { type: string; id: string | null; by: 'owner' | 'gnomon'; at: string; because?: string | null }[];
    /**
     * Sections: named regions of the space, each anchored by one pinned card.
     * A card placed `near` a section lands inside it. Drawn behind the cards.
     */
    sections: Record<string, { label: string; x: number; y: number; w: number; h: number; anchor: string | null; at: string }>;
    updatedAt: string | null;
  };
}

/** One file the owner keeps coming back to today. See `KernelState.files`. */
/**
 * One card on the board — a pane the owner (or Gnomon) placed in the space.
 * `id` is the pane id the client resolves (`today`, `session`, `inst:memory`,
 * `entity:<name>`, `moment:<id>`, `note:<key>` …). Coordinates are world units;
 * `z` is depth (0 is the front, negative recedes). A `pinned` card is permanent:
 * `board:remove` and `board:load` leave it standing.
 */
export interface BoardCard {
  id: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  pinned: boolean;
  /** A note's text, or a label the placer gave the card. */
  text: string | null;
  /**
   * The owner's own note ON this card — what to fix, what renders wrong, what
   * it is for. Distinct from `text`, which is the card's CONTENT (a note's
   * words, a lens's spec): this is a remark about the surface itself, and
   * Gnomon reads it in the board context so "fix the thing I flagged" resolves.
   */
  comment: string | null;
  /**
   * What this card is set to — a date, a tab, a query — from the keys its
   * catalog entry (`plugins/sundial-theme/shell/cards.js`) declares. The card
   * applies them and shows them as chips; `gnomon_look` reads with them.
   */
  filters?: Record<string, string> | null;
  by: 'owner' | 'gnomon';
  at: string;
}

/**
 * Where a Figure says it can be opened in full — the Study altitude whose page
 * draws the same data with the same marks. Shared with `show_view`, which
 * navigates to exactly these.
 */
export type ViewAltitude = 'today' | 'trend' | 'memory' | 'trust' | 'unsaid' | 'index';

/**
 * A typed visual fragment an answer carries alongside its prose — the
 * assistant drawing with the app's own hands.
 *
 * Three rules make this different from "the model returns a chart", and all
 * three are why the union is closed:
 *
 * - **Composed daemon-side, always.** Every variant below is built from the
 *   same queries the resident Study pages read. A model chooses WHICH figure to
 *   compose and over what window; it never supplies the numbers. There is no
 *   variant carrying model-authored data, and adding one would undo the point.
 * - **Rendered by the components that already exist.** The client maps each
 *   variant onto the page component that draws that shape, so an answer's chart
 *   and a page's chart cannot disagree — they are the same drawing code over
 *   the same numbers.
 * - **Captioned with its own scope.** `caption` states the window and the
 *   evidence count in words, composed here, because it is a claim about how
 *   much was seen and claims are computed daemon-side.
 *
 * An unknown `kind` must be ignored by a client rather than failing the answer:
 * a daemon that learns a seventh figure has to reach an older app as prose with
 * one fragment it quietly skips.
 */
export type Figure =
  | {
      kind: 'dial-slice';
      caption: string;
      openIn: ViewAltitude;
      /** `YYYY-MM-DD`, the owner's local day. */
      date: string;
      /** Hour bounds of the drawn axis, e.g. 6 → 24. */
      fromHour: number;
      toHour: number;
      /** Minutes a sensor actually accounted for, against the wall clock of the same window. The pair IS the unobserved hatch. */
      observedMin: number;
      wallClockMin: number;
      curve: { hour: number; score: number }[];
      meetings: { startHour: number; endHour: number }[];
      deepBlocks: { startHour: number; endHour: number }[];
      /** Where the gnomon stands, or null for a day that is not today. */
      nowHour: number | null;
    }
  | {
      kind: 'trend-slice';
      caption: string;
      openIn: ViewAltitude;
      /** `observed: false` is a day the sensors saw nothing — rendered as absent, never as a zero. */
      days: { date: string; minutes: number; observed: boolean }[];
    }
  | {
      kind: 'graph-neighborhood';
      caption: string;
      openIn: ViewAltitude;
      center: { id: string; name: string; kind: string };
      /** Direct edges only. A neighbourhood that fans out two hops stops being readable at this size. */
      edges: { toName: string; predicate: string; provenance: string }[];
    }
  | {
      kind: 'fact-chain';
      caption: string;
      openIn: ViewAltitude;
      entityName: string;
      predicate: string;
      /** Oldest first, so the chain reads the way it was built. `supersededAt` set marks a link that stopped being believed. */
      links: { at: string; object: string; confidence: number; provenance: string; supersededAt: string | null }[];
    }
  | {
      kind: 'commitment-thread';
      caption: string;
      openIn: ViewAltitude;
      name: string;
      branch: string | null;
      openedAt: string | null;
      /** Distinct days returned to — what separates a real thread from one long afternoon. */
      activeDays: number;
      touches: number;
    }
  | {
      kind: 'census';
      caption: string;
      openIn: ViewAltitude;
      /** `total: null` is a count with no denominator — shown as a bare count, never as a share it cannot support. */
      rows: { label: string; count: number; total: number | null }[];
    };
