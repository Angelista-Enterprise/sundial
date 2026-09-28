/**
 * What killed an LLM call, as one of nine words.
 *
 * The ledger used to answer "why are calls failing?" by re-parsing the stored
 * message string at READ time (`classifyError` in `@sundial/db`'s llm-audit),
 * which is why 68 of 294 failures reported an endpoint URL as their reason: the
 * classifier fell through to `error.slice(0, 48)` and the first 48 characters of
 * that message happened to be a URL. A reason column that is sometimes a reason
 * and sometimes a substring of a URL cannot be counted.
 *
 * So the class is decided ONCE, at the call site, from the error OBJECT — where
 * an HTTP status, an abort, and a DNS failure are still distinguishable — and
 * written to `llm_audit.error_class`. Reads group by that column and never look
 * at the message again.
 *
 * Lives in `@sundial/helpers` rather than in `@sundial/llm` because both write
 * paths to the ledger need it and only one of them is `@sundial/llm`: the other
 * is dsh's own chat stream, recorded from `plugins/sundial-tools/audit.js`.
 */
export const LLM_ERROR_CLASSES = ['network', 'timeout', 'http-4xx', 'http-5xx', 'rate-limit', 'stream', 'parse', 'cancelled', 'unknown'] as const;

export type LlmErrorClass = (typeof LLM_ERROR_CLASSES)[number];

/** Node's fetch reports DNS/connection trouble as an opaque `TypeError: fetch failed` with the real code on `cause`. */
const NETWORK_CODES = ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET'];

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? code : '';
}

/**
 * One thrown error → its class. Structured fields first (status, name, code);
 * the message is consulted only when the error carries nothing else, and only
 * here, at the call site, where the message is still the one the transport
 * wrote.
 */
export function classifyLlmError(error: unknown): LlmErrorClass {
  if (error == null) return 'unknown';

  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') {
    if (status === 429) return 'rate-limit';
    if (status >= 500) return 'http-5xx';
    if (status >= 400) return 'http-4xx';
  }

  const name = (error as { name?: unknown }).name;
  // `AbortError` is what our own `AbortController` timeout raises — the request
  // outlived its deadline, which is a timeout and not a cancellation. A caller
  // that deliberately aborts passes its own signal and lands in `cancelled` via
  // the message check below.
  if (name === 'TimeoutError') return 'timeout';
  if (name === 'SyntaxError') return 'parse';

  const code = codeOf(error) || codeOf((error as { cause?: unknown }).cause);
  if (NETWORK_CODES.includes(code)) return 'network';

  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (name === 'AbortError') return message.includes('cancel') || message.includes('user') ? 'cancelled' : 'timeout';
  if (message.includes('timed out') || message.includes('timeout')) return 'timeout';
  if (message.includes('abort') || message.includes('cancel')) return 'cancelled';
  if (message.includes('fetch failed') || message.includes('network') || message.includes('unreachable') || message.includes('socket')) return 'network';
  if (message.includes('json') || message.includes('unexpected token')) return 'parse';
  if (message.includes('stream')) return 'stream';
  return 'unknown';
}

/**
 * The same nine words, derived from a stored message — for rows written before
 * `error_class` existed, so a window that spans the change still adds up.
 *
 * This is the re-parse the design forbids going forward, and it is confined to
 * exactly that: rows with no class of their own. Nothing calls it on a new row.
 */
export function classifyStoredLlmError(error: string | null): LlmErrorClass {
  if (!error) return 'unknown';
  const e = error.toLowerCase();
  if (e.includes('429') || e.includes('rate limit')) return 'rate-limit';
  if (e.includes('401') || e.includes('403') || e.includes('authentication') || e.includes('no api key') || /\b4\d\d\b/.test(e)) return 'http-4xx';
  if (/\b5\d\d\b/.test(e)) return 'http-5xx';
  if (e.includes('timed out') || e.includes('timeout')) return 'timeout';
  if (e.includes('abort') || e.includes('cancel')) return 'cancelled';
  if (
    e.includes('fetch failed') ||
    e.includes('econnrefused') ||
    e.includes('enotfound') ||
    e.includes('unreachable') ||
    e.includes('socket') ||
    e.includes('network') ||
    e.includes('connection')
  )
    return 'network';
  // Ahead of the `stream` check on purpose: "TensorX API stream from
  // https://api.tensorx.ai/v1 failed" is an endpoint that never answered, not a
  // stream that broke mid-flight. These two messages and their bare-URL cousin
  // are 69 of this record's failures, and the shape that made this function
  // necessary — the old reader returned the message's first 48 characters, so
  // the ledger reported an endpoint URL as a reason.
  if (/https?:\/\//.test(error) && (e.includes('failed') || e.includes('error') || /^\s*https?:\/\/\S*\s*$/.test(error))) return 'network';
  if (e.includes('stream')) return 'stream';
  if (e.includes('json') || e.includes('unexpected token') || e.includes('not iterable')) return 'parse';
  return 'unknown';
}

/**
 * Strip credentials out of any URL inside a stored string.
 *
 * The ledger keeps error messages verbatim, and an error message is whatever
 * the failing layer chose to put in it — routinely the endpoint it was talking
 * to. An endpoint carries a key when the key travels as a query parameter
 * (`?api_key=…`, `?access_token=…`) or as userinfo (`https://user:pass@host`),
 * and once it is in `llm_audit.error` it is in every readout of the ledger, in
 * the card a model is shown, and in whatever gets pasted from either.
 *
 * So the query and the userinfo go, always, for every URL — not only for the
 * parameter names that look like secrets today. The host and path stay, because
 * "which endpoint" is the whole diagnostic value of the message.
 */
export function redactUrlCredentials(text: string): string {
  return text.replace(/\bhttps?:\/\/\S+/gi, (url) => {
    const withoutQuery = url.replace(/[?#].*$/, '');
    return withoutQuery.replace(/^(https?:\/\/)[^/@]*@/i, '$1');
  });
}
