/**
 * Ported from WCS's `packages/helpers/src/window-classification.ts`, adapted
 * to take just a process name — Gnomon's `WindowRef` (packages/sensors/src/
 * window/window-capture.ts) doesn't carry a separate `windowClass` field
 * (Phase 1 trimmed it; the class info is folded into `windowId`'s prefix
 * instead). All apps below are identifiable by process name alone.
 */

export function isCodeEditor(processName: string): boolean {
  const p = processName.toLowerCase();
  return (
    p.includes('code') ||
    p.includes('cursor') ||
    p.includes('idea') ||
    p.includes('webstorm') ||
    p.includes('pycharm') ||
    p.includes('nvim') ||
    p.includes('vim')
  );
}

/** Used by `moment-kind.ts` (docs/design/06-macos-ui-data-wiring.md's Timeline `kind` classification) to derive a `browse` moment when nothing more specific (a meeting, a focus span, thrashing) applies. */
export function isBrowser(processName: string): boolean {
  const p = processName.toLowerCase();
  return p.includes('safari') || p.includes('chrome') || p.includes('firefox') || p.includes('arc') || p.includes('edge') || p.includes('brave') || p.includes('opera') || p.includes('vivaldi');
}

export function isTerminal(processName: string): boolean {
  const p = processName.toLowerCase();
  return (
    p.includes('terminal') ||
    p.includes('alacritty') ||
    p.includes('kitty') ||
    p.includes('wezterm') ||
    p.includes('ghostty') ||
    p.includes('foot') ||
    p.includes('warp') ||
    p.includes('iterm') ||
    p.includes('hyper') ||
    p.includes('tabby') ||
    p.includes('rio') ||
    p.includes('konsole') ||
    p.includes('tmux')
  );
}

/**
 * C17 — a native video/voice conferencing app. Google Meet is deliberately NOT
 * here: it runs inside a browser, so the process name is just the browser and it
 * is detected from the window title instead (`computeAudioContext`). Slack is
 * excluded too — it drives audio for a notification blip as readily as a huddle,
 * so counting it as a call is a false positive waiting to happen.
 */
export function isConferencingApp(processName: string): boolean {
  const p = processName.toLowerCase();
  return p.includes('zoom') || p.includes('webex') || p.includes('facetime') || p.includes('microsoft teams') || p.includes('discord');
}

/**
 * The hosts a call runs on in a browser. `isConferencingApp` covers the native
 * ones; this covers the tab, which is where most calls happen here — 194 visits
 * to `meet.google.com` in a fortnight, none of them attributable, because the
 * title is `Meet - uth-mkip-zwx` and the project is only knowable from the
 * calendar event running at the time.
 */
const CONFERENCING_HOSTS = /^(meet\.google\.com|teams\.(microsoft|live)\.com|.*\.zoom\.us|zoom\.us|whereby\.com|meet\.jit\.si|.*\.webex\.com|app\.gather\.town|.*\.around\.co)$/i;

/** Hosts that are the browser talking to itself, never a place. */
const NOT_A_PLACE = new Set(['newtab', 'new-tab-page', 'blank', 'extensions', 'settings', 'history', 'downloads', 'bookmarks']);

/**
 * `https://www.acme.atlassian.net/jira/...` → `acme.atlassian.net`; `http://localhost:8080/x` → `localhost:8080`.
 * Lower-cased, `www.` dropped, port kept (two dev servers are two places), browser-internal pages null.
 * The one host reader: the proposer and the rule matcher both call this, so they agree on what a host is.
 */
export function hostOf(url: string): string | null {
  const m = /^(https?):\/\/([^/?#\s]+)/i.exec(url);
  if (!m) return null;
  const host = m[2]!.toLowerCase().replace(/^www\./, '');
  const bare = host.replace(/:\d+$/, '');
  if (bare === '' || NOT_A_PLACE.has(bare)) return null;
  return host;
}

export function isConferencingHost(host: string | null | undefined): boolean {
  const bare = (host ?? '').trim().toLowerCase().replace(/:\d+$/, '');
  return bare !== '' && CONFERENCING_HOSTS.test(bare);
}

/**
 * Whether this window IS a call: the native app, or a browser on a call host.
 * A project rule that matches on the meeting only applies here, so a meeting
 * running in the background can never stamp the editor the owner is typing in.
 */
export function isConferencingSurface(processName: string, host: string | null | undefined): boolean {
  return isConferencingApp(processName) || (isBrowser(processName) && isConferencingHost(host));
}

/** C17 — a music/media player, the strongest "this is not a meeting" playback signal. */
export function isMusicApp(processName: string): boolean {
  const p = processName.toLowerCase();
  return p === 'music' || p.includes('spotify') || p.includes('itunes') || p.includes('vlc') || p.includes('soundcloud');
}

/**
 * Live-tested finding (2026-07-17): macOS reports `loginwindow` as the
 * frontmost "application" whenever the screen is locked or between
 * user sessions, and `ScreenSaverEngine` while the screensaver is active —
 * neither is a real window the user is looking at. Ported from WCS's
 * `SYSTEM_PROCESSES` set (`apps/daemon/src/daemon/index.ts`), found missing
 * here after live data showed 65 `loginwindow` "moments" in one day,
 * totaling ~2.45 hours, about to consume real LLM budget on lock-screen
 * periods. `momentClose` (packages/rules/src/moment-close.ts) uses this to
 * close the real moment being interrupted without opening a fake one for
 * the system process — the gap becomes a genuine "no moment open," not a
 * misleadingly-labeled session.
 */
const SYSTEM_PROCESSES = new Set(['loginwindow', 'ScreenSaverEngine']);

export function isSystemProcess(processName: string): boolean {
  return SYSTEM_PROCESSES.has(processName);
}

/**
 * The browser-profile name a window title carries, or `null`.
 *
 * macOS browsers append the active profile to every window title, so
 * `"GitHub - Google Chrome - Pat (Acme) (https://github.com/)"` names the
 * profile between the browser and the URL. That is the strongest work/leisure
 * signal in the data and it costs nothing to read — see `classifyActivity`.
 *
 * The trailing `(scheme://...)` group is stripped rather than assumed absent, and a
 * title whose last parenthesised group is NOT a URL — a filename like
 * `report (Acme).pdf` — must fall through to `null` rather than yield a phantom
 * profile. 9 of 6,707 browser titles in the reference corpus did exactly that.
 */
export function browserProfileFromTitle(windowTitle: string): string | null {
  const parts = windowTitle.split(/ - (?:Google Chrome|Chromium|Safari|Firefox|Arc|Microsoft Edge|Brave Browser) - /);
  if (parts.length < 2) return null;
  const tail = parts[parts.length - 1]!.replace(/\s*\((?:https?|chrome|devtools|file|about|localhost):[^)]*\)\s*$/i, '').trim();
  // A residual extension suffix means the parenthesised group was a filename, not a
  // URL, so this was never a profile segment.
  if (!tail || /\.[a-z0-9]{1,5}\)?$/i.test(tail)) return null;
  return tail.replace(/^[-\s]+|[-\s]+$/g, '') || null;
}

/** The host of the last URL in a window title, lowercased and `www.`-stripped, or `null`. */
/**
 * A window title with the application's own furniture removed.
 *
 * Every browser title on this machine ends ` - Google Chrome - Pat (Acme)`,
 * every Obsidian one ` - Acme - Obsidian 1.13.7`. Shown as evidence for "which
 * project was this?", that suffix is the same on every row and the part that
 * differs is buried. The app name and the profile are already known from the
 * process and the profile parser, so nothing is lost by dropping them.
 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** ` - Google Chrome`, ` - Obsidian 1.13.7`: an app's own suffix, with an optional version. Compiled once. */
const APP_SUFFIXES = ['Google Chrome', 'Safari', 'Arc', 'Firefox', 'Obsidian', 'Slack', 'Visual Studio Code', 'Code'].map(
  (name) => new RegExp(`\\s[-–—]\\s${escapeRe(name)}(\\s+[\\d.]+)?\\s*$`, 'i'),
);
/**
 * ` - Pat (Acme)`: a browser profile. The separator must be SPACED, so a
 * ticket key's own hyphen (`BOX-484 (in review)`) is never mistaken for one,
 * and it is only ever stripped from a browser's title.
 */
const PROFILE_SUFFIX = /\s[-–—]\s[^-–—()]{1,40}\s\([^()]{1,24}\)\s*$/u;

export function cleanWindowTitle(windowTitle: string, processName?: string): string {
  let title = windowTitle.trim();
  const app = (processName ?? '').trim();
  if (app === '' || isBrowser(app)) title = title.replace(PROFILE_SUFFIX, '');
  if (app !== '') title = title.replace(new RegExp(`\\s[-–—]\\s${escapeRe(app)}(\\s+[\\d.]+)?\\s*$`, 'i'), '');
  for (const suffix of APP_SUFFIXES) title = title.replace(suffix, '');
  return title.trim().replace(/\s*[-–—]\s*$/u, '').trim();
}

export function hostFromTitle(windowTitle: string): string | null {
  const matches = [...windowTitle.matchAll(/https?:\/\/([^/)\s]+)/gi)];
  const last = matches[matches.length - 1];
  return last ? last[1]!.toLowerCase().replace(/^www\./, '') : null;
}

/** Compiled once per pattern: the Habits card classifies ~28k titles per read, and recompiling per call was most of its time. */
const GLOBS = new Map<string, RegExp>();

/** `*` matches any run of characters; every other character is literal. */
function globMatches(pattern: string, value: string): boolean {
  let re = GLOBS.get(pattern);
  if (!re) {
    const escaped = pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    GLOBS.set(pattern, (re = new RegExp(`^${escaped}$`)));
  }
  return re.test(value.toLowerCase());
}

/**
 * Minimal structural view of `LeisureRules`, so this file stays free of a config
 * import (the same reason `ProjectRule` is duplicated).
 */
export interface ActivityTaxonomy {
  browserProfiles: Record<string, string>;
  domainOverrides: Partial<Record<string, string[]>>;
  processes: Partial<Record<string, string[]>>;
  excluded: string[];
}

export type ActivityClassification = 'work' | 'personal-work' | 'personal' | 'ambient' | 'unknown';

const CLASS_PRIORITY: ActivityClassification[] = ['work', 'personal-work', 'personal', 'ambient'];

/**
 * Which side of the work/rest line a window falls on.
 *
 * Order is the whole design, and each step earns its place from the reference
 * corpus:
 *
 * 1. **Excluded hosts** first. `*.edr-agent.example` carried 23 visits that were the
 *    company's security agent, not the owner — traffic that must never be
 *    classified at all rather than classified wrongly.
 * 2. **Process overrides**, since a native app's name is unambiguous when the owner
 *    has named it.
 * 3. **Domain overrides**, which beat the profile: the leisure profile still held
 *    `claude.ai` and `localhost:3000`, so a profile is a prior and not a verdict.
 *    This step is also what keeps `orchestra-site.nl` (31 visits) and
 *    `dribbble.com` (41) as WORK — both look like leisure and were client research,
 *    which is the trap a hand-written list falls into.
 * 4. **Browser profile**, the strongest single signal: 202 of 213 `youtube.com`
 *    visits sat in one profile.
 * 5. **Built-in predicates** for anyone: editors and terminals are work, music is
 *    ambient.
 * 6. **`unknown`** otherwise — never `personal`. A false "you had downtime"
 *    silently cancels a true "no downtime in eight days", so ambiguity has to fall
 *    to neither side.
 */
export function classifyActivity(processName: string, windowTitle: string, taxonomy: ActivityTaxonomy): ActivityClassification {
  const host = hostFromTitle(windowTitle);
  if (host && taxonomy.excluded.some((pattern) => globMatches(pattern, host))) return 'unknown';

  const process = processName.trim().toLowerCase();
  for (const klass of CLASS_PRIORITY) {
    if ((taxonomy.processes[klass] ?? []).some((name) => name.trim().toLowerCase() === process)) return klass;
  }

  if (host) {
    for (const klass of CLASS_PRIORITY) {
      if ((taxonomy.domainOverrides[klass] ?? []).some((pattern) => globMatches(pattern, host))) return klass;
    }
  }

  const profile = browserProfileFromTitle(windowTitle);
  if (profile) {
    const fromProfile = taxonomy.browserProfiles[profile];
    if (fromProfile && CLASS_PRIORITY.includes(fromProfile as ActivityClassification)) return fromProfile as ActivityClassification;
  }

  if (isCodeEditor(processName) || isTerminal(processName) || isConferencingApp(processName)) return 'work';
  if (isMusicApp(processName)) return 'ambient';
  return 'unknown';
}
