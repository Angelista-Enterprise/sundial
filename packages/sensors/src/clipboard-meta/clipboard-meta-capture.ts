import { spawn } from 'node:child_process';

export type ClipboardContentKind = 'url' | 'code' | 'text' | 'file' | 'unknown';

/**
 * Reads the macOS clipboard *metadata only* — content is never persisted or
 * emitted. The caller hashes the raw text to detect changes, classifies it
 * by heuristic, then discards everything but type + size.
 */
export function readClipboardText(): Promise<string | null> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('pbpaste', [], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve(null);
    }, 1_500);
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8');
    });
    proc.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

export function classifyClipboardContent(text: string): ClipboardContentKind {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'unknown';
  if (/^https?:\/\/\S+$/.test(trimmed)) return 'url';
  if (/^\/[^\0\n]+$/.test(trimmed) || /^~\//.test(trimmed)) return 'file';
  if (looksLikeCode(text)) return 'code';
  return 'text';
}

function looksLikeCode(text: string): boolean {
  const hits = [/[{};]\s*$/m, /^\s*(function|class|const|let|var|import|export|def|public|private|fn)\b/m, /=>\s*[{(]/, /^\s*<\/?[a-z]/i].filter(
    (re) => re.test(text),
  ).length;
  return hits >= 2;
}
