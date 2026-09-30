import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSundialEnvFile } from './sundial-env.js';

describe('readSundialEnvFile (W3: the one .env parser)', () => {
  it('reads quotes, export, comments and junk the way dotenv does', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sundial-env-'));
    const file = path.join(dir, '.env');
    fs.writeFileSync(
      file,
      [
        '# comment',
        'OBSIDIAN_API_KEY="abc123"',
        "SINGLE='two words'",
        'export SUNDIAL_LLM_BASE_URL=https://llm.example.com/v1',
        'PLAIN=x=y',
        'SPACED = padded ',
        'INLINE=value # trailing note',
        'HASHED="a#b"',
        '',
        'not a line',
        '=nokey',
      ].join('\n'),
    );
    expect(readSundialEnvFile(file)).toEqual({
      OBSIDIAN_API_KEY: 'abc123',
      SINGLE: 'two words',
      SUNDIAL_LLM_BASE_URL: 'https://llm.example.com/v1',
      PLAIN: 'x=y',
      SPACED: 'padded',
      INLINE: 'value',
      HASHED: 'a#b',
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is empty when the file is absent, and never touches process.env', () => {
    expect(readSundialEnvFile('/nonexistent/.env')).toEqual({});
  });
});
