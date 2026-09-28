import { withPersona } from '@sundial/kernel/persona.js';
import type { Rule } from '@sundial/kernel/types.js';
import { closingMomentRow } from './moment-close.js';

/** Below this there is nothing to clean — a few words of speech read the same either way. */
const MIN_SPOKEN_CHARS = 80;
/** The same ten seconds `momentAnalysisSchedule` waits, for the same reason: the close is not the last word. */
const CLEAN_DELAY_MS = 10_000;

/**
 * Tidy up what ambient hearing wrote down, WITHOUT replacing it.
 *
 * `spokenExcerpt` is a local speech model's best guess at a room, and it reads
 * like one: no punctuation, run-on, the odd word plainly wrong. The audit found
 * the owner's most valuable evidence sitting inside it — "dictate right now what
 * I'm saying and it'll just pick it up and keep that into its memory" — and
 * asked for a cleaned copy shown by default, with the raw one a toggle away.
 *
 * The rule the owner set, and the reason this is a separate field rather than a
 * rewrite of `spokenExcerpt`: **the raw capture stays the source of truth until
 * they accept the clean one.** A transcript is evidence. A model that tidies
 * evidence in place has destroyed the thing the evidence was for, and it only
 * takes one confident correction of a word that was right for the record to
 * start lying in the owner's own voice. So both are kept, the clean one is
 * marked as a reading until accepted, and `moment:transcript-accepted` is the
 * owner saying which one they trust.
 *
 * Runs on the same triggers as `momentAnalysisSchedule` and under the same
 * ordering requirement: it reads `state.moment` before `momentClose` overwrites
 * it for this event.
 */
export const transcriptClean: Rule = (state, event) => {
  const closed = closingMomentRow(state, event);
  if (!closed || !state.moment) return { state, effects: [] };

  const spoken = state.moment.rollup.spokenExcerpt;
  if (typeof spoken !== 'string' || spoken.trim().length < MIN_SPOKEN_CHARS) return { state, effects: [] };
  // Already redacted at ingest, so a private capture never reaches a prompt.
  if (spoken.includes('[private]') || spoken.includes('[REDACTED]')) return { state, effects: [] };

  const languages = state.moment.rollup.spokenLanguages ?? [];

  return {
    state,
    effects: [
      {
        type: 'ScheduleLLM',
        purpose: 'transcript',
        momentId: closed.id,
        delayMs: CLEAN_DELAY_MS,
        messages: [
          {
            role: 'system',
            content: withPersona(
              'You are cleaning up a speech-to-text capture so a person can read it back.',
              'Return ONLY the cleaned text. Add sentence breaks and punctuation, drop filler and stutters, and repair words the recogniser clearly misheard where the sentence makes the intended word obvious.',
              // The failure that matters is not an untidy transcript; it is a
              // tidy one that says something the owner did not. Everything here
              // is aimed at that.
              'Change NOTHING else. Do not translate, summarise, shorten, complete an unfinished sentence, or add a word the speaker did not say. Keep every name, number and quantity exactly as captured, even when one looks wrong. If a stretch is too garbled to be sure of, leave it exactly as it is rather than guessing. If the whole capture is unintelligible, return it unchanged.',
            ),
          },
          {
            role: 'user',
            content: `${languages.length ? `Spoken in: ${languages.join(', ')}.\n` : ''}Capture:\n${spoken}`,
          },
        ],
      },
    ],
  };
};

/**
 * The owner saying which copy they trust.
 *
 * `moment:transcript-accepted { momentId }`, from the Accept button on the
 * moment page. Its own signal rather than a `feedback:verdict`: a verdict on a
 * moment says the MOMENT was useful, and stapling a second meaning onto it
 * would make both unreadable a month from now. This says one thing.
 *
 * Nothing is deleted when it lands. The raw capture stays exactly where it is,
 * because the owner accepting a cleaner reading is not the same as the room
 * having been quieter than it was; `accepted` only changes which one the page
 * shows first.
 */
export const transcriptAccept: Rule = (state, event) => {
  if (event.type !== 'moment:transcript-accepted') return { state, effects: [] };
  const { momentId } = event.payload as { momentId?: unknown };
  if (typeof momentId !== 'string' || momentId === '') return { state, effects: [] };
  return { state, effects: [{ type: 'UpdateMomentData', momentId, patch: { spokenCleanAccepted: true } }] };
};
