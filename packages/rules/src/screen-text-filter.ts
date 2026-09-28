// What of a screen capture is content, decided in TypeScript, per application.
//
// Until 2026-09-04 this decision lived in the Swift helper's `usefulLines`: one
// filter over every capture, tuned for prose, that dropped anything under 40%
// alphanumeric — which is code, stack frames, file paths and ticket ids, i.e.
// the parts of a developer's screen worth having — and capped at 40 lines with
// no record of what fell off (17% of captures hit the cap). Nothing downstream
// could measure any of that because the discarded lines never existed
// (`enhancements/auditable-ocr-extraction`).
//
// The helper now writes what Vision read. The signal holds that, sanitized
// (`screenText`), under its own short retention; THIS decides what reaches the
// moment. A filter change is a TypeScript edit; a filter variant can be tested
// against recorded captures; and the application's identity is consulted,
// which is what `enhancements/per-app-visual-context-extraction` asked for:
//
//  1. what to DROP — box glyphs, log timestamps in a console (but not in a
//     chat, where the timestamp IS the content), line-number gutters in an
//     editor, a density threshold that is lower where text is code;
//  2. what to KEEP REGARDLESS — ticket ids, PR numbers, URLs, file paths,
//     error strings, stack frames: the tokens a density test kills first;
//  3. what is FURNITURE — a line present in the previous capture of the same
//     app is chrome (tab strip, sidebar, status bar), learned rather than listed.

export type ScreenProfile = 'terminal' | 'editor' | 'browser' | 'chat' | 'generic';

const TERMINAL = /warp|terminal|iterm|kitty|alacritty|ghostty|wezterm|hyper/i;
const EDITOR = /visual studio code|vscode|\bcode\b|cursor|xcode|zed|sublime|nova|intellij|webstorm|pycharm|neovim|vim/i;
const BROWSER = /chrome|safari|arc\b|firefox|brave|edge|vivaldi|orion/i;
const CHAT = /slack|teams|whatsapp|messages|signal|telegram|discord|mail|outlook/i;

/** Which profile an app falls under, from its bundle id or process name. */
export function screenProfileFor(app: string | null | undefined): ScreenProfile {
  const name = (app ?? '').toLowerCase();
  if (name === '') return 'generic';
  if (TERMINAL.test(name)) return 'terminal';
  if (EDITOR.test(name)) return 'editor';
  if (BROWSER.test(name)) return 'browser';
  if (CHAT.test(name)) return 'chat';
  return 'generic';
}

/** Minimum share of non-whitespace characters that must be letters or digits. */
const DENSITY: Record<ScreenProfile, number> = {
  terminal: 0.3,
  editor: 0.25,
  browser: 0.4,
  chat: 0.4,
  generic: 0.4,
};

export const MAX_KEPT_LINES = 40;
export const MAX_LINE_CHARS = 200;
const MIN_LINE_CHARS = 5;

/** Frames and blocks a TUI or a toolbar draws, which Vision reads as text lines. */
const BOX_GLYPHS = /^[\s─═╌┄┈│┃┌┐└┘├┤┬┴┼╭╮╯╰╔╗╚╝╠╣╦╩╬▁▂▃▄▅▆▇█▏▎▍▌▋▊▉·•|_\-=+*~^`'".,:;<>\\/[\](){}]*$/u;
const LEADING_TIMESTAMP = /^\d{1,2}:\d{2}(:\d{2})?\b/;
const LINE_NUMBER_GUTTER = /^\d{1,5}\s+(?=\S)/;

/**
 * The lines a density test would kill first and a reader wants most. Matched on
 * the trimmed line; a match bypasses every drop rule but the size bounds.
 */
const KEEP_REGARDLESS: RegExp[] = [
  /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/, // ticket ids: PBX-689, BOX-508
  /(^|\s)#\d{2,6}\b/, // PR / issue numbers
  /https?:\/\/\S+/i, // URLs
  /(^|\s)(~|\.{1,2})?(\/[\w.@-]+){2,}(:\d+)?/, // file paths, with optional :line
  /\b\w+\.(ts|tsx|js|mjs|swift|py|rs|go|rb|java|kt|css|json|yml|yaml|md|sql)(:\d+)?\b/, // bare file names
  /\w*(error|exception)\b|\b(failed|failure|fatal|panic|traceback|warning|denied|timeout|EADDRINUSE|ENOENT|segfault)\b/i, // TypeError, IOException, failed…
  /^\s*at \S+ \(/, // stack frames
];

export function isKeepRegardless(line: string): boolean {
  return KEEP_REGARDLESS.some((pattern) => pattern.test(line));
}

export interface ScreenFilterResult {
  kept: string[];
  /** Raw lines seen, after trimming and size bounds — the denominator for an audit. */
  total: number;
  /** Dropped because the previous capture of the same app had the same line. */
  furniture: number;
  /** Dropped by the shape rules (glyphs, timestamps, density). */
  noise: number;
}

/**
 * @param rawText - the capture as the helper wrote it, one line per Vision observation.
 * @param app - bundle id or process name, for the profile.
 * @param previousLines - the previous capture's raw lines for the SAME app, or empty.
 */
export function filterScreenLines(rawText: string, app: string | null | undefined, previousLines: ReadonlySet<string> = new Set()): ScreenFilterResult {
  const profile = screenProfileFor(app);
  const density = DENSITY[profile];
  const seen = new Set<string>();
  const kept: string[] = [];
  let total = 0;
  let furniture = 0;
  let noise = 0;

  for (const raw of rawText.split('\n')) {
    let line = raw.trim();
    if (line.length < MIN_LINE_CHARS) continue;
    if (line.length > MAX_LINE_CHARS) line = line.slice(0, MAX_LINE_CHARS);
    if (profile === 'editor') line = line.replace(LINE_NUMBER_GUTTER, '');
    if (seen.has(line)) continue;
    seen.add(line);
    total += 1;

    const keep = isKeepRegardless(line);
    if (!keep && previousLines.has(line)) {
      furniture += 1;
      continue;
    }
    if (!keep) {
      if (BOX_GLYPHS.test(line)) {
        noise += 1;
        continue;
      }
      // A timestamp opens a log line in a console and a message in a chat; only
      // the first is furniture.
      if (profile !== 'chat' && LEADING_TIMESTAMP.test(line)) {
        noise += 1;
        continue;
      }
      const dense = line.replace(/\s+/g, '');
      const alphanumeric = (dense.match(/[\p{L}\p{N}]/gu) ?? []).length;
      if (dense.length === 0 || alphanumeric / dense.length < density) {
        noise += 1;
        continue;
      }
    }
    if (kept.length < MAX_KEPT_LINES) kept.push(line);
  }
  return { kept, total, furniture, noise };
}

/** The raw lines of a capture as a set, for the next capture's furniture test. Bounded. */
const TICKET_REF = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;
const PR_REF = /(?:^|\s)(#\d{2,6})\b/g;
export const MAX_SCREEN_REFS = 8;

/**
 * The identifiers in a set of kept lines: ticket keys and PR numbers, first
 * seen first, capped. These are the tokens `KEEP_REGARDLESS` exists to save;
 * naming them lets the rest of the system use them as references rather than
 * as text.
 */
export function screenRefs(lines: readonly string[], max = MAX_SCREEN_REFS): string[] {
  const out: string[] = [];
  for (const line of lines) {
    for (const match of line.matchAll(TICKET_REF)) if (!out.includes(match[0])) out.push(match[0]);
    for (const match of line.matchAll(PR_REF)) if (!out.includes(match[1]!)) out.push(match[1]!);
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

export function rawLineSet(rawText: string, max = 300): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawText.split('\n')) {
    const line = raw.trim();
    if (line.length < MIN_LINE_CHARS || seen.has(line)) continue;
    seen.add(line);
    out.push(line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line);
    if (out.length >= max) break;
  }
  return out;
}
