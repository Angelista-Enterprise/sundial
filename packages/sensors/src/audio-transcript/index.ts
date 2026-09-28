import { AudioTranscriptTail, type TranscriptLine } from './audio-transcript-capture.js';

export { AudioTranscriptTail, readAudioStatus, type AudioStatus, type TranscriptLine } from './audio-transcript-capture.js';

export interface AudioTranscriptEvent {
  type: 'audio:transcript';
  payload: Record<string, unknown>;
}

export interface AudioTranscriptSensorConfig {
  enabled?: boolean;
  /** Override the sidecar's transcript file. Tests supply a temp path. */
  file?: string;
  /** Override the invention threshold; see {@link MAX_NO_SPEECH_PROB}. */
  maxNoSpeechProb?: number;
  /** The owner's languages (whisper's names); anything else is an invention on noise and is dropped. Empty keeps all. */
  languages?: string[];
}

/** Shorter than this and it is a cough, a door, or half a word whisper guessed at. */
const MIN_CHARS = 2;

/**
 * Above this probability that the audio was not speech, the utterance is
 * dropped as something whisper invented.
 *
 * CONFIDENCE, not language, is the right axis here, and the owner is the reason.
 * They speak Dutch, English, and PAPIAMENTO — which whisper does not support at
 * all, so their Papiamento comes back labelled Spanish or Portuguese. An
 * allow-list of languages would delete the third language they speak, for ever,
 * while happily keeping an invented English sentence. Judging whether anyone
 * spoke keeps real speech in any language and drops fiction in all of them.
 *
 * 0.6 is deliberately generous. Real Dutch off this machine's microphone
 * measured 0.007, so the bar sits nowhere near genuine speech; the point is to
 * catch the confident nonsense whisper produces from a fan or a keyboard, not
 * to adjudicate a mumble. A false drop costs one sentence. A false keep puts
 * words in the owner's mouth and into core memory, which is the failure this
 * whole record exists to avoid.
 */
const MAX_NO_SPEECH_PROB = 0.6;

/**
 * Ambient hearing — one `audio:transcript` event per utterance the
 * `sundial-audio-helper` sidecar transcribed.
 *
 * Off unless `audio.enabled` in the owner's config, and a no-op off darwin: the
 * sidecar is macOS-only, so on any other platform the file this reads is never
 * written. The launcher gates SPAWNING the helper on the same flag, so the
 * disabled path captures nothing rather than capturing and discarding.
 *
 * `spokenText` is the field name on purpose. `sanitizeAtIngest` gives it the
 * secret-pattern pass, so a token or a key read aloud is redacted once, at
 * ingest, before it reaches the log — and every read path downstream trims an
 * already-safe value. Unlike `screenText` it is NOT cleared for a
 * sensitive/hidden frontmost app, because what a room sounds like is not a
 * property of which window is focused (see the sanitizer's own comment).
 *
 * The sensor deliberately holds no opinion about WHOSE voice it is. Neither
 * engine offers speaker separation — Apple's has no diarization at all and
 * whisper's is a separate model — so an utterance is recorded as something that
 * was said near this machine, and nothing here claims the owner said it.
 */
export class AudioTranscriptSensor {
  private readonly enabled: boolean;
  private readonly maxNoSpeechProb: number;
  private readonly languages: Set<string>;
  private readonly tail: AudioTranscriptTail;

  constructor(config: AudioTranscriptSensorConfig = {}) {
    this.enabled = config.enabled === true;
    this.maxNoSpeechProb = typeof config.maxNoSpeechProb === 'number' ? config.maxNoSpeechProb : MAX_NO_SPEECH_PROB;
    this.languages = new Set((config.languages ?? []).map((l) => l.toLowerCase()));
    this.tail = new AudioTranscriptTail(config.file);
  }

  poll(): AudioTranscriptEvent[] {
    if (!this.enabled || process.platform !== 'darwin') return [];
    return this.tail
      .read()
      .filter((line) => line.text.length >= MIN_CHARS && line.noSpeechProb <= this.maxNoSpeechProb && this.spoken(line.language))
      .map((line) => this.toEvent(line));
  }

  /** A language the owner speaks, or one whisper did not name. */
  private spoken(language: string | null | undefined): boolean {
    return this.languages.size === 0 || !language || this.languages.has(language.toLowerCase());
  }

  private toEvent(line: TranscriptLine): AudioTranscriptEvent {
    // J3.2 fallback: whisper.cpp tinydiarize marks a speaker change with a
    // token in the text. Counted and stripped; WHO spoke is not known, only
    // that the speaker changed this many times inside the utterance.
    const { text, turns } = splitSpeakerTurns(line.text);
    return {
      type: 'audio:transcript',
      payload: {
        ...(turns > 0 ? { speakerTurns: turns } : {}),
        timestamp: line.at,
        utteranceStartedAt: line.startedAt,
        offsetMs: line.offsetMs,
        durationMs: line.durationMs,
        // Whisper reports a language name per utterance; it is the one signal
        // that distinguishes a Dutch standup from an English one, and the
        // reason a single multilingual model was worth running locally.
        language: line.language,
        spokenText: text,
        wordCount: text.split(/\s+/).filter(Boolean).length,
        // Kept on the signal, not just used as a gate: a later reader deciding
        // how much to trust a sentence should be able to see the same number
        // this sensor judged it by.
        noSpeechProb: line.noSpeechProb,
        // A fact about the stream, not a claim about the speaker: `system` is
        // what the Mac played, `mic` what its microphone heard. Only a reader
        // that knows it was a call may turn that into "them" and "me".
        ...(line.channel ? { channel: line.channel } : {}),
      },
    };
  }
}

/** The tinydiarize marker, counted and removed. `[_SPEAKER_TURN_]` is whisper.cpp's token; the older `[SPEAKER_TURN]` is accepted too. */
export function splitSpeakerTurns(text: string): { text: string; turns: number } {
  const marker = /\[_?SPEAKER_TURN_?\]/g;
  const turns = (text.match(marker) ?? []).length;
  return { text: text.replace(marker, ' ').replace(/\s+/g, ' ').trim(), turns };
}
