#!/usr/bin/env node
// sundial-sidecars — start/stop/status for the TCC sidecar launcher
// ($SUNDIAL_HOME/Sundial.app).
//
// The Swift launcher spawns ONLY the sidecar helpers (window/input/
// notification/screen-ocr) plus in-process focus/AV/sleep-wake capture; the
// dsh harness process only READS the JSON files they write. This script is
// the human-facing lifecycle tool for that launcher.
//
// TCC invariants (see .claude/CLAUDE.md):
//   - spawn(launcherPath) DIRECTLY — never `open -a`, which evaluates the
//     bundle in a different TCC context and drops Accessibility/SR grants.
//   - this node process is a *parent* of the launcher, never a child of it,
//     and never spawns a TCC-gated helper itself.
//   - a rebuild changes the adhoc cdhash, invalidating previously-granted
//     TCC entries — re-grant in System Settings after every rebuild.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUNDIAL_HOME = process.env.SUNDIAL_HOME || path.join(os.homedir(), '.sundial');
const RUNTIME_DIR = path.join(SUNDIAL_HOME, '.daemon');
const PID_FILE = path.join(RUNTIME_DIR, 'sidecars.pid');
// lane H (H7): unset, the install's app.env says where its app is (never a stray bundle in the data folder).
const appEnvApp = (() => {
  try {
    const line = fs.readFileSync(path.join(SUNDIAL_HOME, 'app.env'), 'utf8').split('\n').reverse().find((l) => l.startsWith('SUNDIAL_APP_PATH='));
    return line ? line.slice('SUNDIAL_APP_PATH='.length).trim() : '';
  } catch {
    return '';
  }
})();
const APP_MACOS_DIR = path.join(process.env.SUNDIAL_APP_PATH || appEnvApp || path.join(SUNDIAL_HOME, 'Sundial.app'), 'Contents', 'MacOS');
const LAUNCHER = path.join(APP_MACOS_DIR, 'sundial-daemon');

// lane H (H5): `start` and `stop` write into the install's log, so their lines
// carry a time like the web process's (stampConsole in @sundial/helpers). `status` is read by a person.
if (process.argv[2] === 'start' || process.argv[2] === 'stop') {
  for (const level of ['log', 'error']) {
    const original = console[level].bind(console);
    console[level] = (first, ...rest) => original(typeof first === 'string' ? `${new Date().toISOString()} ${first}` : new Date().toISOString(), ...(typeof first === 'string' ? rest : [first, ...rest]));
  }
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Sidecar output files and how fresh a live, granted sidecar keeps them.
 *  `staleMs: null` = event-driven/on-demand file; mtime says nothing about liveness. */
const FILES = [
  { label: 'window', name: 'window-info.json', staleMs: 10_000 },
  { label: 'focus-mode', name: 'focus-info.json', staleMs: 10_000 },
  { label: 'audio/camera', name: 'av-context.json', staleMs: 10_000 },
  { label: 'input-activity', name: 'input-activity.json', staleMs: 10_000 },
  { label: 'notifications', name: 'notification-badges.json', staleMs: 120_000 },
  { label: 'screen-ocr', name: 'screen-ocr.json', staleMs: 30_000, optIn: true },
  { label: 'sleep-wake', name: 'sleep-wake-info.json', staleMs: null },
  { label: 'calendar', name: 'calendar-info.json', staleMs: null },
];

function readPid() {
  try {
    const pid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ensureBundleBuilt() {
  if (fs.existsSync(LAUNCHER)) return;
  console.log('[sundial-sidecars] launcher not found in the app bundle — building…');
  for (const script of ['apps/daemon/scripts/swift.sh', 'apps/daemon/scripts/app.sh']) {
    const result = spawnSync('bash', [path.join(REPO_ROOT, script)], { stdio: 'inherit', env: { ...process.env, SUNDIAL_HOME } });
    if (result.status !== 0) {
      console.error(`[sundial-sidecars] ${script} failed (exit ${result.status})`);
      process.exit(1);
    }
  }
  if (!fs.existsSync(LAUNCHER)) {
    console.error(`[sundial-sidecars] build ran but ${LAUNCHER} still missing`);
    process.exit(1);
  }
}

function start() {
  const existing = readPid();
  if (existing && pidAlive(existing)) {
    console.log(`[sundial-sidecars] already running (pid ${existing})`);
    return;
  }
  ensureBundleBuilt();
  // Direct spawn — NEVER `open -a` (kills TCC grants; see file header).
  const child = spawn(LAUNCHER, [], { detached: true, stdio: 'ignore', env: { ...process.env, SUNDIAL_HOME } });
  child.unref();
  console.log(`[sundial-sidecars] started launcher (pid ${child.pid})`);
  console.log('[sundial-sidecars] note: if the launcher binary was rebuilt, TCC grants are invalid —');
  console.log('  re-add "Sundial" under System Settings → Privacy & Security →');
  console.log('  Accessibility / Screen Recording / Input Monitoring, then `stop` + `start`.');
}

function stop() {
  const pid = readPid();
  if (!pid) {
    console.log('[sundial-sidecars] not running (no sidecars.pid)');
    return;
  }
  if (!pidAlive(pid)) {
    console.log(`[sundial-sidecars] stale sidecars.pid (pid ${pid} not alive) — removing`);
    fs.rmSync(PID_FILE, { force: true });
    return;
  }
  process.kill(pid, 'SIGTERM');
  console.log(`[sundial-sidecars] sent SIGTERM to pid ${pid}`);
}

function status() {
  const pid = readPid();
  const alive = pid !== null && pidAlive(pid);
  console.log(`launcher: ${alive ? `running (pid ${pid})` : 'not running'}`);
  const now = Date.now();
  for (const file of FILES) {
    const p = path.join(RUNTIME_DIR, file.name);
    let line;
    try {
      const ageMs = now - fs.statSync(p).mtimeMs;
      const age = ageMs < 1000 ? `${Math.round(ageMs)}ms` : `${Math.round(ageMs / 1000)}s`;
      const stale = file.staleMs !== null && ageMs > file.staleMs;
      line = stale ? `STALE (updated ${age} ago)` : `ok (updated ${age} ago)`;
    } catch {
      line = file.optIn ? 'absent (opt-in, off by default)' : file.staleMs === null ? 'absent (event-driven/on-demand)' : 'MISSING';
    }
    console.log(`  ${file.label.padEnd(15)} ${line}`);
  }
  process.exitCode = alive ? 0 : 1;
}

const command = process.argv[2];
if (command === 'start') start();
else if (command === 'stop') stop();
else if (command === 'status') status();
else {
  console.error('Usage: sundial-sidecars.js <start|stop|status>');
  process.exit(2);
}
