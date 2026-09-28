import { alignAlias } from './align-alias.js';
import { auditFact } from './audit-fact.js';
import { FORECAST_SETS } from './forecast-targets.js';
import { gateFeatures } from './gate-features.js';
import { ingestAnomaly } from './ingest-anomaly.js';
import { journalRank } from './journal-rank.js';
import { classifyAction, verifyAction } from './classify-action.js';
import { perceive } from './perceive.js';
import { judgeDraft } from './judge-draft.js';
import { gradeStep } from './grade-step.js';
import { judgeLine } from './judge-line.js';
import { listenReply } from './listen-reply.js';
import { momentFanout } from './moment-fanout.js';
import { rankEvidence } from './rank-evidence.js';
import { routeAsk } from './route-ask.js';
import type { QuestionSet } from './index.js';

/**
 * Every set a rule may put on a `Judge`. The lint (`state-lint.ts`) walks
 * each one's samples; a set that is not listed here is not linted, so a new
 * set is added here in the same commit that creates it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const QUESTION_SETS: QuestionSet<any[]>[] = [momentFanout, judgeLine, rankEvidence, listenReply, gateFeatures, routeAsk, ...FORECAST_SETS, auditFact, alignAlias, ingestAnomaly, journalRank, classifyAction, verifyAction, perceive, judgeDraft, gradeStep];
