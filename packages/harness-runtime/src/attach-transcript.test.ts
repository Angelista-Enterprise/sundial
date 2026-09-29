import { describe, expect, it, vi } from 'vitest';
import { captionsFor, performAttachTranscript, speakerLabels, transcriptFor, type AttachTranscriptDeps } from './attach-transcript.js';

const effect = { type: 'AttachTranscript' as const, askId: 'owner-ask:meeting-abc', title: 'Puzzlez - Planning', start: '2026-09-21T11:00:00.000Z', end: '2026-09-21T12:00:00.000Z', answer: "good, i've got a transcript, attach it to this question.", ts: '2026-09-21T12:05:00.000Z' };
const deps = (over: Partial<AttachTranscriptDeps> = {}): AttachTranscriptDeps => ({
  getSignalsInRange: async () => [],
  getMomentsSince: async () => [],
  insertKnowledgeEntry: vi.fn(async () => true),
  computeEmbedding: async () => ({ vector: [0.1], model: 'test' }),
  insertEmbedding: vi.fn(async () => undefined),
  ...over,
});

describe('AttachTranscript (J1.5)', () => {
  it('files the utterances heard inside the padded window as one note keyed by the ask, the owner\'s answer on top', async () => {
    const d = deps({
      getSignalsInRange: async (from, to) => {
        expect(from).toBe('2026-09-21T10:55:00.000Z');
        expect(to).toBe('2026-09-21T12:05:00.000Z');
        return [
          { eventType: 'transcript', capturedAt: '2026-09-21T11:02:00.000Z', data: { spokenText: 'we ship the judge' } },
          { eventType: 'level', capturedAt: '2026-09-21T11:02:00.000Z', data: {} },
          { eventType: 'transcript', capturedAt: '2026-09-21T11:01:00.000Z', data: { spokenText: 'ok so,' } },
        ];
      },
    });
    expect(await performAttachTranscript(effect, d)).toBe('attached');
    const row = (d.insertKnowledgeEntry as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(row).toMatchObject({ kind: 'meeting-transcript', title: 'Transcript: Puzzlez - Planning', dedupeKey: 'transcript:owner-ask:meeting-abc', createdAt: effect.ts });
    expect(row.body).toBe("good, i've got a transcript, attach it to this question.\n\n— transcript (utterances) —\nok so, we ship the judge");
    expect(d.insertEmbedding).toHaveBeenCalledTimes(1);
  });

  it('falls back to the moments\' cleaned excerpts, and writes nothing when nothing was heard', async () => {
    const withMoments = deps({ getMomentsSince: async () => [{ startTime: '2026-09-21T11:10:00.000Z', endTime: '2026-09-21T11:40:00.000Z', data: { spokenClean: { text: 'cleaned words' }, spokenExcerpt: 'raw words' } }] });
    expect(await transcriptFor(withMoments, effect.start, effect.end)).toEqual({ text: 'cleaned words', source: 'moments' });
    const silent = deps();
    expect(await performAttachTranscript(effect, silent)).toBe('nothing-on-record');
    expect(silent.insertKnowledgeEntry).not.toHaveBeenCalled();
  });

  it('a replay is a second offer of the same note, discarded by the dedupe key', async () => {
    const d = deps({ getSignalsInRange: async () => [{ eventType: 'transcript', capturedAt: 't', data: { spokenText: 'x' } }], insertKnowledgeEntry: async () => false });
    expect(await performAttachTranscript(effect, d)).toBe('already');
    expect(d.insertEmbedding).not.toHaveBeenCalled();
  });

  it('a call reads as two sides: the microphone is the owner, the Mac\'s output the one other attendee', async () => {
    const d = deps({
      ownerAliases: ['Pat', 'pat-ang'],
      getSignalsInRange: async () => [
        { eventType: 'transcript', capturedAt: '2026-09-21T11:01:00.000Z', data: { spokenText: 'can you hear me?', channel: 'mic' } },
        { eventType: 'transcript', capturedAt: '2026-09-21T11:01:05.000Z', data: { spokenText: 'yes, loud and clear', channel: 'system' } },
      ],
    });
    expect(await transcriptFor(d, effect.start, effect.end, ['Pat', 'Anna de Boer'])).toEqual({ text: 'Pat: can you hear me?\nAnna de Boer: yes, loud and clear', source: 'utterances' });
  });

  it('a room with no system stream keeps its unlabelled text', async () => {
    const d = deps({ getSignalsInRange: async () => [{ eventType: 'transcript', capturedAt: 't', data: { spokenText: 'hello all', channel: 'mic' } }] });
    expect(await transcriptFor(d, effect.start, effect.end, ['Anna'])).toEqual({ text: 'hello all', source: 'utterances' });
  });
});

describe('speakerLabels', () => {
  it('names the far side only in a 1:1 with a real name', () => {
    expect(speakerLabels(['Pat', 'Anna'], ['pat'])).toEqual({ mic: 'pat', system: 'Anna' });
    expect(speakerLabels(['Anna', 'Bob'], ['Pat'])).toEqual({ mic: 'Pat', system: 'Them' });
    expect(speakerLabels(['person-1a2b3c4d5e'], ['Pat'])).toEqual({ mic: 'Pat', system: 'Them' });
    expect(speakerLabels([], [])).toEqual({ mic: 'Me', system: 'Them' });
  });
});

describe('Meet captions for the promise pass (UC1)', () => {
  it('keeps each captioned line once, from Meet pages only, in the order first seen', async () => {
    const d = deps({
      getSignalsInRange: async (_from, _to, _limit, types) => {
        expect(types).toEqual(['page:text']);
        return [
          { eventType: 'text', capturedAt: '2026-09-21T11:01:00.000Z', data: { host: 'meet.google.com', text: 'Mira Bakker\nCould you send the draft?\nTurn on captions' } },
          { eventType: 'text', capturedAt: '2026-09-21T11:02:00.000Z', data: { host: 'meet.google.com', text: 'Could you send the draft?\nYes, I will send it by Tuesday.' } },
          { eventType: 'text', capturedAt: '2026-09-21T11:03:00.000Z', data: { host: 'example.com', text: 'Unrelated page text that is long enough' } },
        ];
      },
    });
    expect(await captionsFor(d, effect.start, effect.end)).toBe('Could you send the draft?\nTurn on captions\nYes, I will send it by Tuesday.');
    expect(await captionsFor(deps(), effect.start, effect.end)).toBeNull();
  });
});
