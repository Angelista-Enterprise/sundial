// What a capture SHOWED, typed, read on this Mac from its lines (sanitized at
// ingest: one redaction pass, nothing re-derived here). This only names the parts a rule, the intent prompt and Gnomon's context can
// use as facts rather than as a blob of text:
//
//  - `ticket` / `pr`: the identifiers `screenRefs` already pulls out;
//  - `error`: the LAST error line in a terminal or an editor (a terminal's
//    newest line is its lowest), the one place an
//    error on screen is the owner's own (in a chat or a browser it is somebody's
//    message or a page about errors);
//  - `file`: source file names in an editor or a terminal;
//  - `call`: the window is a call, by app or by its controls;
//  - `person`: a name tile in a call window, at most three.
//
// Read over ALL the capture's lines, not only the ones `filterScreenLines` kept:
// a call's controls and name tiles sit still, so from the second capture on
// they are furniture, and a call would flicker in and out.
//
// The document title is not here: the window sensor reads it from
// Accessibility, exactly, and the moment already has it (`windowTitles`).
import type { ScreenFact } from '@sundial/kernel/types.js';
import { screenProfileFor, screenRefs } from './screen-text-filter.js';

export const MAX_FACTS_PER_CAPTURE = 8;
const MAX_FACT_CHARS = 160;
const MAX_FILES = 3;
const MAX_PEOPLE = 3;
const MAX_REFS = 4;

const CALL_APP = /zoom|teams|facetime|webex|whereby|around|tuple|gather|meet\b|google meet/i;
/** The buttons a call window draws. Two of them on one screen is a call, in any app (a browser tab of Meet). */
const CALL_CONTROLS = /^(mute|unmute|leave|leave call|end call|share screen|stop sharing|present now|participants|people|raise hand|turn (on|off) camera|start video|stop video|reactions|chat|more|captions|mic|camera)$/i;
const ERROR_LINE = /\b\w*(error|exception)\b|\b(failed|failure|fatal|panic|traceback|segfault|EADDRINUSE|ENOENT|command not found)\b/i;
const FILE_NAME = /\b[\w.-]+\.(ts|tsx|js|mjs|swift|py|rs|go|rb|java|kt|css|json|yml|yaml|md|sql)\b/g;
/** Two or three capitalized words, Dutch and German particles allowed between them: how a call tile names someone. */
const PERSON = /^(\p{Lu}[\p{Ll}'-]+)( (van|de|der|den|von|da|di|le|la|ten|ter|in 't|'t))*( \p{Lu}[\p{Ll}'-]+){1,2}$/u;

const clip = (s: string): string => (s.length > MAX_FACT_CHARS ? s.slice(0, MAX_FACT_CHARS) : s);

/** Whether a capture is a call: the app says so, or two of its lines are call controls. */
export function isCallScreen(lines: readonly string[], app: string | null | undefined): boolean {
  if (CALL_APP.test(app ?? '')) return true;
  return lines.filter((l) => CALL_CONTROLS.test(l.trim())).length >= 2;
}

/**
 * The typed facts of one capture, most useful first (error, call, people,
 * refs, files), deduplicated, at most `MAX_FACTS_PER_CAPTURE`. Pure.
 *
 * @param lines - the capture's lines (`rawLineSet`), sanitized.
 * @param app - bundle id or process name, for the profile.
 * @param label - what a `call` fact names: the process name when there is one.
 */
export function screenFactsOf(lines: readonly string[], app: string | null | undefined, label?: string | null): ScreenFact[] {
  const profile = screenProfileFor(app);
  const out: ScreenFact[] = [];
  const add = (kind: ScreenFact['kind'], value: string): void => {
    const v = clip(value.trim());
    if (v !== '' && !out.some((f) => f.kind === kind && f.value === v)) out.push({ kind, value: v });
  };
  const coding = profile === 'terminal' || profile === 'editor';
  const error = coding ? [...lines].reverse().find((l) => ERROR_LINE.test(l)) : undefined;
  if (error) add('error', error);
  if (isCallScreen(lines, app)) {
    add('call', label || app || 'call');
    let people = 0;
    for (const line of lines) {
      const l = line.trim();
      if (people >= MAX_PEOPLE) break;
      if (l.length <= 40 && PERSON.test(l) && !CALL_CONTROLS.test(l)) {
        add('person', l);
        people += 1;
      }
    }
  }
  for (const ref of screenRefs(lines, MAX_REFS)) add(ref.startsWith('#') ? 'pr' : 'ticket', ref);
  if (coding) {
    const files = new Set<string>();
    for (const line of lines) for (const m of line.matchAll(FILE_NAME)) if (files.size < MAX_FILES) files.add(m[0]);
    for (const f of files) add('file', f);
  }
  return out.slice(0, MAX_FACTS_PER_CAPTURE);
}

/** One line per fact for a prompt: `error: …`, `file: a.ts, b.ts`, kinds in first-seen order. */
export function describeScreenFacts(facts: readonly ScreenFact[]): string[] {
  const byKind = new Map<string, string[]>();
  for (const f of facts) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f.value]);
  return [...byKind].map(([kind, values]) => `${kind}: ${values.join(', ')}`);
}
