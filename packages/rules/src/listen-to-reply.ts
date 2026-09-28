import { deriveId } from '@sundial/helpers/derive-id.js';
import type { Effect, JudgementResultPayload, KernelState, Rule } from '@sundial/kernel/types.js';
import { openGoals } from './goal-checkin.js';
import { questionId } from './questions/index.js';
import { GOAL_SLOT_QUESTIONS, LISTEN_REPLY_QUESTIONS, MAX_GOALS, goalSlot, listenReply } from './questions/listen-reply.js';

/**
 * J1.5 — Gnomon listens to what the owner answered.
 *
 * Two rules, one exchange. `listenToReply` fires on `ask:owner-answered`, for
 * the open question the answer names, and puts the exchange to Jev
 * (`listen-reply`) with the context a branch needs: the meeting the question
 * was about (from `state.meetings.seen`, matched on the ask's own timestamp),
 * or the goals it listed. It runs BEFORE `ownerAsk` in the manifest, because
 * that rule closes `open` on the same event.
 *
 * `applyOwnerReply` reads the answers against each question's own threshold
 * (law 4, law 5) and acts, at L3 and below (docs/jarvis/05):
 * - "attach the transcript" on a meeting question → `AttachTranscript`. Two
 *   keys: the meeting is a calendar or AV row, the instruction is the owner's.
 * - a goal the owner wants paused or dropped → a `status` assertion on that
 *   goal, through the same `entity:fact-candidate` door `gnomon_assert` uses,
 *   `provenance: 'assertion'` — the owner's word supersedes on one sighting.
 * - a reply worth keeping (level ≥ 2, "a real update" or "a decision") → a
 *   knowledge entry in the owner's own words, embedded, so the next question
 *   can find it.
 * Nothing outward, nothing irreversible: a note, a fact, a note.
 */
const MEETING_PREFIX = 'owner-ask:meeting-';
const GOALS_PREFIX = 'owner-ask:goals-';
const REPLY_TITLE_MAX = 90;

interface ReplyMetadata {
  askId: string;
  question: string;
  answer: string;
  meeting: { title: string; start: string; end: string; attendees: string[] } | null;
  goals: { entityId: string; name: string }[];
}

const trim = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function replyMetadata(meta: unknown): ReplyMetadata | null {
  if (!isRecord(meta)) return null;
  const askId = trim(meta.askId);
  const answer = trim(meta.answer);
  if (askId === '' || answer === '') return null;
  const attendees = isRecord(meta.meeting) && Array.isArray(meta.meeting.attendees) ? meta.meeting.attendees.filter((a): a is string => typeof a === 'string') : [];
  const meeting = isRecord(meta.meeting) && trim(meta.meeting.title) !== '' && trim(meta.meeting.start) !== '' && trim(meta.meeting.end) !== '' ? { title: trim(meta.meeting.title), start: trim(meta.meeting.start), end: trim(meta.meeting.end), attendees } : null;
  const goals = Array.isArray(meta.goals) ? meta.goals.filter((g): g is { entityId: string; name: string } => isRecord(g) && trim(g.entityId) !== '' && trim(g.name) !== '') : [];
  return { askId, question: trim(meta.question), answer, meeting, goals };
}

export const listenToReply: Rule = (state, event) => {
  if (event.type !== 'ask:owner-answered') return { state, effects: [] };
  const open = state.ownerAsk.open;
  if (!open) return { state, effects: [] };
  const askId = trim(event.payload.askId);
  if (askId !== '' && askId !== open.askId) return { state, effects: [] };
  const answer = trim(event.payload.answer);
  if (answer === '') return { state, effects: [] };

  // The meeting the question was about: `meetingFollowup` stamps `askedAt` with
  // the tick that opened the ask, and the ask carries that same `ts`.
  const meeting = open.askId.startsWith(MEETING_PREFIX) ? (Object.values(state.meetings.seen).find((m) => m.askedAt === open.ts) ?? null) : null;
  const goals = open.askId.startsWith(GOALS_PREFIX) ? openGoals(state.memory.factCursor).slice(0, MAX_GOALS) : [];

  const built = listenReply.build({ question: open.question, reason: open.reason === '' ? null : open.reason, answer, openGoals: goals.map((g) => g.name) });
  const metadata: ReplyMetadata = {
    askId: open.askId,
    question: open.question,
    answer,
    meeting: meeting ? { title: meeting.title, start: meeting.start, end: meeting.end, attendees: meeting.attendees } : null,
    goals: goals.map((g) => ({ entityId: g.entityId, name: g.name })),
  };
  return {
    state,
    effects: [{ type: 'Judge', purpose: 'listen', questionSetId: listenReply.id, momentId: null, delayMs: 0, state: built.state, questions: built.questions, metadata: metadata as unknown as Record<string, unknown> }],
  };
};

const TRANSCRIPT = questionId(LISTEN_REPLY_QUESTIONS.wants_transcript_attached);
const WORTH = questionId(LISTEN_REPLY_QUESTIONS.worth_remembering);

/** P(level ≥ 2) off a score's vector. */
const massAtLeast = (answer: JudgementResultPayload['answers'][string] | undefined, level: number): number =>
  Object.entries(answer?.probabilities ?? {}).reduce((sum, [k, v]) => (Number(k) >= level && typeof v === 'number' ? sum + v : sum), 0);
const topP = (answer: JudgementResultPayload['answers'][string] | undefined): number => Math.max(0, ...Object.values(answer?.probabilities ?? {}).filter((v): v is number => typeof v === 'number'));

export const applyOwnerReply: Rule = (state, event) => {
  if (event.type !== 'judgement:result') return { state, effects: [] };
  const payload = event.payload as unknown as JudgementResultPayload;
  if (payload.questionSetId !== listenReply.id) return { state, effects: [] };
  const meta = replyMetadata(payload.metadata);
  if (!meta) return { state, effects: [] };
  const threshold = (id: string, fallback: number) => state.judgement.questions[id]?.threshold ?? fallback;
  const a = payload.answers ?? {};
  const effects: Effect[] = [];

  // 1. The transcript, when there is a meeting to attach it to.
  if (meta.meeting && (a.wants_transcript_attached?.noul ?? 0) >= threshold(TRANSCRIPT, 0.5)) {
    effects.push({ type: 'AttachTranscript', askId: meta.askId, title: meta.meeting.title, start: meta.meeting.start, end: meta.meeting.end, attendees: meta.meeting.attendees, answer: meta.answer, ts: event.ts });
  }

  // 2. Goals the owner paused or dropped, one assertion each.
  meta.goals.forEach((goal, i) => {
    const verdict = a[goalSlot(i)];
    const choice = verdict?.choice;
    if (choice !== 'pause' && choice !== 'drop') return;
    if (topP(verdict) < threshold(questionId(GOAL_SLOT_QUESTIONS[goalSlot(i)]), 0.7)) return;
    effects.push({
      type: 'EmitEvent',
      event: {
        id: deriveId(event.ts, event.id, 'owner-reply-goal', goal.entityId),
        type: 'entity:fact-candidate',
        ts: event.ts,
        payload: { entityKind: 'goal', canonicalName: goal.name, predicate: 'status', object: choice === 'pause' ? 'paused' : 'dropped', confidence: 100, provenance: 'assertion', entityId: goal.entityId, sourceEventId: event.id, projectId: null },
      },
    });
  });

  // 3. A reply worth keeping, in the owner's words.
  if (massAtLeast(a.worth_remembering, 2) >= threshold(WORTH, 0.5)) {
    const entryId = deriveId(event.ts, event.id, 'owner-reply', meta.askId);
    effects.push(
      {
        type: 'WriteDB',
        table: 'knowledge_entries',
        row: { id: entryId, kind: 'owner-reply', title: (meta.question || 'You said').slice(0, REPLY_TITLE_MAX), body: meta.answer, severity: null, dedupeKey: `reply:${meta.askId}`, sourceEventId: event.id, createdAt: event.ts, importanceScore: 0.7 },
      },
      { type: 'Embed', id: deriveId(event.ts, event.id, 'owner-reply', 'embed'), refType: 'knowledge_entry', refId: entryId, text: `${meta.question} ${meta.answer}` },
    );
  }

  return { state: state as KernelState, effects };
};
