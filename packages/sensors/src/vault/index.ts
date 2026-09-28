import fs from 'node:fs';
import path from 'node:path';

/**
 * J3.5 — the Obsidian vault as a sense. Watches ONE directory the owner named
 * (`config.vault`; default null = off) and emits `vault:changed` with the
 * relative paths of the Markdown notes that changed, debounced, never their
 * contents. The fold keeps which notes were edited today (`vaultTrack`); the
 * fan-out reads them as subject candidates. `.obsidian/` and `.trash/` are the
 * app's own and never count.
 *
 * `fs.watch(root, { recursive: true })` is reliable on macOS, which is the
 * only place this runs (the vault lives in iCloud or ~/Documents here).
 */
export interface VaultEvent {
  type: 'vault:changed';
  payload: { notes: string[]; count: number };
}

const IGNORED = /(^|\/)(\.obsidian|\.trash|\.git)(\/|$)/;
const MAX_NOTES_PER_EVENT = 20;

export class VaultSensor {
  private watcher: fs.FSWatcher | null = null;
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly root: string,
    private readonly onEvent: (event: VaultEvent) => void,
    private readonly debounceMs = 5_000,
  ) {}

  start(): boolean {
    if (this.watcher) return true;
    if (!fs.existsSync(this.root)) return false;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_kind, filename: string | Buffer | null) => {
        const rel = typeof filename === 'string' ? filename : filename === null ? null : filename.toString('utf8');
        if (!rel || !rel.endsWith('.md') || IGNORED.test(rel)) return;
        this.pending.add(rel.split(path.sep).join('/'));
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), this.debounceMs);
      });
      this.watcher.on('error', (error) => console.error('[sundial-sensors] vault watch failed:', error));
      return true;
    } catch (error) {
      console.error('[sundial-sensors] vault watch could not start:', error);
      return false;
    }
  }

  private flush(): void {
    this.timer = null;
    if (this.pending.size === 0) return;
    const notes = [...this.pending].slice(0, MAX_NOTES_PER_EVENT);
    const count = this.pending.size;
    this.pending.clear();
    this.onEvent({ type: 'vault:changed', payload: { notes, count } });
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.watcher?.close();
    this.watcher = null;
  }
}
