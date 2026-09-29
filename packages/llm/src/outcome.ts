// lane H (H3)
/**
 * What one audited call came to, per provider: the seam `sensorHealth` needs
 * to say "Jev refused the key three times" without the transport knowing the
 * kernel exists. One listener (the kernel runtime sets it at construction); no
 * listener, nothing happens. Only the provider, a status and ok — never the
 * prompt, the message or the key.
 */
export interface LlmOutcome {
  /** `openai` (Gnomon's own route) or `jev`. */
  provider: string;
  /** A name a person recognizes: the service, or "Jev". */
  label: string;
  ok: boolean;
  statusCode: number | null;
}

let listener: ((outcome: LlmOutcome) => void) | null = null;

export function setLlmOutcomeListener(fn: ((outcome: LlmOutcome) => void) | null): void {
  listener = fn;
}

export function reportLlmOutcome(outcome: LlmOutcome): void {
  try {
    listener?.(outcome);
  } catch {
    // A listener that throws must never turn a call's result into a failure.
  }
}

/** The HTTP status an error carries (`LlmHttpError.status`), or null. */
export function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}
