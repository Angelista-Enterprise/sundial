import { execFile } from 'node:child_process';

/** Ported verbatim from WCS's `symbol-edit/sensor.ts` — the regex table itself is not Gnomon-specific. */
const RESERVED = new Set([
  'function', 'async', 'class', 'interface', 'type', 'enum', 'struct', 'trait', 'impl',
  'const', 'let', 'var', 'public', 'private', 'protected', 'static', 'export', 'def',
  'func', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'default', 'new',
]);

/**
 * Extract a likely symbol name from a git diff hunk-header context line, e.g.
 *   @@ -12,5 +12,7 @@ function fooBar(arg) {
 *   @@ -3,2 +3,3 @@ class Foo {
 * Returns null when no usable name can be extracted.
 */
export function symbolFromHunkContext(context: string): string | null {
  const ctx = context.trim();
  if (!ctx) return null;

  const fnMatch = ctx.match(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
  if (fnMatch) return fnMatch[1]!;

  const declMatch = ctx.match(/\b(?:class|interface|type|enum|struct|trait|impl)\s+([A-Za-z_$][\w$]*)/);
  if (declMatch) return declMatch[1]!;

  const pyMatch = ctx.match(/^\s*def\s+([A-Za-z_][\w]*)/);
  if (pyMatch) return pyMatch[1]!;

  const goMatch = ctx.match(/^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)/);
  if (goMatch) return goMatch[1]!;

  const assignMatch = ctx.match(/^(?:export\s+|public\s+|private\s+|protected\s+|static\s+|async\s+|default\s+)*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
  if (assignMatch && !RESERVED.has(assignMatch[1]!)) return assignMatch[1]!;

  const methodMatch = ctx.match(/^[\s.*]*([A-Za-z_$][\w$]*)\s*\(/);
  if (methodMatch && !RESERVED.has(methodMatch[1]!)) return methodMatch[1]!;

  return null;
}

export function extractSymbolsFromDiff(diffOutput: string): { symbols: string[]; hunkCount: number } {
  const symbols = new Set<string>();
  let hunkCount = 0;
  for (const line of diffOutput.split('\n')) {
    if (!line.startsWith('@@')) continue;
    hunkCount++;
    const idx = line.indexOf('@@', 2);
    if (idx < 0) continue;
    const sym = symbolFromHunkContext(line.slice(idx + 2));
    if (sym) symbols.add(sym);
  }
  return { symbols: Array.from(symbols), hunkCount };
}

export function runGitDiff(cwd: string, relPath: string, timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['diff', '-U0', '--', relPath], { cwd, timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout);
    });
  });
}
