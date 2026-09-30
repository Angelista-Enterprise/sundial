// W4 step 15 / fence F7: one handler per effect type, in a map the compiler holds exhaustive.
// `runtime.ts` journals each effect and calls `EFFECT_HANDLERS[effect.type]`; the handlers live
// here by family (`EFFECT_FAMILY`: what an effect changes), so the executor is a table, not a chain.
import type { Effect } from '@sundial/kernel/index.js';
import type { KernelRuntime } from '../runtime.js';
import { ITSELF } from './itself.js';
import { RECORD } from './record.js';
import { THINK } from './think.js';
import { YOU } from './you.js';

/** Where the effect sits in the journal: `EmitEvent` records its child's id against it. */
export interface EffectAt {
  eventId: string;
  effectIndex: number;
}

export type Handler<K extends Effect['type'] = Effect['type']> = (host: KernelRuntime, effect: Extract<Effect, { type: K }>, at: EffectAt) => unknown;
export type Handlers = { [K in Effect['type']]?: Handler<K> };

export const EFFECT_HANDLERS = { ...RECORD, ...THINK, ...ITSELF, ...YOU } satisfies { [K in Effect['type']]: Handler<K> };
