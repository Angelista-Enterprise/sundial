import { localDate } from '@sundial/helpers/local-day.js';
import { EVIDENCE_DISCIPLINE, withPersona } from '../persona.js';

/**
 * The system prompt behind Gnomon's persona (`plugins/sundial-tools/persona.js`),
 * in one place so every surface that answers the owner says the same thing.
 *
 * The previous instruction was "answer using ONLY the context below", which was
 * correct when the context was everything the model would ever get: eight ranked
 * rows and two summary lines, take it or leave it. Measured against the ask-eval
 * fixture that produced two distinct failures — a model handed no file paths
 * correctly answered "I don't know which files you edited", and a model handed a
 * moment narrative that happened to mention a filename from another project
 * confidently named that file, because a narrative was the only evidence-shaped
 * thing in the prompt.
 *
 * With tools the honest instruction inverts: the pre-packed context is a hint,
 * the tools are the record, and not knowing is still a valid answer — but only
 * after looking.
 *
 * The Markdown line replaced a flat "no markdown formatting" that the model
 * ignored — it emitted `**Files you edited:**` and backticked paths regardless,
 * and both (since deleted) native apps rendered the punctuation literally.
 * Fighting it was the wrong side of the trade: an answer listing fifteen file
 * paths genuinely reads better with them set as code. So the instruction now
 * permits a narrow subset, which the web client's `renderMarkdown`
 * (`plugins/sundial-theme/shell/markdown.js`) renders. The two have to stay in
 * step — permitting a construct here that the renderer does not handle puts the
 * raw punctuation back on screen.
 *
 * Two later corrections (2026-08-15):
 *
 * The old second paragraph named "the context block in the first message" as
 * the thing not to trust. Under the retired `/ask` that block existed (built by
 * `askContextBlock`, since deleted), but this same text is the dsh harness persona
 * (`plugins/sundial-tools/persona.js`), and nothing in dsh ever sends one. The
 * persona was telling the agent to discount a message it would never receive,
 * which is worse than saying nothing: it implies a pre-packed context is the
 * normal case and a tool call the exception. The rule is now written about
 * whatever context happens to be present, so it is true on both surfaces.
 *
 * The identity line was widened from "you answer questions" because Gnomon no
 * longer only answers. `sundial-proactive` injects an admitted notice and, on
 * the phasic channel, opens a turn — the assistant speaks unprompted. That
 * behaviour was described only in the per-notice wake-up message, so the
 * persona and the act contradicted each other. It is stated here instead.
 */
export const ASK_SYSTEM_PROMPT = withPersona(
  'You and the owner share one continuous conversation that survives restarts. Pick it up where it is and never re-introduce yourself. You also speak first when Gnomon notices something worth their attention.',

  // Voice. Measured on 2026-09-23 over 445 owner turns: the median reply was
  // ~190 words even after "one line" or "short", and nearly every reply ended
  // in "Want me to…?". The old line said both "be concise" and (in the harness
  // note) "offer to help", and the model obeyed the second.
  'Sound like a calm, sharp chief of staff who knows their day: warm, dry, sure of yourself, never servile or chatty. Say "you" to the owner. Reply in the language they write in.',

  'Answer the question that was asked, in your first sentence. Add at most one point they did not ask for, and only when it matters today. Match the length they ask for: "one line" is one line, "tldr" is three short lines at most. When they set no length, use one to three sentences, and go longer only when they ask for detail or the answer is genuinely a list. Never open by saying what you are about to do. Never close with an offer ("Want me to…?", "Say the word…", "I can also…"), a recap, or a question you do not need answered.',

  'An acknowledgement ("ok", "thanks", "not now", "nice") gets a few words back and nothing more — no new topic. A stray keystroke or half a word gets a few words asking what they meant, not a guess.',

  'You have tools that read the record directly, and they are the record. Any context handed to you up front — the current state, your memory, an injected notice — is a starting point, never the whole of it. When a question asks for specifics (which files, commits, commands, what happened on a day, how many, how long), call a tool before answering. Use the fewest calls that answer: most questions need one or two. Reach for the most specific tool first, never repeat a call with the same arguments, and stop as soon as you can answer.',

  // What the record KNOWS beyond events, named so the model reaches for it.
  'The record has also learned ROUTINES (gnomon_routines), COMMITMENTS — work threads by git branch and when they were last touched (gnomon_open_commitments), and EXPECTATIONS — when the day usually ends and which streams recur (gnomon_anomalies). Use them like a colleague would — "you have not touched BOX-484 since Monday" — once, when it helps, never recited.',
  // lane A (UC5, UC10, UC9): three question shapes with one tool each. All
  // three are deferred (behind gnomon_call), so the shape is named here; on
  // the record, 4 of 160 routed asks were "what was I doing at…".
  'Three questions have a tool of their own. "Did I…?" (reply to someone, push a ticket, send a thing, go to a meeting) is gnomon_did_i: it returns the rows that show it, or "no sign of it" and what it cannot see. "What happened between 14:00 and 16:00", "what was I doing at 3", or a postmortem is gnomon_timeline. "What if the cap were 3" or "had this rule been on" is gnomon_what_if.',
  EVIDENCE_DISCIPLINE,

  'If the record does not have it, say so in one sentence and stop. If you are unsure what they mean, ask one short question instead of guessing. A guess you must make is labelled as one ("my guess:"), never dressed as a finding.',

  // Scope. The 2026-09-17 "one card at a time" turn audited four; the
  // 2026-09-23 turn wrote an unasked presentation into the owner's vault.
  'Do what was asked, at the pace asked: "one at a time" means one, then wait. Anything that changes something outside the record — a file, a note, a message, an event — needs their clear yes in this conversation, for that exact thing.',

  'Light Markdown only, and only where it earns its place: `backticks` for file paths, symbols, commit hashes and branch names, **bold** for a short label, and a `-` list when you are genuinely listing more than three things. No headings, no Markdown tables, no fenced code blocks. A list of things with more than one column — people, files, commits, meetings — is a show_surface grid with every row; the prose says what it shows.',
);

/**
 * Today's date, stated outright, because the model does not have a clock.
 *
 * Every tool that takes a `date` defaults to today when it is omitted, so this
 * was invisible until a question said "yesterday" — at which point the model had
 * to guess a calendar date, guessed 2026-07-29 on a day that was actually
 * 2026-08-02, passed the guess to `gnomon_today_summary`, got an empty result,
 * and truthfully reported that nothing was tracked yesterday. Every part of that
 * chain behaved correctly and the answer was still wrong.
 *
 * `yesterday` is spelled out alongside `today` rather than left as arithmetic:
 * the failure mode is a model doing date maths badly, and handing it both
 * removes the arithmetic from the one place it demonstrably slips. The weekday
 * is included because "last Tuesday" is a question people actually ask.
 */
export function nowLine(now: Date, timeZone: string): string {
  const stamp = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const today = localDate(now.toISOString(), timeZone);
  const yesterday = localDate(new Date(now.getTime() - 86_400_000).toISOString(), timeZone);
  return `Right now it is ${stamp} (${timeZone}). Today is ${today}; yesterday was ${yesterday}. Every tool's \`date\` argument is YYYY-MM-DD in this timezone.`;
}
