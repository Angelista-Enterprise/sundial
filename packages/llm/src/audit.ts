import { createEventId } from '@sundial/helpers/event-id.js';
import { recordLlmAudit, updateLlmAudit, type RecordLlmAuditInput, type UpdateLlmAuditInput } from '@sundial/db/index.js';

/** `route`: the model route that serves the call (`openai`, a provider id, `jev`, …), for `llm:failed` and the breaker; not a column. */
export type LlmAuditRow = Omit<RecordLlmAuditInput, 'id' | 'requestedAt' | 'source'> & { id?: string; requestedAt?: string; route?: string };

/** What one settled row came to (W5): only ids, the route and the class — never the prompt, the reply or the error text. */
export interface LlmAuditOutcome {
  callId: string;
  purpose: string;
  route: string;
  ok: boolean;
  errorClass: string | null;
  attempt: number;
  /** A 429's parsed `Retry-After`, when the endpoint sent one. */
  retryAfterMs?: number;
}

let auditListener: ((outcome: LlmAuditOutcome) => void) | null = null;

/** W5: the kernel runtime listens, and appends `llm:failed` (and `llm:recovered` after a streak). One listener; none, nothing happens. */
export function setLlmAuditListener(fn: ((outcome: LlmAuditOutcome) => void) | null): void {
  auditListener = fn;
}

export interface LlmAudit {
  /** The row's id: the reservation's `callId` when one was given, so the spend and the row join. */
  id: string;
  /** Close the row with the call's outcome. Once: a second settle is a no-op. */
  settle(patch: UpdateLlmAuditInput & { retryAfterMs?: number | null; route?: string }): Promise<void>;
}

/**
 * W3: the one writer of `llm_audit`, for every model caller — the kernel's
 * audited transport and judgements, the chat's ledger listener, the Claude
 * hand and the screen-vision sensor. Record-then-patch: the row is written
 * before the call, so a process that dies mid-call leaves "requested, never
 * answered" rather than nothing, and `settle` patches it once. Error text is
 * scrubbed of URL credentials and key-shaped words at the write
 * (`updateLlmAudit` → `redactSecrets`). W5: every settle is reported to the
 * audit listener, so a failed call becomes one `llm:failed` whoever made it.
 * Nothing else imports `recordLlmAudit`
 * (test/architecture.test.js).
 */
export async function openLlmAudit({ route = 'unknown', ...row }: LlmAuditRow): Promise<LlmAudit> {
  const id = row.id ?? createEventId();
  // The route is the row's `source` column too (step 3 of the provider plan); `access` says api, runtime or judge.
  await recordLlmAudit({ ...row, id, requestedAt: row.requestedAt ?? new Date().toISOString(), source: route, access: row.access ?? (route === 'claude' || route === 'copilot' ? 'runtime' : route === 'jev' ? 'judge' : 'api') });
  let settled = false;
  return {
    id,
    async settle({ retryAfterMs, route: answered, ...patch }) {
      if (settled) return;
      settled = true;
      // Set 2 R4: a call another route answered (the asked one unreachable) is that route's, in the row and for the breaker.
      const served = answered ?? route;
      await updateLlmAudit(id, { ...patch, ...(answered ? { source: answered } : {}) });
      try {
        auditListener?.({ callId: id, purpose: row.purpose, route: served, ok: patch.success === true, errorClass: patch.success ? null : (patch.errorClass ?? 'unknown'), attempt: row.attempt ?? 1, ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}) });
      } catch {
        // A listener that throws must never turn a settled row into a failure.
      }
    },
  };
}
