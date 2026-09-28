// Config-free redaction primitives. Bind to policy via `./redact-policy.ts`.

const regexCache = new Map<string, RegExp | null>();

function getRegex(pattern: string): RegExp | null {
  if (regexCache.has(pattern)) {
    return regexCache.get(pattern) ?? null;
  }
  try {
    let flags = 'g';
    let src = pattern;
    if (src.startsWith('(?i)')) {
      flags = 'gi';
      src = src.slice(4);
    }
    const re = new RegExp(src, flags);
    regexCache.set(pattern, re);
    return re;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[redact] invalid pattern dropped: ${pattern} — ${reason}`);
    regexCache.set(pattern, null);
    return null;
  }
}

export function redact(text: string, patterns: string[], replacement: string): string {
  let result = text;
  for (const pattern of patterns) {
    const re = getRegex(pattern);
    if (re) {
      re.lastIndex = 0;
      result = result.replace(re, replacement);
    }
  }
  return result;
}

export function redactLines(lines: string[], patterns: string[], replacement: string): string[] {
  return lines.map((line) => redact(line, patterns, replacement));
}

/** Truncate with ellipsis if over `max` chars. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function isSensitiveProcessName(processName: string, sensitiveApps: string[]): boolean {
  if (sensitiveApps.length === 0) return false;
  const lower = processName.toLowerCase();
  return sensitiveApps.some((app) => lower.includes(app.toLowerCase()));
}
