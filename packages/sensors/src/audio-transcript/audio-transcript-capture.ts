import fs from 'node:fs';
import { getSundialHome } from '@sundial/helpers/config.js';
import path from 'node:path';

/** One utterance as `sundial-audio-helper` wrote it. */
export interface TranscriptLine {
  /** When this segment was spoken (utterance start + its offset). */
  at: string;
  /** When the utterance this segment belongs to began. */
  startedAt: string;
  /** Offset of this segment inside its utterance. */
  offsetMs: number;
  durationMs: number;
  /** Whisper's own detection, per utterance — `dutch`, `english`, … */
  language: string;
  text: string;
  /**
   * Whisper's own probability that this segment was NOT speech. The honest
   * signal for "did anyone actually say this": real Dutch off this machine's
   * microphone measured 0.007, while the Korean and Turkish sentences it
   * invented out of room noise sit far higher.
   */
  noSpeechProb: number;
  /** Mean token log-probability — how sure it was of the WORDS, once it decided there were words. */
  avgLogprob: number;
  /** Which stream heard it: the microphone, or what the Mac played (the far side of a call). Absent from older helpers. */
  channel?: 'mic' | 'system';
}

function defaultPath(): string {
  return path.join(getSundialHome(), '.daemon', 'audio-transcript.jsonl');
}

/**
 * Tails the transcript the audio sidecar appends to, by byte offset.
 *
 * A snapshot file cannot carry this. Every other sidecar publishes a STATE —
 * the focused window, whether the mic is on — where last-value-wins is exactly
 * right and a missed poll costs nothing. Speech is a sequence of events: two
 * sentences between polls are two things that were said, and a reader that only
 * ever sees the newest would silently drop the first. So the sidecar appends and
 * this holds a cursor, the same shape the shell sensor uses for its hook file.
 *
 * Two things the shell sensor's version does not do, both of which lose an
 * utterance rather than a shell command, and both cheap to get right:
 *
 * 1. **A truncated file is adopted, not ignored.** `size < offset` means the
 *    file was rotated or cleared underneath us (retention, a reset, a fresh
 *    helper). Holding the old cursor would mean never reading it again; the
 *    cursor goes back to zero instead.
 * 2. **A partial last line is left alone.** The sidecar appends whole lines but
 *    a read can still land mid-write. Consuming to the end of the buffer would
 *    hand `JSON.parse` half an object, skip it as malformed, and advance the
 *    cursor past it — losing the utterance permanently. This stops at the last
 *    newline and leaves the remainder for the next poll.
 */
export class AudioTranscriptTail {
  private readonly file: string;
  private offset = 0;
  private adopted = false;

  constructor(file: string = defaultPath()) {
    this.file = file;
  }

  /** The file this tail reads, for diagnostics. */
  get filePath(): string {
    return this.file;
  }

  /**
   * Start at the END of whatever already exists.
   *
   * Boot is not the moment to replay every sentence in the file: the kernel
   * folds what this emits, and a restart would re-log a whole day of speech as
   * if it had just been said. The durable log already holds the earlier ones.
   */
  private adopt(size: number): void {
    this.offset = size;
    this.adopted = true;
  }

  read(): TranscriptLine[] {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      // No file yet: the sidecar has not heard anything, or is not running.
      // Do not adopt — the first real file should be read from its end, not
      // from a zero we happened to record before it existed.
      return [];
    }

    if (!this.adopted) {
      this.adopt(size);
      return [];
    }
    if (size < this.offset) this.offset = 0;
    if (size === this.offset) return [];

    let buffer: Buffer;
    try {
      const fd = fs.openSync(this.file, 'r');
      try {
        const length = size - this.offset;
        buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, this.offset);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return [];
    }

    const text = buffer.toString('utf-8');
    const lastBreak = text.lastIndexOf('\n');
    if (lastBreak < 0) return []; // Nothing complete yet; keep the cursor.
    this.offset += Buffer.byteLength(text.slice(0, lastBreak + 1), 'utf-8');

    const out: TranscriptLine[] = [];
    for (const line of text.slice(0, lastBreak).split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Partial<TranscriptLine> & { source?: unknown };
        const source = entry.source;
        if (typeof entry.text !== 'string' || entry.text.trim() === '') continue;
        out.push({
          at: typeof entry.at === 'string' ? entry.at : new Date().toISOString(),
          startedAt: typeof entry.startedAt === 'string' ? entry.startedAt : (entry.at ?? new Date().toISOString()),
          offsetMs: typeof entry.offsetMs === 'number' ? entry.offsetMs : 0,
          durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : 0,
          language: typeof entry.language === 'string' ? entry.language : 'unknown',
          text: entry.text.trim(),
          // A line written before the helper carried these (or by an older
          // helper) reads as confident, not as junk: absent evidence must not
          // retroactively delete a sentence the owner really said.
          noSpeechProb: typeof entry.noSpeechProb === 'number' ? entry.noSpeechProb : 0,
          avgLogprob: typeof entry.avgLogprob === 'number' ? entry.avgLogprob : 0,
          ...(source === 'mic' || source === 'system' ? { channel: source } : {}),
        });
      } catch {
        // Malformed line — the sidecar writes JSON per line, so this is a
        // damaged write rather than a format we should try to understand.
      }
    }
    return out;
  }
}

/** The sidecar's own report: listening, denied, no model, and the learned noise floor. */
export interface AudioStatus {
  state: string;
  detail?: string;
  noiseFloor?: number;
  lastRms?: number;
  lastLanguage?: string;
  lastUtteranceAt?: string;
  at?: string;
}

export function readAudioStatus(file = path.join(getSundialHome(), '.daemon', 'audio-status.json')): AudioStatus | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as AudioStatus;
    return typeof parsed?.state === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
