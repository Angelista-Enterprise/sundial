import fs from 'node:fs';
import path from 'node:path';
import { extractSymbolsFromDiff, runGitDiff } from './symbol-capture.js';

export interface SymbolEditEvent {
  type: 'symbol:edited';
  payload: Record<string, unknown>;
}

export interface FileChange {
  relPath: string;
  kind: 'add' | 'modify' | 'delete';
}

const MAX_FILES_PER_EVENT = 20;

/**
 * Reacts to `file:changed` (from `FileWatcherSensor`). Stateless — no dedup
 * needed beyond the per-event file cap, matching WCS's version.
 */
export class SymbolEditSensor {
  async handleFileChanged(projectRoot: string, changes: FileChange[]): Promise<SymbolEditEvent | null> {
    if (!fs.existsSync(path.join(projectRoot, '.git'))) return null;

    const edits: { file: string; symbols: string[]; hunkCount: number }[] = [];
    let totalSymbolCount = 0;

    const targets = changes.filter((c) => c.kind !== 'delete').slice(0, MAX_FILES_PER_EVENT);
    for (const change of targets) {
      const diff = await runGitDiff(projectRoot, change.relPath);
      if (!diff) continue;
      const { symbols, hunkCount } = extractSymbolsFromDiff(diff);
      if (symbols.length === 0 && hunkCount === 0) continue;
      edits.push({ file: change.relPath, symbols, hunkCount });
      totalSymbolCount += symbols.length;
    }

    if (edits.length === 0) return null;

    return {
      type: 'symbol:edited',
      payload: { timestamp: new Date().toISOString(), projectRoot, edits, totalSymbolCount },
    };
  }
}
