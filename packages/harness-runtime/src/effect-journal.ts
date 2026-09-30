// The effect journal's vocabulary, moved out of runtime.ts (W3, a pure move):
// how an effect is described in its journal row, which tables it announces on
// the live channel, and what a replay does with a row it finds.
import type { EffectJournalStatus } from '@sundial/db/index.js';
import type { DeliveryGuarantee, Effect } from '@sundial/kernel/index.js';

/** A short, human-readable one-liner per effect (journal detail column). Ported verbatim. */
export function describeEffect(effect: Effect): string {
  switch (effect.type) {
    case 'WriteDB':
      return effect.table === 'moments'
        ? `WriteDB moment ${effect.row.id}`
        : effect.table === 'knowledge_entries'
          ? `WriteDB knowledge_entry ${effect.row.id}`
          : effect.table === 'owner_asks'
              ? `WriteDB owner_ask ${effect.row.id}`
            : effect.table === 'commitments'
              ? `WriteDB commitment ${effect.row.id}`
              : `WriteDB project ${effect.row.id}`;
    case 'EmitEvent':
      return `EmitEvent ${effect.event.type}`;
    case 'ScheduleLLM':
      return `ScheduleLLM purpose=${effect.purpose}`;
    case 'Judge':
      return `Judge ${effect.questionSetId} purpose=${effect.purpose}${effect.momentId ? ` moment=${effect.momentId}` : ''}`;
    case 'AttachTranscript':
      return `AttachTranscript ${effect.askId} "${effect.title}"`;
    case 'RunMeetingPromises':
      return `RunMeetingPromises "${effect.title}"`;
    case 'RecordGateFeatures':
      return `RecordGateFeatures ${effect.noticeKey}`;
    case 'UpdateMomentData':
      return `UpdateMomentData ${effect.momentId}`;
    case 'UpdateOwnerAsk':
      return `UpdateOwnerAsk ${effect.askId} (${effect.patch.proposals?.length ?? 0} proposals)`;
    case 'UpsertEntityFact':
      return `UpsertEntityFact ${effect.entityId}.${effect.predicate}`;
    case 'SupersedeFact':
      return `SupersedeFact ${effect.factId}`;
    case 'RetractFact':
      return `RetractFact ${effect.factId} (${effect.reason})`;
    case 'RetractKnowledgeEntry':
      return `RetractKnowledgeEntry ${effect.entryId} (${effect.reason})`;
    case 'Embed':
      return `Embed ${effect.refType} ${effect.refId}`;
    case 'RunReflection':
      return 'RunReflection';
    case 'RunGoalTrial':
      return `RunGoalTrial ${effect.forecaster}:${effect.cell} on ${effect.variable}`;
    case 'RunFactExtraction':
      return 'RunFactExtraction';
    case 'RunConversationExtraction':
      return 'RunConversationExtraction';
    case 'RunJournal':
      return 'RunJournal';
    case 'ResolveAliases':
      return 'ResolveAliases';
    case 'RunRefutation':
      return `RunRefutation sample=${effect.sampleSize}`;
    case 'RunBeliefAudit':
      return 'RunBeliefAudit';
    case 'RunAliasAlignment':
      return 'RunAliasAlignment';
    case 'RunAskHarvestBackfill':
      return 'RunAskHarvestBackfill';
    case 'DecayScores':
      return `DecayScores factor=${effect.factor}`;
    case 'ReinforceFact':
      return `ReinforceFact ${effect.factId} +${effect.delta}${effect.side === 'beta' ? ' against' : ''}`;
    case 'DecayFactConfidence':
      return `DecayFactConfidence factor=${effect.factor}`;
    case 'Notify':
      return `Notify ${effect.channel}`;
    case 'DeleteRows':
      return `DeleteRows olderThan=${effect.olderThan}${effect.signalTypes ? ` types=${effect.signalTypes.join(',')}` : ''}${effect.sessionId ? ` session=${effect.sessionId}` : ''}${effect.trim ? ` trim=${effect.trim}` : ''}`;
    case 'RecordPrediction':
      return `RecordPrediction ${effect.kind}/${effect.forecaster} p=${effect.priorProb.toFixed(2)} outcome=${effect.outcome}`;
    case 'RecordGateDecision':
      return `RecordGateDecision ${effect.noticeKey} ${effect.channel} (${effect.reason})`;
    case 'MergeProject':
      return `MergeProject ${effect.from} -> ${effect.into}`;
    case 'MergeEntity':
      return `MergeEntity ${effect.from} -> ${effect.into}`;
    case 'RunGoalPlan':
      return `RunGoalPlan ${effect.goalId}`;
    case 'ComposeWeekReview':
      return `ComposeWeekReview ${effect.at}`;
    case 'RunRejudge':
      return `RunRejudge ${JSON.stringify(effect.options)}`;
    case 'StartJob':
      return `StartJob ${effect.job.id}`;
    case 'StopJob':
      return `StopJob ${effect.jobId} (${effect.outcome})`;
    case 'StartSubagent':
      return `StartSubagent ${effect.job.id} ${effect.job.kind}`;
    case 'StopSubagent':
      return `StopSubagent ${effect.jobId}`;
    case 'RunWorldHygiene':
      return 'RunWorldHygiene';
    default: {
      // W3: exhaustive, like `performEffect`: a new variant with no summary is a compile error.
      const unhandled: never = effect;
      return (unhandled as Effect).type;
    }
  }
}

/** A journal row written for another rule's effect at the same (event, index): hardening S6. */
export function journalShifted(entry: { ruleName: string | null } | null, ruleName: string): boolean {
  return entry !== null && entry.ruleName !== null && entry.ruleName !== ruleName;
}

/**
 * Journal-vs-guarantee replay policy. Ported verbatim (see the daemon's two-phase journal rationale).
 * The journal names an effect by its position in the fold's output, so new rules shift it for a
 * replayed tail: deploy only through a clean restart (docs/deploy.md). `journalShifted` catches the
 * shift when the row names another rule.
 */
export function replayDecision(status: EffectJournalStatus | null, guarantee: DeliveryGuarantee): 'run' | 'skip' | 'abandon' {
  if (status === null) return 'run';
  if (status === 'completed') return 'skip';
  if (status === 'indeterminate') return 'skip';
  // `started` and `failed` (K0.5) are the same question and get the same
  // answer. Both mean the effect ran and its outcome is unknown — a throw says
  // nothing about how far it got, and neither does a process dying mid-effect.
  // So an at-least-once effect is retried (which is what already happened
  // before the failure was recorded at all) and an at-most-once one is
  // abandoned, because repeating something that leaves the machine is worse
  // than skipping it. Written as one branch rather than two, deliberately:
  // treating a recorded failure as MORE certain than a crash would be a claim
  // the record cannot support.
  return guarantee === 'at-most-once' ? 'abandon' : 'run';
}

/**
 * The table(s) one effect writes — the entire granularity model of the live
 * channel.
 *
 * A table name IS the event name. It already exists, it cannot drift from the
 * schema, and a new effect that writes a new table adds one line here and
 * nothing anywhere else. The daemon's old four-variant push union
 * (`moment-closed` / `insight-created` / `state-changed` / `signal`) could not
 * say WHICH reading moved, so every open surface had to re-read everything.
 *
 * An effect that writes through another path (`EmitEvent` re-enters the
 * pipeline, `Run*` dispatch detached and announce from where they insert)
 * returns nothing, and over-announcing a table is harmless: a card re-reads,
 * sees the same reading, and does not redraw.
 */
export function tablesTouched(effect: Effect): readonly string[] {
  switch (effect.type) {
    case 'WriteDB':
      return [effect.table];
    case 'UpdateMomentData':
      return ['moments', 'memory_embeddings'];
    case 'UpdateOwnerAsk':
      return ['owner_asks'];
    case 'MergeProject':
      return ['projects', 'moments', 'commitments'];
    case 'MergeEntity':
      return ['entities', 'entity_facts', 'memory_embeddings'];
    case 'RunGoalPlan':
      return [];
    case 'ComposeWeekReview':
      return ['knowledge_entries'];
    case 'UpsertEntityFact':
      return ['entities', 'entity_facts'];
    case 'SupersedeFact':
    case 'RetractFact':
    case 'ReinforceFact':
    case 'DecayFactConfidence':
      return ['entity_facts'];
    case 'AttachTranscript':
      return ['knowledge_entries', 'memory_embeddings'];
    case 'RecordGateFeatures':
      return ['gate_decisions'];
    case 'RetractKnowledgeEntry':
      return ['knowledge_entries'];
    case 'Embed':
      return ['memory_embeddings'];
    case 'DecayScores':
      return ['moments', 'knowledge_entries'];
    case 'DeleteRows':
      return ['signals', 'moments', 'memory_embeddings', 'llm_audit'];
    case 'RecordGateDecision':
      return ['gate_decisions'];
    case 'RecordPrediction':
      return ['predictions'];
    // Write through another path (re-enter the pipeline, or dispatch detached
    // and announce from where they insert), or write no table at all.
    case 'EmitEvent':
    case 'ScheduleLLM':
    case 'Judge':
    case 'RunAskHarvestBackfill':
    case 'Notify':
    case 'RunFactExtraction':
    case 'ResolveAliases':
    case 'RunConversationExtraction':
    case 'RunMeetingPromises':
    case 'RunRefutation':
    case 'RunBeliefAudit':
    case 'RunAliasAlignment':
    case 'RunReflection':
    case 'RunGoalTrial':
    case 'RunJournal':
    case 'RunWorldHygiene':
    case 'RunRejudge':
    case 'StartJob':
    case 'StopJob':
    case 'StartSubagent':
    case 'StopSubagent':
      return [];
    default: {
      // W3: exhaustive: a new variant must say which tables it writes, even none.
      const unhandled: never = effect;
      void unhandled;
      return [];
    }
  }
}
