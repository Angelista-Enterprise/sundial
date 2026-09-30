// Who the owner meets and owes: meetings, the people, the owner, the calendar ahead, commitments and goals.

/** KernelState's People fields; `KernelState` extends this. */
export interface PeopleSlices {
  /**
   * The work loop (2026-09-04): jobs Gnomon does on its own while the owner is
   * away, whose results land on the shelf (knowledge_entries of kind `shelf`)
   * for the owner to Keep or dismiss. One job open at a time, like a research
   * goal; a bounded number a day; picked by `workbench` from state alone.
   */
  /**
   * Meetings with other people the owner has been in, kept by `meetingFollowup`
   * so the question "how did it go?" can be asked once, shortly after the end.
   * Keyed `${title}|${start}`; pruned after two days.
   */
  meetings: {
    /**
     * `listened`: ambient hearing was awake at some point inside the meeting.
     * `heard`: utterances transcribed inside it. Together they say the owner was
     * not in the room — see `meetingFollowup`.
     */
    seen: Record<
      string,
      {
        title: string;
        start: string;
        end: string;
        attendees: string[];
        askedAt: string | null;
        listened?: boolean;
        /** Utterances the MICROPHONE heard inside it: the owner being in the room. */
        heard?: number;
        /** UC1: utterances heard on either stream — whether there is anything for the promise pass to read. */
        voices?: number;
        /** UC1: when the meeting's promise pass was asked for. */
        extractAt?: string;
        /** UC1: what the pass found — the promise ids and one line each, for the question at the end (X3). Absent until it answers. */
        promised?: { ids: string[]; lines: string[] };
      }
    >;
  };
  /**
   * Who the hashed people are. `sanitizeAtIngest` turns an attendee the calendar
   * has no display name for into a stable `person-<hash>` alias; 7 of 16
   * colleagues on the live record were only ever that. `peopleAsk` asks the
   * owner once per alias and keeps the answer here, so a meeting question can
   * say "with Alex" instead of "with person-c205ca11f2". The same answer goes
   * into core memory as a `knownAs` fact; this map is the fast lookup rules use.
   */
  people: {
    /** alias → when it was last asked about, so an unanswered alias is not asked every meeting. Fold state with no other home. */
    asked: Record<string, string>;
    /**
     * When the last "who is this attendee" question was opened, whatever alias
     * it was about — the CLASS-level clock, beside `asked`'s per-alias one.
     *
     * `asked` alone was not a limit. It mutes one alias for a fortnight, and a
     * single meeting carries several hashed attendees, so the rule simply walked
     * to the next hash as soon as the previous question closed: seven questions
     * on 2026-09-09, three of them in three consecutive minutes.
     */
    lastAskedAt?: string;
    /**
     * When the whole question class may be asked again, set when the owner
     * answers one of these with something that is not a name.
     *
     * A refusal is about the CLASS, not the hash. The owner said "I dont know,
     * we need to handle this in code" four times on 2026-09-09 and was asked
     * again each time, because a non-name answer only ever marked that one
     * alias as asked. There was no way for them to say "stop".
     */
    mutedUntil?: string;
    /**
     * When `identity-resolve` last swept the machine's own address sources for
     * these aliases. A sweep reads git history in every known project root, so
     * it is a daily job, not a per-tick one.
     */
    resolvedAt?: string;
  };
  /**
   * The question Gnomon is currently waiting on an answer to, if any.
   *
   * The inverse of `state.ask`, which records questions the OWNER asked. This is
   * the direction that never existed: Gnomon could observe, infer and speak, but
   * it could not ask and then know whether it had been answered — so anything
   * only the owner knows stayed unknowable, however cheap the question was.
   *
   * ONE open question at a time, deliberately, and for the same reason
   * `solicitFeedback` allows one solicitation: a queue of pending questions is
   * an interrogation, and an assistant that has asked three things and been
   * answered on one cannot tell which. The open question expires after
   * `OWNER_ASK_TTL_MS` — silence is not a `no`, it just unblocks the next
   * question, and it is recorded as an `expired` outcome because a question the
   * owner ignored is evidence about the asking.
   */
  /**
   * J2.7 — what the fan-out said each open goal got. `goalProgressTrack`
   * folds `goal:progress` (emitted by `applyMomentJudgement` when a goal slot
   * clears its threshold) into a bounded list per goal entity id, and the
   * Monday `goalCheckin` cites the week's sessions from it instead of guessing.
   * Fold-derived and snapshot-safe: an older snapshot lacks it and gets `{}`.
   */
  /**
   * J2.1 / J3.1 — the owner, as the machine believes them to be right now.
   *
   * `perception` is the raw-rate input the fold keeps for the `perceive`
   * question (law 7: numbers, never a rule's label): the last input windows
   * and nothing else — window switches come from `lifeEvent.recentSwitches`.
   * `focus` / `stuck` / `interruptible` are Beta beliefs the judge's
   * likelihoods move by w = 0.2 a tick and that decay toward the prior, so one
   * odd reading cannot flip them and a real change shows within three ticks.
   * `selfReports` are the owner's own "flow / meh / stuck" taps beside the
   * belief at that instant; `brier` is the filter scored against them — the
   * gate (docs/jarvis/02, J2.1) that decides whether these beliefs may ever
   * price an interruption. `energy` is the phone's night (J3.1).
   */
  owner: {
    perception: { input: { ts: string; windowMs: number; keys: number; events: number }[]; lastJudgedAt: string | null };
    focus: BetaBelief;
    stuck: BetaBelief;
    interruptible: BetaBelief;
    selfReports: { ts: string; tap: 'flow' | 'meh' | 'stuck'; pFlow: number; pStuck: number; brier: number }[];
    brier: { n: number; sum: number; firstAt: string | null };
    energy: { sleepHours: number | null; sleptFrom: string | null; sleptTo: string | null; restingHr: number | null; steps: number | null; updatedAt: string | null };
  };
  /**
   * P0-3 (docs/design/08-endogenous-life.md §11.2) — the near-future calendar,
   * refreshed by `scheduleTrack` from each `calendar:upcoming` emit (that signal
   * was imported but consumed by NO rule before this). Bounded to the next few
   * events, sorted by start. The forward model's most direct raw input; also
   * available to read paths now. `updatedAt` is the last emit ts (staleness).
   */
  schedule: {
    upcoming: UpcomingEvent[];
    updatedAt: string | null;
    /**
     * The meeting in progress, as of the last calendar poll, and null between
     * meetings. Lives HERE rather than being read off `state.moment.rollup`:
     * `momentClose` folds before `windowTrack`, so on the very window change
     * that enters a call the moment has just been re-opened with a blank
     * `meetingTitle`, and a `meetingContains` rule looking there matched
     * nothing for the whole call. The schedule slice survives moment
     * boundaries, which is what a rule needs.
     */
    /** `others`: attendees who are not the owner or a room; a block with 0 is not a call. Missing on an older fold. */
    active: { title: string; start: string; end: string; others?: number } | null;
  };
  /**
   * The commitment ledger — open threads of work, and the ones that went quiet.
   *
   * See `Commitment`. Both lists are bounded the same way
   * `predictions.recentResolved` is: this slice rides in every snapshot, and an
   * unbounded list of every branch ever touched would grow the snapshot without
   * bound for the sake of rows the `commitments` TABLE already holds durably.
   *
   * Deliberately shipped WITHOUT a forecaster. The obvious target — "will this
   * thread be picked up again after today" — was measured first, per
   * `guides/measure-forecast-skill`, and the reference corpus offers 17 task
   * branches of which 5 span more than one day. The one available conditioning
   * feature (does the name carry a ticket id) splits that 4-of-9 against
   * 1-of-8, two-sided Fisher p = 0.29, and points the opposite way to intuition.
   * That is noise, and a prior fitted to it would be the `project-continuity`
   * mistake with a new name.
   */
  commitments: {
    open: Commitment[];
    recentClosed: ClosedCommitment[];
    /**
     * UC1: open promises, kept apart from the branch threads with a cap of
     * their own, so twenty branches can never evict one (the shared cap of 20
     * could). Written by `promiseTrack` only.
     */
    promises: Commitment[];
    /** UC1: the question about promises the owner has not answered yet, so the answer can be read after `ownerAsk` closes it. */
    promiseAsk: { askId: string; kind: 'meeting' | 'kept'; ids: string[]; attendees: string[]; meeting: { title: string; start: string } | null } | null;
  };
  goals: {
    progress: Record<string, GoalProgressEntry[]>;
    /** J5.3 — this week's plan per ACTIVE goal, its steps and their grades. Snapshot-safe (`?? {}`). */
    pursuit?: Record<string, GoalPursuit>;
  };
}

/**
 * P0-3 (docs/design/08-endogenous-life.md §11.2) — one near-future calendar
 * event, folded into `state.schedule` by `scheduleTrack`. The most directly
 * predictive raw signal for the forward model (Phase 2b): "what's coming next".
 * Times are ISO; `attendees` are already alias-sanitized at ingest.
 */
export interface UpcomingEvent {
  title: string;
  start: string;
  end: string;
  attendees: string[];
  isAllDay: boolean;
  /** Lane B: the calendar marks it as one of a series. Absent when it does not, and on older snapshots. */
  recurring?: boolean;
}

/**
 * One piece of work spanning hours to weeks — the memory tier
 * `decisions/assistant-as-an-event-source` named as missing.
 *
 * Working memory covers the present moment, episodic memory roughly one app
 * dwell, reflective memory a calendar day, and core memory durable facts.
 * Nothing covered "the thing I was doing last Tuesday and mean to finish",
 * which is the unit a person actually plans in. `entityExtract` already mints a
 * `task` ENTITY from a git branch (C13); this is the deferred other half — the
 * live thread with a history, rather than a name in the knowledge graph.
 *
 * Identity is the task name `taskIdentity` derives from the branch, so the two
 * halves agree on what a piece of work is called and a reader can cross the
 * ledger and the graph without a join table.
 */
export interface Commitment {
  /** `commitment:<slug>` — derived from the name, so re-seeing a branch finds the same thread rather than opening a second one. */
  id: string;
  /** `BOX-508`, or `redesign-and-tablet` — whatever `taskIdentity` made of the branch. */
  name: string;
  /**
   * Where it came from: the git branch a moment carried; (J4.4) a promise heard
   * aloud in one moment; (UC1) a promise found in a whole meeting (`meeting`),
   * typed to Gnomon (`chat`), told in answer to a question (`owner`), a
   * reminder the owner made (`reminder`), or a mail's subject (`mail`).
   */
  source: 'git-branch' | 'speech' | 'meeting' | 'chat' | 'owner' | 'reminder' | 'mail';
  /** UC1: what a promise is, beyond its words. Absent on a branch thread. */
  promise?: PromiseTerms;
  /** J4.4: the moment the promise was heard in, and the noul it cleared. Absent on a branch thread. */
  heardIn?: { momentId: string; p: number };
  /** The raw branch, kept because the name is lossy and a person recognises the branch. */
  branch: string;
  projectId: string | null;
  projectName: string | null;
  openedAt: string;
  lastTouchedAt: string;
  /**
   * When the owner was told this thread had gone quiet for a few days — the
   * `commitment-fading` notice, which fires ONCE per thread. Absent until then.
   * A touch after it clears the marker, so a thread picked up and dropped again
   * can be mentioned again.
   */
  fadingNoticedAt?: string;
  /** How many moments carried this branch. */
  touches: number;
  /**
   * State of the working tree the last time this thread was touched.
   *
   * The discriminator between a thread ABANDONED and a thread FINISHED, and the only
   * thing that tells them apart from the log. Both look identical to a staleness sweep:
   * work, then silence.
   *
   * The synthetic corpus plants both shapes as twins and every gate variant fired on the
   * merged one until this existed — announcing completed work as abandoned, which is the
   * single most annoying thing this producer could do.
   *
   * `unpushed` is the high-water mark of `git:status`'s `ahead` (`rollup.unpushedCommits`,
   * a field that was captured on all 15,120 status emissions and read by nothing until
   * now). `merged` records a `git:pr-status` life-event on the thread.
   */
  lastTouchUnpushed: number;
  merged: boolean;
  /** The PR the branch carries, as last seen. `undefined` on threads from before this field; `null` when no PR has been seen. */
  pr?: { number: number; state: string; reviewState: string | null } | null;
  /**
   * LOCAL days this thread was seen on, bounded.
   *
   * A day count rather than elapsed time, because "spanning hours to weeks" is
   * about how many times you came back, not how long the clock ran. A branch
   * opened Friday and touched Monday spans two days and three calendar days,
   * and the two-day reading is the true one.
   */
  activeDays: string[];
}

/**
 * UC1: one piece of evidence about a promise. `strong` evidence closes it as
 * kept; weak evidence is cited and closes nothing (a mail to Mira about
 * something else).
 */
export interface PromiseEvidence {
  kind: 'mail' | 'mail-weak' | 'commit' | 'branch' | 'pr' | 'file' | 'tab' | 'caption' | 'reply' | 'reminder' | 'judge';
  at: string;
  strong: boolean;
  /** What was seen, short, already sanitized: "mail to Mira Bakker: The draft". */
  text: string;
}

/**
 * UC1: the terms of a promise. Parsed once, when it opens; the deliverable's
 * key nouns (`keys`) are what every later piece of evidence is matched on.
 */
export interface PromiseTerms {
  /** `owner`: the owner promised. `request`: someone asked the owner, who agreed. `awaiting`: someone promised the owner, or the owner asked them. */
  direction: 'owner' | 'request' | 'awaiting';
  /** The other side, as the log holds people: a name or `person-<hash>`. Null: nobody in particular. */
  counterparty: string | null;
  /** The thing promised, a few words: "the draft". */
  deliverable: string;
  /** The deliverable's key nouns, normalized: `["draft"]`. Empty when it named nothing matchable. */
  keys: string[];
  /** The words it was made in, clipped; already sanitized at ingest. */
  quote: string;
  /** When it is due, or null until known. */
  due: string | null;
  /** `explicit`: it was said. `next-meeting` (UC1-X1): the next event the counterparty attends. `default`: three working days. */
  dueKind: 'explicit' | 'next-meeting' | 'default';
  /** The meeting it was made in. */
  heardAt?: { title: string; start: string } | null;
  /** UC1-X1: the next calendar event the counterparty attends, once the calendar shows one. */
  nextMeeting?: { title: string; start: string } | null;
  /** The three-working-day default, kept so a meeting deadline that leaves the calendar can fall back to it. */
  defaultDue?: string;
  /** Newest last, bounded. */
  evidence: PromiseEvidence[];
  /** The last mail the owner sent the counterparty, whatever it was about — the "no mail to Mira since" line. */
  lastMailTo?: { at: string; subject: string } | null;
  /** The owner said it stands (X3), or it was their own words. False: found by a model, not yet confirmed. */
  confirmed: boolean;
  /** When the fading notice was said, and for which deadline — once per deadline. */
  spokeFor?: string;
  /** When the owner was asked whether it was kept (U1-F32). */
  askedAt?: string;
  /** Earlier dues, oldest first, when it was moved (U1-F27). */
  moved?: string[];
  /** The Apple Reminders item mirroring it (U1-F38). */
  reminderId?: string;
}

/** A thread that went quiet, with the reason it was closed. */
export interface ClosedCommitment extends Commitment {
  closedAt: string;
  /**
   * `went-quiet`: the staleness sweep. `seen-done` (J4.4): a later moment's
   * fan-out said the promise was kept AND the moment carried non-text evidence
   * (a commit, commands, a meeting). `owner`: the owner's tap. UC1: `kept` on
   * evidence or the owner's word, `broken` and `dropped` on the owner's word.
   */
  closedBecause: 'went-quiet' | 'seen-done' | 'owner' | 'kept' | 'broken' | 'dropped';
}

/** One step of a goal's weekly plan (J5.3). Internal steps run as jobs; outward ones are proposed to the owner and never run. */
export interface GoalPlanStep {
  id: string;
  text: string;
  outward: boolean;
  status: 'todo' | 'running' | 'done' | 'failed' | 'asked';
  /** `grade-step`'s noul on the shelved result. */
  grade?: number;
  resultTitle?: string;
}

export interface GoalPursuit {
  goalName: string;
  plannedAt: string;
  steps: GoalPlanStep[];
  reportedAt: string | null;
}

/** A Beta(α, β) belief; its mean is the probability. */
export interface BetaBelief {
  alpha: number;
  beta: number;
}

/** One moment the judge said advanced a goal (`goal:progress`). */
export interface GoalProgressEntry {
  momentId: string;
  ts: string;
  /** The noul the slot was decided on. */
  p: number;
  minutes: number;
}
