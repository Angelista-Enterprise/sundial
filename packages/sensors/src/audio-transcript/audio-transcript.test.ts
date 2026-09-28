import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AudioTranscriptSensor } from './index.js';
import { AudioTranscriptTail } from './audio-transcript-capture.js';

let dir: string;
let file: string;

const line = (text: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ at: '2026-09-11T14:14:27.084Z', startedAt: '2026-09-11T14:14:27.054Z', offsetMs: 30, durationMs: 5439, language: 'dutch', text, noSpeechProb: 0.007, avgLogprob: -0.22, ...extra })}\n`;

const append = (blob: string) => fs.appendFileSync(file, blob);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnomon-audio-'));
  file = path.join(dir, 'audio-transcript.jsonl');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('AudioTranscriptTail', () => {
  it('starts at the END of an existing file, so a restart does not re-say the day', () => {
    append(line('Dit is gisteren gezegd.'));
    const tail = new AudioTranscriptTail(file);
    expect(tail.read()).toEqual([]);
    append(line('Dit is nu gezegd.'));
    expect(tail.read().map((l) => l.text)).toEqual(['Dit is nu gezegd.']);
  });

  it('does not adopt an offset before the file exists', () => {
    const tail = new AudioTranscriptTail(file);
    // The sidecar has not heard anything yet.
    expect(tail.read()).toEqual([]);
    // The first real file is still adopted from its end, not from the zero we
    // would otherwise have recorded while it was missing.
    append(line('Eerste zin.'));
    expect(tail.read()).toEqual([]);
    append(line('Tweede zin.'));
    expect(tail.read().map((l) => l.text)).toEqual(['Tweede zin.']);
  });

  it('reads every utterance written between two polls', () => {
    append(line('een'));
    const tail = new AudioTranscriptTail(file);
    tail.read();
    append(line('twee') + line('drie') + line('vier'));
    expect(tail.read().map((l) => l.text)).toEqual(['twee', 'drie', 'vier']);
  });

  // The defect this guards: a read landing mid-write consumed the half line,
  // failed to parse it, and advanced the cursor past it — losing the sentence.
  it('leaves a half-written line for the next poll instead of eating it', () => {
    append(line('compleet'));
    const tail = new AudioTranscriptTail(file);
    tail.read();

    const whole = line('de tweede helft komt later');
    const cut = Math.floor(whole.length / 2);
    append(whole.slice(0, cut));
    expect(tail.read()).toEqual([]);

    append(whole.slice(cut));
    expect(tail.read().map((l) => l.text)).toEqual(['de tweede helft komt later']);
  });

  it('adopts a truncated file instead of going blind forever', () => {
    append(line('voor') + line('rotatie'));
    const tail = new AudioTranscriptTail(file);
    tail.read();

    // Retention, a reset, or a fresh helper replaced the file.
    fs.writeFileSync(file, line('na rotatie'));
    expect(tail.read().map((l) => l.text)).toEqual(['na rotatie']);
  });

  it('skips a damaged line and keeps the good ones around it', () => {
    append(line('goed'));
    const tail = new AudioTranscriptTail(file);
    tail.read();
    append(`${line('eerste')}{not json at all}\n${line('laatste')}`);
    expect(tail.read().map((l) => l.text)).toEqual(['eerste', 'laatste']);
  });

  it('drops a line with no text rather than emitting an empty utterance', () => {
    append(line('start'));
    const tail = new AudioTranscriptTail(file);
    tail.read();
    append(`${JSON.stringify({ at: 'x', language: 'dutch' })}\n${line('   ')}${line('echt')}`);
    expect(tail.read().map((l) => l.text)).toEqual(['echt']);
  });
});

describe('AudioTranscriptSensor', () => {
  const spoken = (events: ReturnType<AudioTranscriptSensor['poll']>) => events.map((e) => e.payload.spokenText);

  it('is silent unless the owner turned hearing on', () => {
    append(line('iets'));
    const off = new AudioTranscriptSensor({ file });
    append(line('nog iets'));
    expect(off.poll()).toEqual([]);
  });

  it('emits one audio:transcript per utterance, as spokenText', () => {
    append(line('start'));
    const sensor = new AudioTranscriptSensor({ enabled: true, file });
    sensor.poll();
    append(line('Ik denk dat het wel zou moeten werken.'));

    const [event] = sensor.poll();
    expect(event.type).toBe('audio:transcript');
    expect(event.payload).toMatchObject({
      spokenText: 'Ik denk dat het wel zou moeten werken.',
      language: 'dutch',
      wordCount: 8,
      durationMs: 5439,
      offsetMs: 30,
    });
  });

  it('keeps whisper’s per-utterance language, so a Dutch standup is not read as English', () => {
    append(line('start'));
    const sensor = new AudioTranscriptSensor({ enabled: true, file });
    sensor.poll();
    append(line('Zowel als in Nederlands en Engels.') + line('Both of these work.', { language: 'english' }));
    expect(sensor.poll().map((e) => e.payload.language)).toEqual(['dutch', 'english']);
  });

  // The no-speech gate below still let ~800 inventions through on the live
  // record — Spanish, Portuguese, Russian, two dozen more, all confident. For
  // an owner who speaks two languages, a third is noise that learned grammar.
  it('drops an utterance in a language the owner does not speak, and keeps one with none', () => {
    append(line('start'));
    const sensor = new AudioTranscriptSensor({ enabled: true, file, languages: ['english', 'Dutch'] });
    sensor.poll();
    append(line('Ik denk het wel.') + line('Gracias por ver el video.', { language: 'spanish' }) + line('Fine by me.', { language: 'english' }) + line('Hmm, okay dan.', { language: '' }));
    expect(sensor.poll().map((e) => e.payload.spokenText)).toEqual(['Ik denk het wel.', 'Fine by me.', 'Hmm, okay dan.']);
  });

  // Whisper confabulates from a fan or a keyboard, and the fiction it produced
  // here ("음은데 음.", "Amanın diyor.") was as grammatical as the real speech.
  // Language cannot separate the two. Its own no-speech probability can.
  it('drops what whisper invented, and keeps what was actually said', () => {
    append(line('start'));
    const sensor = new AudioTranscriptSensor({ enabled: true, file });
    sensor.poll();
    append(
      line('Ik denk dat het wel zou moeten werken.') +
        line('음은데 음.', { language: 'korean', noSpeechProb: 0.93 }) +
        line('Amanın diyor.', { language: 'turkish', noSpeechProb: 0.71 }),
    );
    expect(spoken(sensor.poll())).toEqual(['Ik denk dat het wel zou moeten werken.']);
  });

  // The owner speaks Papiamento, which whisper does not support at all, so it
  // comes back labelled Spanish or Portuguese. A language allow-list would
  // delete the third language they speak; confidence keeps it.
  it('keeps confident speech whose language whisper got wrong', () => {
    append(line('start'));
    const sensor = new AudioTranscriptSensor({ enabled: true, file });
    sensor.poll();
    append(line('Bo ta papia papiamentu?', { language: 'spanish', noSpeechProb: 0.01 }));
    const [event] = sensor.poll();
    expect(event.payload.spokenText).toBe('Bo ta papia papiamentu?');
    // The label is wrong and is reported as whisper gave it — the sensor does
    // not guess a language whisper has no model for.
    expect(event.payload.language).toBe('spanish');
  });

  it('treats a line with no confidence field as confident, not as junk', () => {
    append(line('start'));
    const sensor = new AudioTranscriptSensor({ enabled: true, file });
    sensor.poll();
    // An older helper wrote no score. Absent evidence must not delete a real sentence.
    append(`${JSON.stringify({ at: 'x', startedAt: 'x', language: 'dutch', text: 'oude regel' })}\n`);
    expect(spoken(sensor.poll())).toEqual(['oude regel']);
  });

  it('carries the score onto the signal, so a reader can weigh it too', () => {
    append(line('start'));
    const sensor = new AudioTranscriptSensor({ enabled: true, file });
    sensor.poll();
    append(line('twijfelachtig', { noSpeechProb: 0.4 }));
    expect(sensor.poll()[0].payload.noSpeechProb).toBe(0.4);
  });

  it('carries which stream heard it, and nothing when an older helper did not say', () => {
    append(line('start'));
    const sensor = new AudioTranscriptSensor({ enabled: true, file });
    sensor.poll();
    append(line('from the call', { source: 'system' }) + line('from the room', { source: 'mic' }) + line('from before'));
    expect(sensor.poll().map((e) => e.payload.channel)).toEqual(['system', 'mic', undefined]);
  });

  it('ignores a one-character guess — a cough is not a word', () => {
    append(line('start'));
    const sensor = new AudioTranscriptSensor({ enabled: true, file });
    sensor.poll();
    append(line('a') + line('ja'));
    expect(spoken(sensor.poll())).toEqual(['ja']);
  });
});

describe('splitSpeakerTurns (J3.2 fallback)', () => {
  it('counts and strips the tinydiarize marker', async () => {
    const { splitSpeakerTurns } = await import('./index.js');
    expect(splitSpeakerTurns('Okay so the border. [_SPEAKER_TURN_] Yes I saw it. [SPEAKER_TURN] Good.')).toEqual({ text: 'Okay so the border. Yes I saw it. Good.', turns: 2 });
    expect(splitSpeakerTurns('Dutch as usual.')).toEqual({ text: 'Dutch as usual.', turns: 0 });
  });
});
