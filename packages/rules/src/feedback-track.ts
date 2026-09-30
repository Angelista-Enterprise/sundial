import { VERDICTS } from '@sundial/helpers/vocab.js';
import type { FeedbackEntry, FeedbackVerdict, KernelState, Rule } from '@sundial/kernel/types.js';
import { gradeRows, rememberVerdict } from './judgement-track.js';
import { DEFAULT_GATE_POLICY } from './notice-gate.js';
import { askClass, quietClass } from './owner-ask.js';
import { MAX_ACCUMULATED } from './surprise-drive.js';

const MAX_RECENT_FEEDBACK = 50;

/**
 * Evidence weight of the owner saying a fact is useful.
 *
 * One, matching `contradictionCheck`'s `REINFORCE_DELTA` for an ordinary
 * re-observation. Not more: the fact is already believed, so this is corroboration
 * rather than discovery, and a bigger number would let a single click outweigh a
 * week of sensor agreement.
 */
const OWNER_CONFIRMATION_DELTA = 1;
const VALID_VERDICTS = new Set<FeedbackVerdict>(VERDICTS);
/**
 * Exported so a writer of verdicts (once the `gnomon feedback` CLI; today
 * `/gnomon/api/feedback` keeps its own list) can pin its accepted list against the
 * reducer's, which is the authority. The two drifted once — the rule gained
 * `ask_thread` and `notice` and the CLI kept refusing them — and the drift was
 * invisible because each side was self-consistent.
 */
export const VALID_ARTIFACT_KINDS = new Set<FeedbackEntry['artifactKind']>(['knowledge_entry', 'moment', 'entity_fact', 'ask_thread', 'notice', 'owner_ask']);

/**
 * A `wrong` verdict is genuine prediction error — Gnomon asserted something
 * the owner says is false — so it feeds the same master surprise scalar
 * anomalies and resolved forecasts do (D6). Deliberately a fixed
 * contribution rather than a log-loss: there was no `priorProb` attached to
 * an insight or a fact, so there is no probability to take −ln of. Sized in
 * the same range a missed prediction lands in (~1.6 nats) so one correction
 * counts for about as much as one surprising observation.
 *
 * `useful` and `not-now` add nothing. `useful` is confirmation, which is the
 * absence of error, not negative error. `not-now` is explicitly a judgement
 * about TIMING, not correctness — treating it as error would teach the drive
 * that a true statement was false, the exact conflation this verdict exists
 * to keep apart.
 */
const WRONG_VERDICT_SURPRISE = 1.6;

interface FeedbackVerdictPayload {
  artifactKind?: string;
  artifactId?: string;
  verdict?: string;
  solicited?: boolean;
  note?: string | null;
}

/**
 * The feedback loop (decisions/assistant-as-an-event-source) — folds the owner's verdict on one
 * artifact into `state.feedback`. Reacts to `feedback:verdict`, an ordinary
 * event like any sensor's; the web client's `/gnomon/api/feedback` route
 * ingests it, so the return path needs no new
 * transport, table, or package — which is the whole argument for this being
 * the smallest change that closes the gap.
 *
 * Validates its payload and drops anything malformed rather than folding a
 * junk verdict into the tally. This is a boundary rule in the sense that
 * matters: unlike a sensor event the daemon itself constructed, the payload
 * here originates from a user-supplied CLI argument.
 *
 * A `wrong` verdict on an `entity_fact` now RETRACTS it, which this rule
 * previously and deliberately did not do. The reason it was deferred was real:
 * supersession replaces a fact with a different value, retraction has no
 * replacement to offer, and there was no effect variant that could say "this is
 * false" — inventing one meant first deciding how a retracted-but-not-superseded
 * fact reads back out of the bitemporal timeline.
 *
 * That decision is now made, and it needed no migration and no new column.
 * `validTo` set with `supersededBy` left NULL is a state the schema can already
 * represent and no other writer ever produces, so it is unambiguous. Every
 * "what do I currently believe" read filters `valid_to IS NULL` and therefore
 * drops the fact immediately; every history read keeps the row, with the null
 * `supersededBy` marking it retracted rather than replaced. See
 * `RetractFactEffect`.
 *
 * What made this worth finishing rather than leaving recorded-but-inert: with no
 * consumer, the entire return path was write-only. `feedback:verdict`,
 * `state.feedback`, `POST /feedback`, `gnomon feedback` and the macOS verdict
 * buttons all shipped, and correcting Gnomon changed nothing — which also left
 * the owner no reason to keep rating, and A07/A15 permanently unmeasurable for
 * want of ratings.
 *
 * A `wrong` verdict on a `knowledge_entry` now RETRACTS it too (2026-08-15),
 * which the note here previously argued was unnecessary on the grounds that an
 * entry is a record of what Gnomon produced rather than a claim about the
 * world. That was wrong on the part that matters: an insight, a journal entry
 * and a kept answer are all embedded, and `scoredSearch` hands them to the next
 * question as evidence. So an uncorrected entry does not merely sit there being
 * false — it gets cited, and Gnomon starts reasoning from its own mistake. The
 * entry keeps its row and its place in history; what it loses is retrieval, via
 * the same embedding sweep a superseded fact gets. See `RetractKnowledgeEntry`.
 *
 * `ask_thread` is an artifact kind as of the v3 conversation. Two verdicts on an
 * answer do something, and they are not symmetric:
 *
 * - `wrong` on an answer the owner KEPT retracts the entry that keep created,
 *   because from the moment it was kept it is retrievable evidence like any
 *   other. On an answer that was never kept there is nothing to withdraw: it is
 *   history, not memory, and the verdict is recorded and feeds the drive.
 * - `useful` records the verdict and moves nothing else, deliberately. There is
 *   no belief behind an answer to reinforce — it is model prose ABOUT the
 *   record, not an observation of it — and the honest surface says exactly that
 *   rather than performing a consequence. What it does buy is the signal a
 *   later rule needs to learn the keep decision without being asked, which is
 *   what `RedesignAskPage` has been carrying that decision in state for.
 *
 * Still deliberately untouched, and now for a checked reason rather than an
 * assumed one: a `wrong` verdict on a `moment`. A moment's embedded text is its
 * process name and window titles (`embeddingIndex`) — what the sensor saw, with
 * none of the LLM's narrative or intent in it. So unlike a knowledge entry there
 * is no claim in the retrievable text to withdraw, and the observation itself is
 * not something a verdict can make untrue. `momentClose` is also the single
 * writer of that table, an invariant a feedback rule has no business breaking.
 */
export const feedbackTrack: Rule = (state, event) => {
  if (event.type !== 'feedback:verdict') return { state, effects: [] };

  const payload = event.payload as FeedbackVerdictPayload;
  const verdict = payload.verdict as FeedbackVerdict | undefined;
  const artifactKind = payload.artifactKind as FeedbackEntry['artifactKind'] | undefined;
  const artifactId = typeof payload.artifactId === 'string' ? payload.artifactId.trim() : '';

  if (!verdict || !VALID_VERDICTS.has(verdict)) return { state, effects: [] };
  if (!artifactKind || !VALID_ARTIFACT_KINDS.has(artifactKind)) return { state, effects: [] };
  if (!artifactId) return { state, effects: [] };

  // A verdict is SOLICITED when it answers something Gnomon asked about, which
  // the reducer can tell on its own: the artifact is the currently-open request
  // (`solicitFeedback`), or it was asked about recently and the pointer has since
  // rotated. Deciding it here rather than trusting the payload means a solicited
  // rating is recorded correctly whichever surface submits it — the CLI, macOS
  // and iOS all still send `solicited:false` — while an explicit `true` from a
  // future surface is still honoured.
  const answersAsk = state.feedback.solicitation?.artifactId === artifactId || state.feedback.solicitedRecently.includes(artifactId);

  const entry: FeedbackEntry = {
    artifactKind,
    artifactId,
    verdict,
    solicited: payload.solicited === true || answersAsk,
    note: typeof payload.note === 'string' && payload.note.trim() ? payload.note.trim() : null,
    ts: event.ts,
  };

  const counts = state.feedback.countsByVerdict;
  const feedback: KernelState['feedback'] = {
    recent: [...state.feedback.recent, entry].slice(-MAX_RECENT_FEEDBACK),
    countsByVerdict: { ...counts, [verdict]: (counts[verdict] ?? 0) + 1 },
    lastVerdictAt: event.ts,
    // Answering the open ask closes it; `solicitedRecently` is kept so the same
    // insight is never solicited again.
    solicitation: state.feedback.solicitation?.artifactId === artifactId ? null : state.feedback.solicitation,
    solicitedRecently: state.feedback.solicitedRecently,
  };

  const memory =
    verdict === 'wrong'
      ? { ...state.memory, accumulatedImportance: Math.min(MAX_ACCUMULATED, state.memory.accumulatedImportance + WRONG_VERDICT_SURPRISE) }
      : state.memory;

  // `not-now` is the timing verdict, and it is the one the gate can act on.
  //
  // Until 2026-08-14 nothing consumed it: `feedbackTrack` recorded the tally and
  // stopped, so being told "not now" ten times (the largest bucket in the owner's
  // real 24 verdicts) taught the gate nothing and the same key came back at full
  // volume. Codellaborator's mechanic is the fix — when an intervention is ignored,
  // its own trigger's bar rises — expressed here in the currency the gate already
  // has: bumping `fires` both deepens the decay and slows the recovery, exactly as
  // an extra delivery would.
  //
  // Deliberately NOT applied to `wrong`, which is about truth and already lowers
  // belief further down, nor to `useful`, which is confirmation. Quieting a key the
  // owner called useful would punish the gate for being right.
  //
  // A `notice` verdict carries the gate key AS its artifact id, so the phasic
  // path needs no lookup: it is the delivery, not a row about one. The tonic
  // path still resolves through the knowledge entry the `ScheduleLLM` wrote,
  // because that is the artifact the owner actually saw and rated.
  //
  // `useful` is the other half, added 2026-09-28 (UC4 finding 2): the owner
  // saying "worth hearing" RESTORES the key — its habituation entry is dropped,
  // so the next one is weighed as if it were the first. Before, a watch rule
  // the owner kept marking useful still wore down to silence after two
  // deliveries, which is the gate being punished for being right in reverse.
  const ratedKey =
    verdict === 'wrong' ? undefined : artifactKind === 'notice' ? artifactId : state.memory.recentInsights.find((i) => i.id === artifactId)?.noticeKey;
  const notNowKey = verdict === 'not-now' ? ratedKey : undefined;
  const restoredKey = verdict === 'useful' && ratedKey !== undefined && state.notices.habituation[ratedKey] !== undefined ? ratedKey : undefined;
  // The same mechanic for an ASK, and the two differences from the branch above
  // are both forced by what an ask is.
  //
  // **The subject is the CLASS, not the ask.** A notice key is the stimulus
  // because a notice recurs; an ask is asked once about one meeting or one
  // alias, so its own key is a stimulus that never repeats. Measured over the
  // 63 gate decisions an ask has ever had: `habituation` 1.0 and `weight` 2.0
  // on every single one. Nothing the owner pressed could have moved either
  // number, which is why this verdict was recorded and dropped. `askClass`
  // reads the template off the ask's id, and that is what the owner is
  // actually judging — ten `who` asks refused in five different wordings is
  // one complaint, not ten.
  //
  // **`wrong` counts here, and it does not above.** For a notice, `wrong` is
  // about truth and already lowers belief further down; quieting on it would
  // charge the gate twice for one error. An ask asserts nothing, so there is
  // no belief to lower and nothing else consumes the verdict — and on this
  // card's own vocabulary `wrong` means "the wrong question", which is a
  // statement about the asking and a stronger one than `not-now`. Excluding it
  // would drop the only signal the record actually holds: one `wrong`, on a
  // `who` ask, and zero `not-now`s on any ask ever.
  //
  // `useful` still moves nothing, for the reason it never did: quieting a key
  // the owner called useful would punish the gate for being right.
  const quietedClass = artifactKind === 'owner_ask' && (verdict === 'not-now' || verdict === 'wrong') ? askClass(artifactId) : undefined;
  // W5 loop H: `useful` raises it too — the class is heard at full volume again, as a notice key is.
  const raisedClass = artifactKind === 'owner_ask' && verdict === 'useful' && state.ownerAsk.classGain?.[askClass(artifactId)] !== undefined ? askClass(artifactId) : undefined;
  const ownerAsk = raisedClass
    ? { ...state.ownerAsk, classGain: Object.fromEntries(Object.entries(state.ownerAsk.classGain).filter(([cls]) => cls !== raisedClass)) }
    : quietedClass
    ? {
        ...state.ownerAsk,
        classGain: {
          ...state.ownerAsk.classGain,
          // One definition of a verdict's worth of quieting, shared with the
          // boot rebuild, so a replay and a live press cannot disagree.
          [quietedClass]: quietClass(state.ownerAsk.classGain?.[quietedClass], event.ts),
        },
      }
    : state.ownerAsk;

  const notices = notNowKey
    ? {
        ...state.notices,
        habituation: {
          ...state.notices.habituation,
          [notNowKey]: (() => {
            const previous = state.notices.habituation[notNowKey];
            const fires = (previous?.fires ?? 0) + 1;
            return { gain: (previous?.gain ?? 1) * DEFAULT_GATE_POLICY.habituationStep, at: event.ts, fires };
          })(),
        },
      }
    : restoredKey
      ? { ...state.notices, habituation: Object.fromEntries(Object.entries(state.notices.habituation).filter(([key]) => key !== restoredKey)) }
      : state.notices;

  // The Jev answers behind what the owner just graded (docs/jarvis/02, J0.7).
  // A `moment` verdict grades every answer in that moment's fan-out; any other
  // kind grades the answers a rule tagged with this artifact id. `useful` is a
  // hit, `wrong` a miss, `not-now` says nothing about the answers — it is the
  // timing verdict, and grading it here would teach a question that a true
  // answer was false, the conflation this rule exists to keep apart.
  //
  // W5 step 4: a knowledge entry written from a notice also finds the notice's answers
  // (by the insight's key), and the verdict is kept so an answer that arrives after it — the
  // nightly fact audit, a rejudge — is graded when it lands (`judgementTrack`).
  const judgement =
    verdict === 'not-now'
      ? state.judgement
      : (() => {
          const insightKey = artifactKind === 'knowledge_entry' ? state.memory.recentInsights.find((i) => i.id === artifactId)?.noticeKey : undefined;
          const keys = new Set([artifactId, ...(insightKey ? [insightKey] : [])]);
          const done = new Set((state.judgement.verdicts ?? []).filter((v) => keys.has(v.artifactId)).flatMap((v) => v.graded));
          const found = artifactKind === 'moment' ? state.judgement.recent.filter((r) => r.momentId === artifactId) : (state.judgement.recentByArtifact ?? []).filter((r) => r.artifactId !== null && keys.has(r.artifactId));
          const behind = found.filter((r) => !done.has(r.questionSetId));
          const useful = verdict === 'useful';
          const verdicts = [...keys].reduce((v, key) => rememberVerdict(v, key, useful, event.ts, behind.map((r) => r.questionSetId)), state.judgement.verdicts);
          return { ...state.judgement, questions: behind.length === 0 ? state.judgement.questions : gradeRows(state.judgement.questions, behind, useful, event.ts), verdicts };
        })();

  // A `useful` verdict on a FACT is evidence, and until 2026-08-14 it was the one
  // verdict that moved nothing at all.
  //
  // The asymmetry it left behind was the problem: `wrong` retracted a belief, but
  // `useful` — the owner confirming, from outside the sensor stream, that a fact is
  // true — was recorded in the tally and discarded. So belief could only ever fall
  // on owner input, never rise, and the feedback loop
  // (`decisions/assistant-as-an-event-source`) describes was open at exactly the point where the owner is most reliable.
  //
  // Reinforcement, not promotion: this bumps the Beta posterior of a fact that has
  // ALREADY been promoted, which is the same `ReinforceFact` effect
  // `contradictionCheck` emits when it re-observes a confirmed value. It cannot
  // create a fact, cannot supersede one, and cannot resurrect a retracted one — an
  // owner wanting to state something new still uses `gnomon_assert`, which has its
  // own provenance and its own heavier posterior.
  if (verdict === 'useful' && artifactKind === 'entity_fact') {
    return {
      state: { ...state, feedback, memory, notices, judgement },
      // Deliberately the same delta as an ordinary re-observation rather than a
      // larger one. The owner confirming a fact is strong evidence, but the fact is
      // already believed — this is corroboration, and inflating it would make one
      // click outweigh a week of observation.
      effects: [{ type: 'ReinforceFact', factId: artifactId, delta: OWNER_CONFIRMATION_DELTA, ts: event.ts }],
    };
  }

  const carried = { ...state, feedback, memory, notices, judgement, ownerAsk };

  // A `wrong` verdict on a KNOWLEDGE ENTRY withdraws it from retrieval. The row
  // survives — a correction is itself information — but the claim stops being
  // handed to later questions as evidence.
  if (verdict === 'wrong' && artifactKind === 'knowledge_entry') {
    return {
      state: carried,
      effects: [{ type: 'RetractKnowledgeEntry', entryId: artifactId, reason: 'owner verdict: wrong', ts: event.ts }],
    };
  }

  // An ANSWER (`ask_thread`: a chat turn, `<session>#<n>`) is history, not memory: the verdict is
  // recorded and stops here. W6 P4 retired the Ask surface's kept answers (`state.ask`, last folded
  // 2026-08-15); the four the owner kept are knowledge entries, and a verdict on one lands there.

  // Only a `wrong` verdict on a FACT retracts a belief. `not-now` is explicitly
  // about timing, so it never touches belief — the distinction those three
  // verdicts exist to preserve.
  if (verdict !== 'wrong' || artifactKind !== 'entity_fact') {
    return { state: carried, effects: [] };
  }

  /**
   * Forget that the retracted value was ever confirmed.
   *
   * Retracting the row alone is not enough, and this is the part that makes the
   * correction stick. `contradictionCheck` decides what to do with an incoming
   * candidate by consulting `state.memory.factCursor`, where a confirmed entry
   * holds `object` and `factId`. Leave that entry in place and the very next
   * observation of the same value takes Case 1 — "repeat of the confirmed
   * truth" — and REINFORCES the belief the owner just rejected, without ever
   * going near the promotion threshold. The owner would correct a fact and
   * watch it come straight back, stronger.
   *
   * Resetting the entry to unconfirmed means the value has to earn promotion
   * again from zero, through the full `MIN_OBSERVATIONS_FOR_NEW_FACT` streak.
   * That is the right strength: a retraction is not a permanent ban on a fact
   * the world keeps demonstrating, but it does revoke everything the fact had
   * accumulated.
   *
   * Matched by `factId` because that is all a verdict carries — the cursor is
   * keyed by entity and predicate, which the payload does not know. Scanning is
   * fine: the cursor is bounded at 512 entries.
   */
  const factCursor = { ...state.memory.factCursor };
  let cursorCleared = 0;
  for (const [key, cursorEntry] of Object.entries(factCursor)) {
    if (cursorEntry?.factId !== artifactId) continue;
    factCursor[key] = { ...cursorEntry, object: null, factId: null, pendingObject: null, pendingCount: 0 };
    cursorCleared += 1;
  }

  return {
    state: { ...state, feedback, judgement, memory: { ...memory, factCursor } },
    effects: [{ type: 'RetractFact', factId: artifactId, reason: `owner verdict: wrong${cursorCleared === 0 ? ' (no cursor entry held it)' : ''}`, ts: event.ts }],
  };
};
