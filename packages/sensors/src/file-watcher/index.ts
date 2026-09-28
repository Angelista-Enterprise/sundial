import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { makeIgnoreFn, mergeChangeKind, type FileChangeKind, type PendingChange } from './file-watcher-capture.js';

export interface FileWatcherEvent {
  type: 'file:changed' | 'file-watcher:capacity';
  payload: Record<string, unknown>;
}

const UNFOCUSED_TEARDOWN_MS = 5 * 60 * 1000;
const DEBOUNCE_MS = 2000;
const MAX_CONCURRENT_ROOTS = 10;
const MAX_DEPTH = 8;

interface RootWatcher {
  close: () => Promise<void> | void;
}

/**
 * Ported from WCS's `FileWatcherSensor`. Gnomon has no `file:extracted`
 * (LSP-derived) signal to drive "which root is focused" — `project:detected`
 * is used directly as the focus signal instead (see
 * docs/phase-3-implementation-plan.md's Wave 3d notes), since it already
 * fires on the same real-world event (the user switched to a different
 * project) that WCS's version cared about.
 */
export class FileWatcherSensor {
  private readonly onEvent: (event: FileWatcherEvent) => void;
  private watchers = new Map<string, RootWatcher>();
  private watchedRoots: string[] = [];
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private pendingByRoot = new Map<string, Map<string, PendingChange>>();
  private focusedRoot: string | null = null;
  private rootLastFocusedAt = new Map<string, number>();
  private teardownTimers = new Map<string, NodeJS.Timeout>();

  constructor(onEvent: (event: FileWatcherEvent) => void) {
    this.onEvent = onEvent;
  }

  getWatchedRoots(): string[] {
    return [...this.watchedRoots];
  }

  stop(): void {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    for (const timer of this.teardownTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    this.teardownTimers.clear();
    this.pendingByRoot.clear();
    for (const root of [...this.watchers.keys()]) {
      void this.stopWatchingRoot(root);
    }
  }

  /** Doubles as the "this root is now focused" signal — see class doc. */
  notifyProjectDetected(root: string): void {
    const prev = this.focusedRoot;
    this.focusedRoot = root;
    this.rootLastFocusedAt.set(root, Date.now());
    this.cancelTeardownForRoot(root);
    if (prev && prev !== root) this.scheduleUnfocusedTeardown(prev);

    if (this.watchedRoots.includes(root)) return;

    if (this.watchedRoots.length >= MAX_CONCURRENT_ROOTS) {
      const evicted = this.evictLeastRecentlyFocusedRoot(root);
      if (!evicted) {
        this.onEvent({
          type: 'file-watcher:capacity',
          payload: { timestamp: new Date().toISOString(), maxRoots: MAX_CONCURRENT_ROOTS, activeRoots: [...this.watchedRoots], rejectedRoot: root },
        });
        return;
      }
    }

    void this.startWatching(root);
  }

  private cancelTeardownForRoot(root: string): void {
    const timer = this.teardownTimers.get(root);
    if (timer) {
      clearTimeout(timer);
      this.teardownTimers.delete(root);
    }
  }

  private scheduleUnfocusedTeardown(root: string): void {
    if (root === this.focusedRoot || this.teardownTimers.has(root)) return;
    this.teardownTimers.set(
      root,
      setTimeout(() => {
        this.teardownTimers.delete(root);
        if (root !== this.focusedRoot && this.watchedRoots.includes(root)) void this.stopWatchingRoot(root);
      }, UNFOCUSED_TEARDOWN_MS),
    );
  }

  private evictLeastRecentlyFocusedRoot(incomingRoot: string): boolean {
    const candidates = this.watchedRoots.filter((r) => r !== this.focusedRoot && r !== incomingRoot);
    if (candidates.length === 0) return false;
    let oldest = candidates[0]!;
    let oldestTs = this.rootLastFocusedAt.get(oldest) ?? 0;
    for (const root of candidates.slice(1)) {
      const ts = this.rootLastFocusedAt.get(root) ?? 0;
      if (ts < oldestTs) {
        oldest = root;
        oldestTs = ts;
      }
    }
    void this.stopWatchingRoot(oldest);
    return true;
  }

  private async startWatching(root: string): Promise<void> {
    if (this.watchers.has(root)) return;
    const ignored = makeIgnoreFn(root);

    const native = this.tryStartNativeWatcher(root, ignored);
    const watcher = native ?? (await this.startChokidarWatcher(root, ignored));
    if (!watcher) return;

    this.watchers.set(root, watcher);
    this.watchedRoots.push(root);
    this.pendingByRoot.set(root, new Map());
    this.rootLastFocusedAt.set(root, Date.now());
  }

  /** `fs.watch(root, {recursive:true})` is only reliably supported on macOS/Windows — Linux falls back to chokidar. */
  private tryStartNativeWatcher(root: string, ignored: (p: string) => boolean): RootWatcher | null {
    try {
      const watcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        // Live-tested finding (2026-07-17): macOS's recursive fs.watch
        // sometimes reports the watched root's OWN basename as `filename`
        // for a top-level change, not a real path inside it -- confirmed
        // via a direct fs.watch probe. Joining that with `root` produces a
        // bogus, nonexistent path, which fs.stat then fails, wrongly
        // queuing a phantom "delete" for a file matching the project's own
        // directory name. Real files essentially never collide with the
        // project root's own basename, so skip it outright.
        if (filename.toString() === path.basename(root)) return;
        const abs = path.join(root, filename.toString());
        if (ignored(abs)) return;
        fs.stat(abs, (err, stat) => {
          const kind: FileChangeKind = err ? 'delete' : 'modify';
          this.queue(root, abs, kind, err ? undefined : { size: stat.size, mtimeMs: stat.mtimeMs });
        });
      });
      watcher.on('error', (err) => this.handleWatcherError(root, err));
      return { close: () => watcher.close() };
    } catch {
      return null;
    }
  }

  private async startChokidarWatcher(root: string, ignored: (p: string) => boolean): Promise<RootWatcher | null> {
    let w: FSWatcher;
    try {
      w = chokidar.watch(root, {
        ignored,
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false,
        depth: MAX_DEPTH,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      });
    } catch (err) {
      console.error('[file-watcher] failed to watch:', root, err);
      return null;
    }

    w.on('add', (p: string) => this.queue(root, p, 'add'));
    w.on('change', (p: string) => this.queue(root, p, 'modify'));
    w.on('unlink', (p: string) => this.queue(root, p, 'delete'));
    w.on('error', (err: unknown) => this.handleWatcherError(root, err));

    return { close: () => w.close() };
  }

  private handleWatcherError(root: string, err: unknown): void {
    console.error('[file-watcher] watcher error, tearing down root:', root, err);
    if (this.watchedRoots.includes(root)) void this.stopWatchingRoot(root);
  }

  private async stopWatchingRoot(root: string): Promise<void> {
    const w = this.watchers.get(root);
    if (w) {
      try {
        await w.close();
      } catch {
        /* ignore */
      }
      this.watchers.delete(root);
    }
    this.watchedRoots = this.watchedRoots.filter((r) => r !== root);
    this.pendingByRoot.delete(root);
    const debounce = this.debounceTimers.get(root);
    if (debounce) {
      clearTimeout(debounce);
      this.debounceTimers.delete(root);
    }
    this.cancelTeardownForRoot(root);
    this.rootLastFocusedAt.delete(root);
  }

  private queue(root: string, abs: string, kind: FileChangeKind, extra?: { size?: number; mtimeMs?: number }): void {
    const pending = this.pendingByRoot.get(root);
    if (!pending) return;
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    const existing = pending.get(rel);
    pending.set(rel, { kind: mergeChangeKind(existing?.kind, kind), size: extra?.size, mtimeMs: extra?.mtimeMs });
    this.scheduleFlush(root);
  }

  private scheduleFlush(root: string): void {
    if (this.debounceTimers.has(root)) return;
    this.debounceTimers.set(
      root,
      setTimeout(() => this.flush(root), DEBOUNCE_MS),
    );
  }

  private flush(root: string): void {
    this.debounceTimers.delete(root);
    const pending = this.pendingByRoot.get(root);
    if (!pending || pending.size === 0) return;
    const changes = [...pending].map(([relPath, v]) => ({ relPath, kind: v.kind, size: v.size, mtimeMs: v.mtimeMs }));
    pending.clear();
    this.onEvent({
      type: 'file:changed',
      payload: { timestamp: new Date().toISOString(), projectRoot: root, changes, focused: this.focusedRoot === root },
    });
  }
}
