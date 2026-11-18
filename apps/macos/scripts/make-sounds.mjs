#!/usr/bin/env node
// Writes the three sounds the app plays (apps/macos/sounds/*.wav): 16-bit mono, soft mallet notes, each at most 0.5 s.
// Run it again after a change here and commit the files: node apps/macos/scripts/make-sounds.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 22050;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sounds');
const G4 = 392;
const B4 = 493.88;
const D5 = 587.33;

/** Soft mallet notes, as on a marimba. Each note [start, pitch] has a short soft start and rings out fast. */
function mallet(seconds, notes) {
  const out = new Float64Array(Math.round(seconds * RATE));
  for (const [start, pitch] of notes) {
    for (let i = Math.round(start * RATE); i < out.length; i += 1) {
      const x = i / RATE - start;
      out[i] += Math.min(1, x / 0.006) * (Math.sin(2 * Math.PI * pitch * x) * Math.exp(-x * 11) + 0.12 * Math.sin(2 * Math.PI * 4 * pitch * x) * Math.exp(-x * 40));
    }
  }
  // The last 30 ms fade to zero, so the file ends without a click.
  return out.map((s, i) => s * Math.min(1, (out.length - i) / (RATE * 0.03)));
}

const SOUNDS = {
  knock: { gain: 0.3, samples: mallet(0.5, [[0, G4], [0.13, B4]]) },
  nod: { gain: 0.25, samples: mallet(0.3, [[0, D5]]) },
  return: { gain: 0.25, samples: mallet(0.3, [[0, G4]]) },
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, { gain, samples }] of Object.entries(SOUNDS)) {
  const count = samples.length;
  const scale = gain / samples.reduce((peak, s) => Math.max(peak, Math.abs(s)), 0);
  const file = Buffer.alloc(44 + count * 2);
  file.write('RIFF', 0);
  file.writeUInt32LE(36 + count * 2, 4);
  file.write('WAVEfmt ', 8);
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20);
  file.writeUInt16LE(1, 22);
  file.writeUInt32LE(RATE, 24);
  file.writeUInt32LE(RATE * 2, 28);
  file.writeUInt16LE(2, 32);
  file.writeUInt16LE(16, 34);
  file.write('data', 36);
  file.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i += 1) file.writeInt16LE(Math.round(samples[i] * scale * 32767), 44 + i * 2);
  fs.writeFileSync(path.join(OUT, `${name}.wav`), file);
  console.log(`${name}.wav ${(count / RATE).toFixed(2)}s ${file.length} bytes`);
}
