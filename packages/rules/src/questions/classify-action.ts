/**
 * `classify-action` and `verify-action` — J4.1 and J4.2, the hands' two
 * judgements (docs/jarvis/05). Before an action: what rung of the ladder is
 * it, read off the tool and its arguments alone? After: did the result show
 * it happened? Neither is a key on its own — the code policy in
 * `sundial-actions/gate.js` decides first, and the judge may only TIGHTEN it
 * (two keys: no action above L2 on a model's word). "Matches policy" is not
 * asked: the policy is code, and Jev does not learn rules from text (PROBES
 * finding 10).
 */
import type { JudgementResultPayload } from '@sundial/kernel/types.js';
import { choice, clip, noul, score, type QuestionSet, keyed } from './index.js';

export interface ClassifyActionInput {
  tool: string;
  args: unknown;
}

const stringify = (value: unknown, max: number): string => {
  try {
    return clip(typeof value === 'string' ? value : JSON.stringify(value ?? null), max);
  } catch {
    return clip(String(value), max);
  }
};

export const ACTION_LEVELS = ['read', 'internal_reversible', 'internal_irreversible', 'outward'] as const;
export type ActionLevel = (typeof ACTION_LEVELS)[number];

export const CLASSIFY_ACTION_QUESTIONS = keyed('classify-action', {
  level: choice('What does the call `tool` with `arguments` do, judged from the tool and the arguments alone?', {
    read: 'Only reads, lists, searches or reports; it changes nothing.',
    internal_reversible: 'Changes something on this machine that can be undone afterwards: a note, a record, a scheduled reminder, a file edit inside a workspace under version control.',
    internal_irreversible: 'Changes something on this machine that cannot be undone: deletes, overwrites without a copy, resets, force operations.',
    outward: 'Reaches outside this machine or to other people: sends, posts, pushes, publishes, buys, messages, changes a shared calendar or service.',
  }),
  stakes: score('If this call went wrong, how much would it cost the owner?', ['Nothing: harmless either way.', 'Low: easy to notice and put right.', 'Medium: real time or attention to repair, or someone else notices.', 'High: money, lost data, other people, or trust.']),
});

export const classifyAction: QuestionSet<[ClassifyActionInput]> = {
  id: 'classify-action',
  build: (input) => ({ state: { tool: input.tool, arguments: stringify(input.args, 400) }, questions: CLASSIFY_ACTION_QUESTIONS }),
  samples: () => [
    [{ tool: 'gnomon_run_shell', args: { command: 'git push origin main' } }],
    [{ tool: 'gnomon_claim', args: { entityKind: 'project', canonicalName: 'gnomon', predicate: 'usesTool', object: 'Code', confidence: 0.6, note: 'x'.repeat(900) } }],
  ],
};

export interface VerifyActionInput {
  tool: string;
  args: unknown;
  result: unknown;
}

export const VERIFY_ACTION_QUESTIONS = keyed('verify-action', {
  carried_out: noul('Does `result` show that `tool` did what `arguments` asked — completed, with no error, refusal, timeout or empty outcome?'),
});

export const verifyAction: QuestionSet<[VerifyActionInput]> = {
  id: 'verify-action',
  build: (input) => ({ state: { tool: input.tool, arguments: stringify(input.args, 300), result: stringify(input.result, 600) }, questions: VERIFY_ACTION_QUESTIONS }),
  samples: () => [
    [{ tool: 'gnomon_run_shell', args: { command: 'npx vitest run' }, result: { ran: true, exitCode: 1, stdout: '', stderr: 'FAIL 3 tests' } }],
    [{ tool: 'gnomon_claim', args: { canonicalName: 'x' }, result: { recorded: true, note: 'y'.repeat(2000) } }],
  ],
};

/** The level the judge picked and the probability behind it (law 5), or null when it did not answer. */
export function actionLevelOf(answers: JudgementResultPayload['answers']): { level: ActionLevel; p: number; stakes: number | null } | null {
  const a = answers.level;
  if (typeof a?.choice !== 'string' || !(ACTION_LEVELS as readonly string[]).includes(a.choice)) return null;
  const probabilities = a.probabilities ? Object.values(a.probabilities).filter((v) => typeof v === 'number') : [];
  const p = probabilities.length > 0 ? Math.max(...probabilities) : (a.confidence ?? 0);
  return { level: a.choice as ActionLevel, p, stakes: typeof answers.stakes?.score === 'number' ? Math.round(answers.stakes.score) : null };
}

export const carriedOutOf = (answers: JudgementResultPayload['answers']): number | null => (typeof answers.carried_out?.noul === 'number' ? answers.carried_out.noul : null);
