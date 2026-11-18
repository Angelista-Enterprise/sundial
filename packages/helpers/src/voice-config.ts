/**
 * Which voice says Gnomon's lines (plan 15, decision A, 2026-11-11): Kokoro on this Mac, with the
 * system voice when Kokoro is missing or has no voice for the language. `name` picks a voice of that engine.
 */
export interface VoiceConfig {
  engine: 'kokoro' | 'system';
  name: string | null;
  /** Plan 15 step 3: the Python that has mlx-audio and Kokoro. Without one the system voice speaks. */
  python: string | null;
  /** Round 5: screen steps say their own line in the rig's sessions too. Off: a bench run stays quiet. */
  rigLines: boolean;
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = { engine: 'kokoro', name: null, python: null, rigLines: false };

export function resolveVoice(value: unknown): VoiceConfig {
  const v = (value ?? {}) as { engine?: unknown; name?: unknown; python?: unknown; rigLines?: unknown };
  const text = (x: unknown) => (typeof x === 'string' && x.trim() !== '' ? x.trim() : null);
  return { engine: v.engine === 'system' ? 'system' : 'kokoro', name: text(v.name), python: text(v.python), rigLines: v.rigLines === true };
}
