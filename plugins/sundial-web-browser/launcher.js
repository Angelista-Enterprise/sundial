// Get a browser with a debugging port, without asking the owner to do anything.
//
// The first cut required Chrome to be started by hand with
// `--remote-debugging-port`, which meant quitting the browser they were using.
// Worse, when they had not, the failure surfaced as Node's bare "fetch failed"
// after 2ms — technically the truth (no socket) and useless as an instruction.
// The live audit trail caught exactly that.
//
// So: attach if something is already listening, otherwise launch a private
// headless Chrome and manage it. Attaching is tried FIRST because an already
// running browser carries the owner's real sessions, which a fresh profile
// cannot — a doc behind a login reads correctly there and nowhere else.
//
// The managed instance gets its own user-data-dir, deliberately NOT the
// owner's: Chrome refuses to open a profile twice, so borrowing theirs would
// either fail or fight the browser they are using.
//
// Named exports only.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Where the managed browser keeps its profile — beside the other runtime state. */
export const MANAGED_PROFILE_DIR = path.join(process.env.SUNDIAL_HOME || path.join(os.homedir(), '.sundial'), '.daemon', 'chrome-headless');

/** A port of its own, so a managed instance never collides with a browser the owner started. */
export const MANAGED_PORT = Number(process.env.SUNDIAL_CHROME_PORT) || 9223;

/** Where Chrome usually lives. `SUNDIAL_CHROME_PATH` overrides all of it. */
export const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

export function resolveChromePath(candidates = CHROME_CANDIDATES, env = process.env) {
  const override = env.SUNDIAL_CHROME_PATH;
  if (override) return fs.existsSync(override) ? override : null;
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** Is a CDP endpoint answering right now? Used to attach rather than launch. */
export async function probeEndpoint(endpoint, timeoutMs = 1500) {
  try {
    const response = await fetch(new URL('/json/version', endpoint), { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

/** The flags the managed instance runs with. Kept here so the test and the plugin cannot drift. */
export function headlessArgs(port, profileDir) {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // Nothing here is an anti-detection measure. These only stop a headless
    // process from doing work that has no output device to show it.
    '--disable-background-networking',
    '--disable-extensions',
    '--mute-audio',
    // A page the owner watches live in its card: a desktop size reads.
    '--window-size=1280,800',
  ];
}

/**
 * Resolve a usable CDP endpoint, launching a managed browser if needed.
 *
 * Returns `{ endpoint, managed, stop() }`. `stop()` is a no-op for an attached
 * browser — this must never kill a browser it did not start.
 */
export function createBrowserSupervisor({
  preferredEndpoint = 'http://127.0.0.1:9222',
  port = MANAGED_PORT,
  profileDir = MANAGED_PROFILE_DIR,
  allowLaunch = true,
  chromePath = resolveChromePath(),
  probe = probeEndpoint,
  spawnProcess = spawn,
  startTimeoutMs = 20_000,
} = {}) {
  const managedEndpoint = `http://127.0.0.1:${port}`;
  let child = null;
  let starting = null;

  async function launch(args = headlessArgs(port, profileDir)) {
    if (chromePath === null) {
      throw new Error(
        'no Chrome, Chromium or Edge found to launch — install one, or set SUNDIAL_CHROME_PATH, or start a browser with --remote-debugging-port=9222',
      );
    }
    fs.mkdirSync(profileDir, { recursive: true });
    const proc = spawnProcess(chromePath, args, { stdio: 'ignore', detached: false });
    proc.on('exit', () => {
      if (child === proc) child = null;
    });
    child = proc;

    // Chrome opens its debugging socket a moment after exec; poll rather than
    // sleep a fixed amount, so a slow machine is not a failure and a fast one
    // is not delayed.
    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      if (await probe(managedEndpoint)) return managedEndpoint;
      if (child === null) throw new Error('the managed browser exited before its debugging port opened');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    stop();
    throw new Error(`the managed browser did not open a debugging port within ${startTimeoutMs}ms`);
  }

  function stop() {
    if (child === null) return;
    const proc = child;
    child = null;
    try {
      proc.kill();
    } catch {
      // Already gone.
    }
  }

  return {
    get managedEndpoint() {
      return managedEndpoint;
    },

    /** True while this supervisor owns a running browser. */
    get isManaging() {
      return child !== null;
    },

    async resolve() {
      // A browser the owner already runs wins: it has their sessions.
      if (await probe(preferredEndpoint)) return { endpoint: preferredEndpoint, managed: false };
      if (child !== null && (await probe(managedEndpoint))) return { endpoint: managedEndpoint, managed: true };
      if (!allowLaunch) {
        throw new Error(
          `no browser is listening on ${preferredEndpoint}. Start one with: open -a "Google Chrome" --args --remote-debugging-port=9222`,
        );
      }
      // One launch at a time, however many fetches arrive together.
      starting = starting ?? launch().finally(() => {
        starting = null;
      });
      return { endpoint: await starting, managed: true };
    },

    stop,
  };
}

/**
 * Gnomon's own browser, one per process. The fetch provider and the page tools
 * (registered by another plugin) share it: Chrome refuses to open one profile
 * twice, so two supervisors would fight over the lock. Never attaches to a
 * browser the owner runs — web tasks happen in Gnomon's browser only.
 */
let shared = null;
export function managedBrowser(options = {}) {
  shared = shared ?? createBrowserSupervisor({ ...options, preferredEndpoint: null });
  return shared;
}
