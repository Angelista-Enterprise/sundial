// The migrations folder and the schema agree: `drizzle-kit generate` over a copy
// of `drizzle/` with no schema change writes no new migration.
//
// Migrations 0032–0035 were written by hand and left no snapshot, so kit diffed
// the schema against 0031 and emitted seven ALTER TABLE ... ADD statements for
// columns that already exist. The next generated migration would have carried
// them, and boot would have failed on "duplicate column". A new migration must
// come with its snapshot (`meta/NNNN_snapshot.json`); this test says when one
// did not.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIT = path.join(PKG, 'node_modules', '.bin', 'drizzle-kit');

describe('drizzle snapshots (hardening S5)', () => {
  it('generate with no schema change writes no migration', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sundial-drizzle-'));
    try {
      cpSync(path.join(PKG, 'drizzle'), path.join(dir, 'drizzle'), { recursive: true });
      const before = readdirSync(path.join(dir, 'drizzle')).sort();
      // kit prefixes `out` with './', so it runs from the temp folder with a relative one.
      const r = spawnSync(KIT, ['generate', '--dialect', 'sqlite', '--schema', path.join(PKG, 'src', 'schemas', 'db-schema.ts'), '--out', 'drizzle', '--name', 'probe'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
      expect(readdirSync(path.join(dir, 'drizzle')).sort()).toEqual(before);
      expect(r.stdout).toMatch(/No schema changes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
