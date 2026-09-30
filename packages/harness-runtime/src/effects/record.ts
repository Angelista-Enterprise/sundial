// Effects that write the record: rows, facts, embeddings, predictions, gate decisions, prunes.
import { momentEmbedText, momentModelTag } from '@sundial/helpers/moment-embed-text.js';
import {
  decayCurrentFactConfidence,
  decayKnowledgeScores,
  decayMomentScores,
  deleteLlmAuditOfSession,
  deleteRowsOlderThan,
  deleteSignalsOlderThan,
  getMomentsByIds,
  getMomentsSince,
  getSignalsInRange,
  insertEmbedding,
  insertEntityFact,
  insertGateDecision,
  insertKnowledgeEntry,
  insertMoment,
  insertPrediction,
  mergeEntityRows,
  mergeMomentData,
  mergeProjectRows,
  reembedStaleEmbeddings,
  reinforceEntityFact,
  replaceEmbedding,
  resolveEntityAlias,
  retractEntityFact,
  retractKnowledgeEntry,
  supersedeEntityFact,
  trimAuditBodies,
  updateGateDecisionFeatures,
  updateOwnerAsk,
  upsertCommitment,
  upsertEntity,
  upsertOwnerAsk,
  upsertProject,
} from '@sundial/db/index.js';
import { computeEmbedding } from '@sundial/memory/index.js';
import { deriveId } from '@sundial/helpers/derive-id.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { buildWeekReview } from '@sundial/kernel/week-review.js';
import type { ComposeWeekReviewEffect } from '@sundial/kernel/index.js';
import type { KernelRuntime } from '../runtime.js';
import { performAttachTranscript } from '../attach-transcript.js';
import type { Handlers } from './index.js';

/** W4 step 7: the week read from the log, kept once a day as a `week-review` entry, folded back as `brief:week-composed`. */
async function composeWeekReview(host: KernelRuntime, effect: ComposeWeekReviewEffect): Promise<void> {
  const state = host.getState();
  if (!state) return;
  try {
    const review = await buildWeekReview(effect.at, state);
    const dedupeKey = `week-review:${review.from}:${localDate(effect.at, state.config.timezone)}`;
    await insertKnowledgeEntry({ id: deriveId(effect.at, 'week-review', dedupeKey), kind: 'week-review', title: `The week of ${review.from}`, body: review.lines.join('\n'), severity: null, dedupeKey, sourceEventId: null, createdAt: effect.at });
    await host.appendSignal('brief:week-composed', { from: review.from, to: review.to, lines: review.lines, at: effect.at });
  } catch (error) {
    console.error('[sundial-kernel] the week review could not be composed:', error);
  }
}

export const RECORD = {
  WriteDB: async (_host, effect) => {
    switch (effect.table) {
      case 'moments':
        return void (await insertMoment({ ...effect.row, data: { ...effect.row.data } }));
      case 'projects':
        return upsertProject(effect.row);
      case 'knowledge_entries':
        return void (await insertKnowledgeEntry(effect.row));
      case 'commitments':
        return upsertCommitment(effect.row);
      case 'owner_asks':
        return upsertOwnerAsk(effect.row);
    }
  },
  MergeProject: async (_host, effect) => {
    const moved = await mergeProjectRows(effect.from, effect.into);
    console.log(`[sundial-kernel] merged project ${effect.from} into ${effect.into} (${moved.moments} moments, ${moved.commitments} commitments)`);
  },
  RecordGateFeatures: async (_host, effect) => {
    const found = await updateGateDecisionFeatures(effect.decisionId, effect.features as unknown as Record<string, unknown>);
    if (!found) console.log(`[sundial-kernel] gate features for ${effect.noticeKey}: no decision row ${effect.decisionId} to sit beside`);
  },
  AttachTranscript: (host, effect) =>
    performAttachTranscript(effect, { getSignalsInRange, getMomentsSince, insertKnowledgeEntry, computeEmbedding, insertEmbedding, ownerAliases: host.getState()?.config.ownerAliases ?? [], log: console.log }),
  UpdateMomentData: async (_host, effect) => {
    await mergeMomentData(effect.momentId, effect.patch);
    // The narrative lands minutes after the moment closed and was embedded
    // without it; it is the densest line a moment has, so the moment is
    // embedded again from its row, replacing the vector it had.
    if (typeof (effect.patch as { narrative?: unknown }).narrative === 'string') {
      const [row] = await getMomentsByIds([effect.momentId]);
      if (row) {
        const { vector, model } = await computeEmbedding(momentEmbedText(row.processName, row.data));
        await replaceEmbedding({ id: `embed:${effect.momentId}`, refType: 'moment', refId: effect.momentId, model: momentModelTag(model), vector, createdAt: new Date().toISOString() });
      }
    }
  },
  UpdateOwnerAsk: (_host, effect) => updateOwnerAsk(effect.askId, effect.patch),
  DeleteRows: async (host, effect) => {
    if (effect.trim === 'audit-bodies') {
      // lane Q (Q10)
      const trimmed = await trimAuditBodies(effect.olderThan);
      console.log(`[sundial-kernel] retention prune: cleared the text of ${trimmed.llmBodiesCleared} llm_audit rows and deleted ${trimmed.effectsDeleted} completed applied_effects rows older than ${effect.olderThan}`);
    } else if (Array.isArray(effect.signalTypes)) {
      const deleted = await deleteSignalsOlderThan(effect.olderThan, effect.signalTypes, { apps: effect.apps, eventTypes: effect.eventTypes, sessionId: effect.sessionId });
      // W1 step 8: a deleted thread's ledger rows go with it.
      const audit = effect.sessionId !== undefined ? await deleteLlmAuditOfSession(effect.sessionId) : 0;
      console.log(`[sundial-kernel] retention prune (${[...effect.signalTypes, ...(effect.eventTypes ?? [])].join(',')}${effect.apps ? ', sensitive apps' : ''}${effect.sessionId ? ', one thread' : ''}): deleted ${deleted} signals older than ${effect.olderThan}${audit ? ` and ${audit} llm_audit rows` : ''}`);
    } else {
      const result = await deleteRowsOlderThan(effect.olderThan);
      console.log(
        `[sundial-kernel] retention prune: deleted ${result.signalsDeleted} signals, ${result.momentsDeleted} moments, ${result.embeddingsDeleted} orphaned embeddings, ${result.llmAuditDeleted} llm_audit rows older than ${effect.olderThan}`,
      );
      // lane H (H6): the daily copy rides the daily prune, off the lane.
      host.defer(() => void host.runDailyBackup(), 0);
      const backfill = await reembedStaleEmbeddings();
      if (backfill.reembedded > 0 || backfill.orphaned > 0) {
        console.log(
          `[sundial-kernel] embedding backfill: re-embedded ${backfill.reembedded} stale-scheme rows to ${backfill.currentModel}, dropped ${backfill.orphaned} orphans, ${backfill.remaining} remaining`,
        );
      }
    }
  },
  MergeEntity: async (_host, effect) => {
    const moved = await mergeEntityRows(effect.from, effect.into, effect.alias);
    if (moved) console.log(`[sundial-kernel] merged entity ${effect.from} into ${effect.into} (${moved.facts} facts, ${moved.embeddings} embeddings; alias ${effect.alias})`);
  },
  UpsertEntityFact: async (_host, effect) => {
    // J2.4: an alias the owner already resolved lands on the survivor, so the
    // next attendee row for a merged hash does not recreate the hash entity.
    const survivor = effect.entityKind === 'person' ? await resolveEntityAlias(effect.canonicalName) : null;
    const entityId = survivor ?? effect.entityId;
    if (!survivor) await upsertEntity({ id: effect.entityId, kind: effect.entityKind, canonicalName: effect.canonicalName, createdAt: effect.ts });
    await insertEntityFact({
      id: effect.factId,
      entityId,
      predicate: effect.predicate,
      object: effect.object,
      confidence: effect.confidence,
      validFrom: effect.ts,
      sourceEventId: effect.sourceEventId,
      createdAt: effect.ts,
      provenance: effect.provenance,
    });
  },
  SupersedeFact: (_host, effect) => supersedeEntityFact(effect.factId, effect.supersededByFactId, effect.ts),
  RetractFact: (_host, effect) => retractEntityFact(effect.factId, effect.ts),
  RetractKnowledgeEntry: (_host, effect) => retractKnowledgeEntry(effect.entryId, effect.ts),
  Embed: async (_host, effect) => {
    const { vector, model } = await computeEmbedding(effect.text);
    // A moment's vector says which version of its text went in (see `momentEmbedText`).
    await insertEmbedding({ id: effect.id, refType: effect.refType, refId: effect.refId, model: effect.refType === 'moment' ? momentModelTag(model) : model, vector, createdAt: new Date().toISOString() });
  },
  // Deferred like the audits: the week is about a second of reads the fold must not wait on.
  ComposeWeekReview: (host, effect) => host.defer(() => void composeWeekReview(host, effect), 0),
  // W2 — deferred like the belief audit, so a nightly read never holds up the fold that asked for it.
  RunWorldHygiene: (host, effect) => host.defer(() => void host.performWorldHygiene(effect), 0),
  DecayScores: async (_host, effect) => void (await Promise.all([decayMomentScores(effect.factor), decayKnowledgeScores(effect.factor)])),
  ReinforceFact: (_host, effect) => reinforceEntityFact(effect.factId, effect.delta, effect.side),
  DecayFactConfidence: (_host, effect) => decayCurrentFactConfidence(effect.factor),
  RecordGateDecision: (_host, effect) =>
    // The gate's verdict + arithmetic (almanac/architecture/rules/noticing-and-expectations),
    // written HERE (the executor) and never by the rule; the derived id +
    // onConflictDoNothing make boot replay offer the identical row.
    insertGateDecision({
      id: effect.id,
      noticeKey: effect.noticeKey,
      kind: effect.kind,
      channel: effect.channel,
      reason: effect.reason,
      weight: effect.weight,
      utility: effect.utility,
      surprise: effect.surprise,
      precision: effect.precision,
      habituation: effect.habituation,
      concern: effect.concern,
      interruptionCost: effect.interruptionCost,
      // K0.2 — the bars the rule actually used, carried straight through.
      // Not re-derived here: the executor has no business knowing what
      // `noticeBias` does, and a second derivation is a second policy.
      tonicBar: effect.tonicBar,
      phasicBar: effect.phasicBar,
      decidedAt: effect.decidedAt,
    }),
  RecordPrediction: (_host, effect) =>
    insertPrediction({
      id: effect.id,
      kind: effect.kind,
      forecaster: effect.forecaster,
      createdAt: effect.createdAt,
      resolvedAt: effect.resolvedAt,
      priorProb: effect.priorProb,
      features: effect.features,
      outcome: effect.outcome,
      surprise: effect.surprise,
      // K0.3 — the fair opponent, carried from the rule that knew it.
      baseProb: effect.baseProb,
    }),
} satisfies Handlers;
