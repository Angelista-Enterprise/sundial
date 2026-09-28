import { createEventId } from '@sundial/helpers/event-id.js';
import type { AttachTranscriptEffect } from '@sundial/kernel/types.js';

/** Hearing starts a little before a meeting and runs a little past it. */
const WINDOW_PAD_MS = 5 * 60_000;
/** A note the model can still read whole; a two-hour meeting is more than this. */
const MAX_TRANSCRIPT_CHARS = 20_000;

export interface AttachTranscriptDeps {
  getSignalsInRange: (from: string, to: string, limit: number, signalTypes?: string[]) => Promise<{ eventType: string; capturedAt: string; data: Record<string, unknown> }[]>;
  getMomentsSince: (since: string) => Promise<{ startTime: string; endTime: string; data: Record<string, unknown> }[]>;
  insertKnowledgeEntry: (row: { id: string; kind: string; title: string; body: string; severity: string | null; dedupeKey: string; sourceEventId: string | null; createdAt: string; importanceScore?: number }) => Promise<boolean>;
  computeEmbedding: (text: string) => Promise<{ vector: number[]; model: string }>;
  insertEmbedding: (row: { id: string; refType: 'knowledge_entry'; refId: string; model: string; vector: number[]; createdAt: string }) => Promise<unknown>;
  /** Every name the owner goes by (`config.ownerAliases`): the first labels their side, all of them leave the attendee list. */
  ownerAliases?: string[];
  log?: (line: string) => void;
}

/**
 * Who each stream is, in a CALL: the microphone is the owner, the Mac's output
 * is everyone else — by name when the invite has exactly one other person on
 * it and that person has a name rather than a `person-<hash>` alias. The pure
 * rule screenpipe names speakers with, minus voiceprints: nothing about a voice
 * is kept to do it.
 */
export function speakerLabels(attendees: string[], ownerAliases: string[]): { mic: string; system: string } {
  const owner = new Set(ownerAliases.map((a) => a.trim().toLowerCase()));
  const others = [...new Set(attendees.map((a) => a.trim()).filter((a) => a !== '' && !owner.has(a.toLowerCase())))];
  const one = others.length === 1 && !/^person-[0-9a-f]{10}$/.test(others[0]!) ? others[0]! : null;
  return { mic: ownerAliases[0]?.trim() || 'Me', system: one ?? 'Them' };
}

/** What hearing wrote down inside the window: the raw utterances first, the moments' excerpts when there are none. */
export async function transcriptFor(deps: AttachTranscriptDeps, start: string, end: string, attendees: string[] = []): Promise<{ text: string; source: 'utterances' | 'moments' } | null> {
  const from = new Date(Date.parse(start) - WINDOW_PAD_MS).toISOString();
  const to = new Date(Date.parse(end) + WINDOW_PAD_MS).toISOString();
  const utterances = (await deps.getSignalsInRange(from, to, 5000, ['audio']))
    .filter((s) => s.eventType === 'transcript' && typeof s.data.spokenText === 'string' && (s.data.spokenText as string).trim() !== '')
    .sort((a, b) => (a.capturedAt < b.capturedAt ? -1 : 1));
  // Only a window that heard the Mac's own output was a call; without that the
  // microphone is a room, and a room's voices are nobody in particular.
  if (utterances.some((s) => s.data.channel === 'system')) {
    const labels = speakerLabels(attendees, deps.ownerAliases ?? []);
    const lines = utterances.map((s) => `${s.data.channel === 'system' ? labels.system : labels.mic}: ${(s.data.spokenText as string).trim()}`);
    return { text: lines.join('\n').slice(0, MAX_TRANSCRIPT_CHARS), source: 'utterances' };
  }
  if (utterances.length > 0) return { text: utterances.map((s) => (s.data.spokenText as string).trim()).join(' ').slice(0, MAX_TRANSCRIPT_CHARS), source: 'utterances' };
  const moments = (await deps.getMomentsSince(from)).filter((m) => m.startTime <= to && m.endTime >= from);
  const excerpts = moments
    .map((m) => (m.data.spokenClean as { text?: string } | undefined)?.text ?? (m.data.spokenExcerpt as string | undefined) ?? '')
    .filter((t) => typeof t === 'string' && t.trim() !== '');
  return excerpts.length > 0 ? { text: excerpts.join('\n\n').slice(0, MAX_TRANSCRIPT_CHARS), source: 'moments' } : null;
}

/** Performs the effect. Returns what it did, so the executor's log line says it. */
export async function performAttachTranscript(effect: AttachTranscriptEffect, deps: AttachTranscriptDeps): Promise<'attached' | 'already' | 'nothing-on-record'> {
  const found = await transcriptFor(deps, effect.start, effect.end, effect.attendees ?? []);
  if (found === null) {
    deps.log?.(`[sundial-kernel] attach transcript: nothing heard for "${effect.title}" (${effect.start} – ${effect.end})`);
    return 'nothing-on-record';
  }
  const entryId = createEventId();
  const inserted = await deps.insertKnowledgeEntry({
    id: entryId,
    kind: 'meeting-transcript',
    title: `Transcript: ${effect.title}`.slice(0, 120),
    body: `${effect.answer.trim()}\n\n— transcript (${found.source}) —\n${found.text}`,
    severity: null,
    dedupeKey: `transcript:${effect.askId}`,
    sourceEventId: null,
    createdAt: effect.ts,
    importanceScore: 0.8,
  });
  if (!inserted) return 'already';
  const { vector, model } = await deps.computeEmbedding(`Transcript: ${effect.title}. ${effect.answer} ${found.text.slice(0, 2000)}`);
  await deps.insertEmbedding({ id: createEventId(), refType: 'knowledge_entry', refId: entryId, model, vector, createdAt: effect.ts });
  deps.log?.(`[sundial-kernel] attached the ${found.source} transcript of "${effect.title}" to ${effect.askId} (${found.text.length} chars)`);
  return 'attached';
}
