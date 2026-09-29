import type { Effect } from './types.js';

/**
 * How many times the executor is allowed to run one effect.
 *
 * `at-least-once` — re-running is acceptable. Either the effect is genuinely
 * idempotent (a write keyed by a deterministic id) or repeating it costs
 * something bounded and internal (one extra LLM call, one extra decay pass)
 * that is preferable to silently dropping it. Every effect in the union today
 * is this.
 *
 * `at-most-once` — re-running is worse than not running at all, because the
 * effect leaves the machine and cannot be taken back: a message sent, a door
 * opened, a purchase made. Nothing is classified this way yet. The value exists
 * so that when the first outward action is added it has to choose, and so the
 * journal that protects it is already in place rather than being retrofitted
 * under a bug report.
 */
export type DeliveryGuarantee = 'at-least-once' | 'at-most-once';

/**
 * The delivery guarantee for one effect, consulted by the executor when boot
 * replay finds a journal row in `started` — meaning the effect was in flight
 * when a previous process died and its outcome is unknown.
 *
 * With an unknown outcome there are only two moves and no third option. Run it
 * again, which is right for `at-least-once` and is exactly what the executor
 * did before the journal became two-phase. Or abandon it and record that the
 * outcome is indeterminate, which is right for `at-most-once`: an owner reading
 * "we may have sent this, we don't know" can check and resend, whereas nobody
 * can un-send a duplicate.
 *
 * Deliberately a `switch` over every variant with no `default`, so TypeScript
 * fails the build when a variant is added to `Effect` without deciding this. A
 * `default` returning `at-least-once` would be the cheap version and it would
 * hand every future outward action the wrong guarantee by silence — which is
 * the failure this function exists to prevent.
 *
 * Pure, and in the kernel beside `Effect` itself, so the classification is a
 * property of the effect union rather than of the daemon that happens to run
 * it: the same answer for the live executor, boot replay, and any test.
 */
export function effectDeliveryGuarantee(effect: Effect): DeliveryGuarantee {
  switch (effect.type) {
    // Keyed by an id the emitting rule derived deterministically, so a repeat
    // is the same row rather than a second one.
    case 'WriteDB':
    case 'UpsertEntityFact':
    case 'SupersedeFact':
    // Idempotent by construction: it sets `validTo` to the verdict's own ts, so
    // re-applying writes the identical value rather than moving the boundary.
    case 'RetractFact':
    // Same construction, same guarantee: `retractedAt` is the verdict's own ts
    // and the update is guarded on the column still being null, so a replay
    // writes the identical value rather than restamping a retraction that has
    // already happened.
    case 'RetractKnowledgeEntry':
    case 'UpdateMomentData':
    // Replaces the whole `proposals` column with the same model reading, so a
    // repeat writes the identical value rather than appending a second one.
    case 'UpdateOwnerAsk':
    case 'Embed':
      return 'at-least-once';

    // Fed back through the same ingest path as a sensor event, with a derived
    // id the log dedupes on.
    case 'EmitEvent':
      return 'at-least-once';

    // Not idempotent in the strict sense — a repeat is a real second model call
    // against a real budget — but the cost is bounded, internal, and auditable,
    // and dropping a due analysis is the worse failure. The journal already
    // makes the repeat rare; this says it is tolerable when it happens.
    case 'ScheduleLLM':
    // A repeat is one more 300 ms Jev call at $0.00003 against its own budget,
    // and its answers land as a second `judgement:result` the consuming rule
    // treats like the first (Jev is near-deterministic: jitter 0.01–0.03).
    case 'Judge':
    case 'RunReflection':
    case 'RunFactExtraction':
    case 'RunConversationExtraction':
    // A repeat is one more `extract` call; the promises it reads open under ids
    // derived from the meeting and their position, so none opens twice.
    case 'RunMeetingPromises':
    case 'RunJournal':
    // One extra nightly refutation pass costs a handful of cheap-model calls
    // against a budget, and it cannot double-write belief: every refutation it
    // produces goes through `contradictionCheck`, which is idempotent on a
    // repeated identical candidate.
    case 'RunRefutation':
    // A repeated belief-audit pass re-judges the same facts against the `audit`
    // cap; a second RetractFact on an already-closed fact is a no-op
    // (`retractEntityFact` guards on `valid_to IS NULL`). Dropping a pass would
    // leave a malformed belief live for a day, which is worse.
    case 'RunBeliefAudit':
    // A repeated alignment pass re-judges the same pairs; a suggestion is upserted by pair key, so nothing doubles.
    case 'RunAliasAlignment':
    // A repeat re-reads the record and plans against it; a fact already
    // retracted or an entity already merged is not in the next read, so the
    // second plan is smaller, never a double.
    case 'RunWorldHygiene':
    // A repeat reads the same oldest-unharvested row and spends one more
    // `extract` call on it, against a 300/day cap that sees about two. Dropping
    // a sweep would leave an answer unread for an hour, which is worse.
    case 'RunAskHarvestBackfill':
    // A repeat plans the same week again and replaces the plan; steps already run are not re-run (the plan keys them).
    case 'RunGoalPlan':
      return 'at-least-once';

    // Deterministic re-read of the forecaster's own recorded rows: a repeat
    // recomputes the identical verdict, and the result signal it appends is
    // consumed by `researchGoals` guards that ignore a verdict for a goal that
    // already has one — so a duplicate is noise in the log, not double belief.
    // Dropping a due trial would strand the goal with a hypothesis forever.
    case 'RunGoalTrial':
      return 'at-least-once';

    // Multiplicative, so a repeat genuinely double-applies. Tolerated for the
    // same reason: one extra day's decay on a score is a small, self-correcting
    // error, and skipping a decay pass entirely biases the other way forever.
    case 'DecayScores':
    case 'DecayFactConfidence':
    case 'ReinforceFact':
      return 'at-least-once';

    // Age-bounded delete — running it twice removes the same rows.
    case 'DeleteRows':
      return 'at-least-once';

    // Keyed by the open prediction's derived id and inserted with
    // `onConflictDoNothing`, so a replay offers the identical row and the
    // second offer is discarded rather than double-counted.
    case 'RecordPrediction':
      return 'at-least-once';

    // Same construction as RecordPrediction: keyed by an id derived from the
    // triggering event and inserted with `onConflictDoNothing`, so a replay
    // offers the identical row and the second offer is discarded.
    case 'RecordGateDecision':
      return 'at-least-once';

    // Two UPDATEs and a DELETE that are no-ops the second time: once the rows
    // point at `into`, nothing matches `from` any more.
    case 'MergeProject':
    // A repeat finds no `from` row and moves nothing; the alias is a set.
    case 'MergeEntity':
      return 'at-least-once';

    // Keyed by the ask (`transcript:<askId>`) and inserted onConflictDoNothing:
    // a replay offers the identical note and the second offer is discarded.
    case 'AttachTranscript':
      return 'at-least-once';

    // One UPDATE of one JSON column by primary key: the second run writes the
    // identical value.
    case 'RecordGateFeatures':
      return 'at-least-once';

    /**
     * The one to watch. `Notify` now HAS a delivery channel — the harness's
     * `sundial-proactive` plugin injects it into (and, for a phasic notice,
     * wakes) the companion agent. The argument for keeping `at-least-once`,
     * made rather than inherited: a crash-window repeat is one duplicate
     * context block in the companion's inbox, and for phasic one duplicate
     * spoken turn — annoying, bounded, and self-evidently a repeat to the
     * owner reading it. Dropping a notice the gate fought to admit is the
     * worse failure; the gate's habituation already quiets the key afterward.
     */
    case 'Notify':
      return 'at-least-once';

    /**
     * Reads git history and emits one `entity:fact-candidate` per match. Safe to
     * repeat on any terms: the sweep is a pure function of what is on disk, so a
     * replay proposes the identical name for the identical alias, and
     * `contradictionCheck` treats a re-proposal of a belief already held as
     * corroboration rather than a second fact. Costs a few `git log` calls.
     */
    case 'ResolveAliases':
      return 'at-least-once';
  }

  /**
   * Compile-time exhaustiveness: if a variant is added to `Effect` without a
   * case above, `effect` is no longer `never` here and this line fails the
   * build. That is the mechanism forcing a decision rather than a default.
   */
  const unhandled: never = effect;
  void unhandled;

  /**
   * Runtime backstop, and it fails SAFE rather than convenient. An effect this
   * function does not recognise is one whose reversibility is unknown, and the
   * only defensible guarantee for an unknown effect is the strict one: never
   * repeat it. Returning `at-least-once` here would mean a variant that somehow
   * slipped past the check above gets retried after a crash, which is precisely
   * the outcome the strict class exists to prevent.
   */
  return 'at-most-once';
}

/**
 * What an effect DOES to the world, from the owner's side of it.
 *
 * The Trace card's whole subject. `applied_effects` is the one complete record
 * of everything Gnomon has ever done — every side effect in the system goes
 * through one executor and is journaled there — and ranked by count it says
 * `applyMomentJudgement` and nothing else. The question a ranking is FOR is
 * where the work goes, and the answer only reads once the thirty-eight
 * variants are sorted into the four things a side effect can be.
 *
 * `record` — it changed what Gnomon knows: a row, a fact, a vector, a score.
 * `think` — it spent a model call.
 * `itself` — it fed an event back into its own fold. This is Gnomon talking to
 *   Gnomon, and it is the reason a trigger event is usually not a sensor.
 * `you` — it left the machine towards the owner. Exactly one variant does this.
 *
 * A `Record` keyed by `Effect['type']` rather than a switch, because the Trace
 * route reads a KIND OFF A STORED STRING (`effect_detail`'s first token) and
 * cannot call a function over an `Effect` it no longer has. Keying it this way
 * still fails the build when a variant is added to the union without a family,
 * which is the same enforcement `effectDeliveryGuarantee` gets from its
 * `never` check one function up.
 */
export type EffectFamily = 'record' | 'think' | 'itself' | 'you';

export const EFFECT_FAMILY: Record<Effect['type'], EffectFamily> = {
  WriteDB: 'record',
  UpdateMomentData: 'record',
  UpdateOwnerAsk: 'record',
  UpsertEntityFact: 'record',
  SupersedeFact: 'record',
  RetractFact: 'record',
  RetractKnowledgeEntry: 'record',
  ReinforceFact: 'record',
  DecayFactConfidence: 'record',
  DecayScores: 'record',
  Embed: 'record',
  DeleteRows: 'record',
  MergeProject: 'record',
  MergeEntity: 'record',
  RecordPrediction: 'record',
  RecordGateDecision: 'record',
  RecordGateFeatures: 'record',
  AttachTranscript: 'record',

  ScheduleLLM: 'think',
  Judge: 'think',
  RunReflection: 'think',
  RunFactExtraction: 'think',
  RunConversationExtraction: 'think',
  RunMeetingPromises: 'think',
  RunRefutation: 'think',
  RunBeliefAudit: 'think',
  RunAliasAlignment: 'think',
  ResolveAliases: 'think',
  RunAskHarvestBackfill: 'think',
  RunJournal: 'think',
  RunGoalTrial: 'think',
  RunGoalPlan: 'think',
  // W2 — changes what Gnomon knows, through the retractions and merges it plans.
  RunWorldHygiene: 'record',

  EmitEvent: 'itself',

  Notify: 'you',
};
