import { canonicalProjectName } from '@sundial/helpers/sundial-config.js';
import { hostOf, hostFromTitle, isConferencingSurface } from '@sundial/helpers/window-classification.js';
import { canonicalProjectRoot } from '@sundial/helpers/redact/redact-url.js';
import type { KernelState, ProjectRule, WindowAttribution } from '@sundial/kernel/types.js';

/**
 * Per-window project attribution — the single, pure resolver both
 * `windowTrack` (to set `state.window.attribution`) and `momentClose` (to
 * stamp a moment's `projectId`) call, so "which project is this window" is
 * decided in exactly one place.
 *
 * Detection (does a path live under a `.git`/`package.json` root?) is a
 * filesystem walk that happens in the `project` sensor and flows in as
 * `project:detected`; this function does NO I/O — it prefix-matches against
 * the already-populated `state.project.known` registry. A path not yet under
 * any known root resolves to `null` this pass and gets attributed one event
 * later, once the detection it triggered has folded into `known`.
 *
 * Priority (see docs plan): editor documentPath (certain) → terminal window
 * via the last-detected project (certain) → editor window title `"… — name"`
 * matching a known project (weak) → unattributed. Deliberately NO ambient
 * fallback for arbitrary apps: a browser/chat window with no locator stays
 * `null` rather than inheriting whatever project was last active — that
 * ambient stamping is exactly the bug this replaces.
 */

const UNATTRIBUTED: WindowAttribution = { projectId: null, source: null, confidence: null };

/**
 * Terminal emulators, by macOS `processName`. A terminal window's project is
 * wherever the shell last was — which `state.project.current` already tracks
 * (the `project` sensor detects it from `shell:command`/`git:status` cwd).
 */
const TERMINAL_PROCESSES = new Set(['Warp', 'iTerm2', 'iTerm', 'Terminal', 'Ghostty', 'Alacritty', 'kitty', 'WezTerm', 'Hyper', 'Tabby']);

/**
 * Coding-agent apps, by macOS `processName`. Such a window exposes no locator of
 * its own — Claude for Desktop reports no AX document and a window title that is
 * the constant `"Claude"` — but the agent records the directory it is working in,
 * which the `agent-session` sensor reads into `state.agent.session`.
 */
const AGENT_PROCESSES = new Set(['Claude']);

/** A sanitized value the sensor couldn't expose (sensitive process) — never a usable locator. */
function isUsablePath(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && value !== '[private]' && value !== '[hidden]';
}

function stripTrailingSlash(p: string): string {
  return p.endsWith('/') ? p.slice(0, -1) : p;
}

function isUnder(docPath: string, root: string): boolean {
  return docPath === root || docPath.startsWith(`${root}/`);
}

/**
 * Longest known root that `docPath` sits under (or equals). Returns the root's
 * id (== root path), or null.
 *
 * Matching is tried case-sensitively first and only then case-insensitively,
 * because the two sides of this comparison are canonicalized to different
 * degrees. A root has been through `fs.realpathSync.native`, so it carries the
 * true on-disk casing; a `documentPath` is whatever the editor reported, which
 * follows however the user opened the file. On a case-insensitive volume (the
 * APFS default) `~/projects/…` and `~/Projects/…` are one file, so an
 * exact-only compare silently failed to attribute the window and dropped it to
 * `null` — losing the strongest attribution signal there is to a casing
 * difference that means nothing.
 *
 * The exact pass runs first so that on a case-SENSITIVE volume, where two roots
 * really can differ only by case, the correct one still wins.
 */
export function longestPrefixRoot(known: KernelState['project']['known'], docPath: string): string | null {
  const roots = Object.keys(known);
  let best: string | null = null;
  for (const root of roots) {
    const r = stripTrailingSlash(root);
    if (isUnder(docPath, r)) {
      if (best === null || r.length > stripTrailingSlash(best).length) best = root;
    }
  }
  if (best !== null) return best;

  const lowerDoc = docPath.toLowerCase();
  for (const root of roots) {
    const r = stripTrailingSlash(root);
    if (isUnder(lowerDoc, r.toLowerCase())) {
      if (best === null || r.length > stripTrailingSlash(best).length) best = root;
    }
  }
  return best;
}

/** The trailing `"… — <folder>"` segment of an editor window title (em dash, as VSCode/Xcode format it), or null. */
function titleFolderName(title: string): string | null {
  if (!isUsablePath(title)) return null;
  const idx = title.lastIndexOf(' — ');
  if (idx === -1) return null;
  const name = title.slice(idx + 3).trim();
  return name.length > 0 ? name : null;
}

/** Prefix of the synthetic id minted for a rule-matched project with no filesystem root. */
const NAMED_PREFIX = 'named:';

/**
 * Known root whose project name matches `name` under canonical comparison
 * (casing/alias-collapsed, P1) — so a `title-folder` or `rule-match` name lands
 * on the same root a filesystem detection produced, instead of splitting into a
 * second project. Returns the root id, or null.
 *
 * A real filesystem root ALWAYS wins over a synthetic `named:<project>` one.
 * Both can be present at once — `projectRuleRegister` mints the synthetic id
 * the first time a rule matches a project the filesystem has not revealed yet,
 * and a later detection adds the real root beside it — and returning whichever
 * happened to be inserted first splits one project across two ids. Measured on
 * the live log after the detection stream was repaired: 36 moments landed on
 * `~/Projects/acme/puzzlebox-studio` while 17 more, matched by the very same
 * rules, landed on `named:puzzlebox-studio`, because the synthetic entry had
 * been registered a few milliseconds earlier. Preferring the real root is also
 * what makes the merge this function exists for actually hold: browser time
 * joins the repo rather than forking away from it.
 */
export function findKnownByName(known: KernelState['project']['known'], name: string, aliases: Record<string, string>): string | null {
  const target = canonicalProjectName(name, aliases);
  let synthetic: string | null = null;
  for (const [root, project] of Object.entries(known)) {
    if (canonicalProjectName(project.name, aliases) !== target) continue;
    if (!root.startsWith(NAMED_PREFIX)) return root;
    synthetic ??= root;
  }
  return synthetic;
}

/** Deterministic synthetic id for a rule-matched project that has no filesystem root (e.g. a browser-only project). Stable across runs so its moments and `projects` row agree. */
export function namedProjectId(canonicalName: string): string {
  return `${NAMED_PREFIX}${canonicalName}`;
}

/**
 * Owner-declared alias remap for a locator-resolved root. `projectAliases` says
 * "this project IS that project" (`wcs → gnomon`), and the rule-match and
 * title-folder tiers already honour it through `canonicalProjectName` — but the
 * locator tiers (editor-doc, shell-cwd, agent-session) resolved a root and
 * returned it as-is, so an agent session inside `~/Projects/doe/wcs`
 * stamped `wcs` moments the owner had explicitly declared to be `gnomon`, and no
 * config rule could override it (a `certain` locator outranks every rule).
 *
 * When this root's project name canonicalizes onto a DIFFERENT name and a real
 * (non-synthetic) known root carries that canonical name, resolve to that root;
 * otherwise keep the original. The remap only ever follows the owner's own alias
 * map — it is not an ambient guess, so it does not weaken a tier's `certain`
 * confidence.
 */
export function aliasedKnownRoot(known: KernelState['project']['known'], root: string, aliases: Record<string, string>): string {
  const entry = known[root];
  if (!entry) return root;
  const canonical = canonicalProjectName(entry.name, aliases);
  if (canonical === entry.name.trim().toLowerCase()) return root;
  for (const [r, p] of Object.entries(known)) {
    if (r === root || r.startsWith(NAMED_PREFIX)) continue;
    if (p.name.trim().toLowerCase() === canonical) return r;
  }
  return root;
}

/** Case-insensitive substring test used by rule matchers; a rule field is only tested when present. */
function containsCi(haystack: string, needle: string | undefined): boolean {
  if (!needle) return true; // absent matcher → not a constraint
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** True when a `documentPath` is a browser page URL rather than a local file reference. */
function isPageUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('file:');
}

/**
 * P1 — the first `projectRule` (config order) whose every present matcher holds
 * against this window. `titleContains` tests the title; `urlContains` tests the
 * page URL AND the title; `pathContains` tests `documentPath`; `gitBranch`
 * tests the current branch; `processIs` restricts to one process (exact, CI).
 *
 * `urlContains` used to test the title only, on the premise that a browser URL
 * rides in the title because Gnomon has no separate URL field. That premise no
 * longer holds — a browser window reports its page URL as `documentPath` (654
 * of 666 Chrome events in the live log carried one), and a title generally does
 * NOT contain the URL it came from, so host- and path-shaped rules never fired:
 * `github.com/Acme/puzzlebox-studio` against a title reading "… · Pull Request
 * #4435 · Acme/puzzlebox-studio - Google Chrome", `newsweb-daily.atlassian.net`
 * against a title with no host in it at all. The title is still tested as well,
 * so a rule written against the old behavior keeps matching and a page whose
 * URL the window never exposed is still reachable.
 */
export function matchProjectRules(rules: ProjectRule[], w: WindowLocatorInput, branch: string | null, meetingTitle?: string | null): ProjectRule | null {
  const title = isUsablePath(w.windowTitle) ? w.windowTitle : '';
  const docPath = isUsablePath(w.documentPath) ? w.documentPath : '';
  const url = docPath && isPageUrl(docPath) ? docPath : '';
  // A call, and the meeting the calendar says is running in it.
  const host = (url !== '' ? hostOf(url) : null) ?? hostFromTitle(title);
  const inCall = isConferencingSurface(w.processName, host);
  const meeting = typeof meetingTitle === 'string' ? meetingTitle : '';
  for (const rule of rules) {
    if (rule.processIs && rule.processIs.toLowerCase() !== w.processName.toLowerCase()) continue;
    // Only inside a call window, and only when a meeting is actually running:
    // otherwise a standing invite would claim every window of the hour.
    if (rule.meetingContains && !(inCall && containsCi(meeting, rule.meetingContains))) continue;
    if (!containsCi(title, rule.titleContains)) continue;
    if (!(containsCi(url, rule.urlContains) || containsCi(title, rule.urlContains))) continue;
    if (rule.pathContains && !(docPath && containsCi(docPath, rule.pathContains))) continue;
    if (rule.gitBranch && !(branch && containsCi(branch, rule.gitBranch))) continue;
    return rule;
  }
  return null;
}

/**
 * The meeting in progress, from the slice that survives moment boundaries.
 *
 * Read off `state.moment.rollup.meetingTitle` at first, which was wrong in the
 * one case that mattered: `momentClose` folds before `windowTrack`, so on the
 * window change that enters a call the moment has just been re-opened with a
 * blank title and the rule matched nothing for the entire call.
 */
export function activeMeetingTitle(state: KernelState): string | null {
  return state.schedule.active?.title ?? null;
}

export interface WindowLocatorInput {
  processName: string;
  windowTitle: string;
  documentPath?: string | null;
}

export function resolveAttribution(state: KernelState, w: WindowLocatorInput): WindowAttribution {
  const known = state.project.known;
  const aliases = state.config.projectAliases;

  // 1. Editor documentPath under a known root — the strongest signal. The
  //    docPath is canonicalized the same way project ids are, so the prefix
  //    match holds regardless of redaction tier (known roots are `~`-form;
  //    a tier-1 absolute docPath would otherwise never match).
  if (isUsablePath(w.documentPath)) {
    const root = longestPrefixRoot(known, canonicalProjectRoot(w.documentPath));
    if (root) return { projectId: aliasedKnownRoot(known, root, aliases), source: 'editor-doc', confidence: 'certain' };
  }

  // 2. Terminal window — the shell's project, tracked in `current`.
  if (TERMINAL_PROCESSES.has(w.processName) && state.project.current) {
    return { projectId: aliasedKnownRoot(known, state.project.current.id, aliases), source: 'shell-cwd', confidence: 'certain' };
  }

  // 3. Coding-agent window — the directory the agent's OWN active session
  //    records itself as working in. Deliberately NOT `state.project.current`:
  //    that is a damped ambient pointer, and stamping it onto an app with no
  //    locator is precisely the bug `no-ambient-project-attribution` closed. The
  //    session cwd is a real locator, resolved through the same registry
  //    prefix-match as `editor-doc`, so it earns the same `certain` confidence.
  //    `agentSessionTrack` clears the slice when no session has been written to
  //    recently, so an idle agent attributes nothing rather than the last
  //    project the owner happened to code in.
  if (AGENT_PROCESSES.has(w.processName) && state.agent.session) {
    const root = longestPrefixRoot(known, canonicalProjectRoot(state.agent.session.cwd));
    if (root) return { projectId: aliasedKnownRoot(known, root, aliases), source: 'agent-session', confidence: 'certain' };
  }

  // 3. P1 — user project rules. Fills the gap the filesystem locators can't:
  //    browser/chat windows (localhost, staging hosts, PR/ticket URLs) with no
  //    documentPath and no terminal cwd. A rule's `project` resolves to the
  //    matching known root when one exists (so browser time MERGES with the
  //    filesystem-detected repo, canonical-name compared), else to a stable
  //    synthetic `named:<canonical>` id that `projectRuleRegister` gives a
  //    `projects` row. Confidence is the rule's (default `weak`).
  const branch = state.project.current?.id ? (known[state.project.current.id]?.branch ?? null) : null;
  const rule = matchProjectRules(state.config.projectRules, w, branch, activeMeetingTitle(state));
  if (rule) {
    const canonical = canonicalProjectName(rule.project, aliases);
    const root = findKnownByName(known, rule.project, aliases);
    return { projectId: root ?? namedProjectId(canonical), source: 'rule-match', confidence: rule.confidence ?? 'weak' };
  }

  // 4. Editor window with no documentPath but a "file — folder" title that
  //    names a known project (e.g. VSCode's Welcome tab). Weak: a folder
  //    basename can collide across roots.
  const folder = titleFolderName(w.windowTitle);
  if (folder) {
    const root = findKnownByName(known, folder, aliases);
    if (root) return { projectId: root, source: 'title-folder', confidence: 'weak' };
  }

  return UNATTRIBUTED;
}
