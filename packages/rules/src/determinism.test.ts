import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const BANNED = [/\bulid\(/, /\bcreateEventId\(/, /\bDate\.now\(\)/, /\bnew Date\(\)/];

function listRuleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listRuleFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

// A§1.2 — rules must be a pure fold over (state, event); any of these
// introduce wall-clock/random non-determinism that breaks replay identity
// (the same event sequence must always produce the same state and ids).
// `deriveId(event.ts, event.id, ...)` is the replacement — see derive-id.ts.
// This is a source-scan stand-in for an ESLint rule: there's no ESLint setup
// anywhere in this repo yet, and standing one up is out of scope for what
// this guardrail needs.
describe('rule-file determinism invariant', () => {
  const files = listRuleFiles(SRC_DIR).filter((f) => path.basename(f) !== 'determinism.test.ts');

  it.each(files.map((f) => [path.relative(SRC_DIR, f), f] as const))('%s has no non-deterministic id/time generation', (_name, file) => {
    const contents = fs.readFileSync(file, 'utf8');
    for (const pattern of BANNED) {
      expect(contents).not.toMatch(pattern);
    }
  });
});
