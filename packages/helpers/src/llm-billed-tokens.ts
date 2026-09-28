/**
 * What a failed call still cost to make.
 *
 * A dead request reports no usage, so every failed row in the ledger carried
 * zero tokens and read as free. It is not: the request body went up the wire
 * before the endpoint timed out, refused, or vanished, and the provider bills
 * the input it received. 294 failures a week priced at $0 is the reason
 * "wasted money" was an unanswerable question.
 *
 * There is nothing to measure after the fact — the response that would have
 * carried `usage` never arrived — so this estimates the upload from the prompt
 * text that was sent. It is kept in its own column, never folded into
 * `prompt_tokens`, so a measured count and an estimated one are never added
 * together without saying so.
 */

/**
 * ponytail: four characters per token, the usual English/code rule of thumb.
 * Upgrade to a real tokenizer only if this number ever has to be a bill rather
 * than an order of magnitude — it would mean a tokenizer dependency per model
 * family, for a figure whose whole purpose is to stop reading as zero.
 */
const CHARS_PER_TOKEN = 4;

export function estimateBilledPromptTokens(prompt: string): number {
  return Math.ceil(prompt.length / CHARS_PER_TOKEN);
}
