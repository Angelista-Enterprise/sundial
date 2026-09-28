import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordLlmAudit = vi.fn();
const updateLlmAudit = vi.fn();
vi.mock('@sundial/db/index.js', () => ({
  recordLlmAudit: (...args: unknown[]) => recordLlmAudit(...args),
  updateLlmAudit: (...args: unknown[]) => updateLlmAudit(...args),
}));
const callSystemOne = vi.fn();
vi.mock('./systemone.js', () => ({ SYSTEMONE_DEFAULT_MODEL: 'jev-latest', callSystemOne: (...args: unknown[]) => callSystemOne(...args) }));

const { runAuditedJudgement } = await import('./audited-judgement.js');
const { auditIdOf } = await import('./types.js');

const questions = { same: { type: 'noul' as const, instructions: 'Same project?' } };
const options = { purpose: 'audit' as const, momentId: 'm1', state: { a: 'x' }, questions };

beforeEach(() => {
  recordLlmAudit.mockReset().mockResolvedValue(undefined);
  updateLlmAudit.mockReset().mockResolvedValue(undefined);
  callSystemOne.mockReset();
});

describe('runAuditedJudgement', () => {
  it('records typesafe/jev-latest with the state and questions as the prompt, then patches the answers and tokens', async () => {
    callSystemOne.mockResolvedValueOnce({ answers: { same: { type: 'noul', noul: 0.9 } }, model: 'jev-latest', inputTokens: 351, outputTokens: 20, latencyMs: 280, statusCode: 200 });
    const result = await runAuditedJudgement(options);

    const [row] = recordLlmAudit.mock.calls[0];
    expect(row.model).toBe('typesafe/jev-latest');
    expect(row.purpose).toBe('audit');
    expect(JSON.parse(row.prompt)).toEqual({ state: { a: 'x' }, questions });
    const [id, patch] = updateLlmAudit.mock.calls[0];
    expect(id).toBe(row.id);
    expect(patch.success).toBe(true);
    expect(patch.promptTokens).toBe(351);
    expect(patch.totalTokens).toBe(371);
    expect(JSON.parse(patch.responseContent)).toEqual({ same: { type: 'noul', noul: 0.9 } });
    expect(result.answers.same.noul).toBe(0.9);
    expect(result.model).toBe('typesafe/jev-latest');
    expect(callSystemOne.mock.calls[0][2]).toMatchObject({ model: 'jev-latest' });
  });

  it('a partial answer set is not a success', async () => {
    callSystemOne.mockResolvedValueOnce({ answers: {}, model: 'jev-latest', inputTokens: 10, outputTokens: 0, latencyMs: 1, statusCode: 200 });
    await runAuditedJudgement(options);
    expect(updateLlmAudit.mock.calls[0][1].success).toBe(false);
  });

  it('a failure patches the row with its class and billed tokens, and stamps the audit id on the error', async () => {
    callSystemOne.mockRejectedValueOnce(new TypeError('fetch failed'));
    const failure = await runAuditedJudgement(options).catch((e: unknown) => e);
    const [, patch] = updateLlmAudit.mock.calls[0];
    expect(patch.success).toBe(false);
    expect(patch.errorClass).toBe('network');
    expect(patch.billedPromptTokens).toBeGreaterThan(0);
    expect(auditIdOf(failure)).toBe(recordLlmAudit.mock.calls[0][0].id);
  });
});
