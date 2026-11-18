// Bench mode (docs/release/27 section 4): who this install IS, never a flag someone can set. Read by the approve and
// ingest routes (plugins/sundial-theme/host/bench-guard.js re-exports this), the kernel's clock (a held bench clock),
// the privacy config (the bench fence) and plugins/sundial-bench (the AgentDojo tools).
//
// This install is the bench only when all of these hold:
// - SUNDIAL_LABEL is the bench label (the owner's install and a test install run under their own labels);
// - SUNDIAL_HOME is ~/.sundial-bench, resolved through links, and is not the owner's ~/.sundial;
// - the install marker (`.sundial-install.json`, bin/sundial) names that home and the bench label;
// - the bench marker (`bench.json`, written by lab/bench/install.sh at install time) names them too.
// Pure over what it is handed, so a test passes its own env and home.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const BENCH_LABEL = 'dev.sundial.bench';
export const BENCH_DIR = '.sundial-bench';

export interface BenchProbe {
  env?: NodeJS.ProcessEnv;
  home?: string;
  read?: (path: string) => string;
  real?: (path: string) => string;
}

/** What the bench marker says about the bench's setup. Honoured only on the bench install (`benchSetup`). */
export interface BenchMarker {
  bench: true;
  home: string;
  label: string;
  /** The bench fence: the private-app list emptied (privacy-config.ts). Only inside a VM guest that holds no owner data. */
  fence?: boolean;
  /** The bench clock held: no wall-clock `clock:tick`, so backdated ticks are the only day boundaries (sundial-kernel). */
  holdClock?: boolean;
  screen?: boolean;
}

const realOf = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const jsonAt = (read: (p: string) => string, p: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(read(p));
  } catch {
    return null;
  }
};

/** The bench marker when this install is the bench, else why not: { refusal } or { marker }. */
function probe({ env = process.env, home = homedir(), read = (p) => readFileSync(p, 'utf8'), real = realOf }: BenchProbe = {}): { refusal: string } | { marker: BenchMarker } {
  const no = (refusal: string) => ({ refusal });
  if (env.SUNDIAL_LABEL !== BENCH_LABEL) return no(`this install runs as ${env.SUNDIAL_LABEL || 'the default label'}, not ${BENCH_LABEL}`);
  if (!env.SUNDIAL_HOME) return no('this install names no SUNDIAL_HOME');
  const at = real(env.SUNDIAL_HOME);
  if (at === real(join(home, '.sundial'))) return no("this install's home is the owner's ~/.sundial");
  if (at !== real(join(home, BENCH_DIR))) return no(`this install's home is not ~/${BENCH_DIR}`);
  const install = jsonAt(read, join(env.SUNDIAL_HOME, '.sundial-install.json'));
  if (install?.tool !== 'sundial' || install.label !== BENCH_LABEL || real(String(install.home ?? '')) !== at) return no('the install marker does not name the bench');
  const bench = jsonAt(read, join(env.SUNDIAL_HOME, 'bench.json'));
  if (bench?.bench !== true || bench.label !== BENCH_LABEL || real(String(bench.home ?? '')) !== at) return no('there is no bench marker from the bench install');
  return { marker: bench as unknown as BenchMarker };
}

/** Why a bench answer is refused on this install, or null when this install is the bench. */
export function benchRefusal(opts: BenchProbe = {}): string | null {
  const got = probe(opts);
  return 'refusal' in got ? got.refusal : null;
}

/** The bench marker, read fresh, when this install is the bench; null everywhere else (the owner's install, a test install). */
export function benchSetup(opts: BenchProbe = {}): BenchMarker | null {
  const got = probe(opts);
  return 'marker' in got ? got.marker : null;
}
