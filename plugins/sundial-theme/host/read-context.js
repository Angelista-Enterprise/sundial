// How heavy the conversation has become: the last `ask` call's prompt tokens from Gnomon's own ledger, against the window the route declares and the threshold compaction acts on.
import { getRecentLlmAudit } from '@sundial/db/index.js'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'

/**
 * The window the openai route declares (`DEFAULT_CONTEXT_WINDOW`) and the
 * fraction `dsh-compaction-basic` acts on (`DEFAULT_THRESHOLD_RATIO`).
 *
 * Mirrored rather than imported: the first lives in another plugin's adapter
 * facts, the second inside a third-party plugin's config defaults, and neither
 * is exported. They are here so the gauge can say what it is measuring against;
 * if either moves, the gauge reads slightly wrong and nothing breaks. A model
 * named in config.json `llm.contextWindows` uses its own window, as the route does.
 */
const CONTEXT_WINDOW = 64_000

const COMPACT_THRESHOLD_RATIO = 0.8

export async function readContext() {
  // A small window, then the first `ask` in it: `getRecentLlmAudit`
  // takes no purpose filter and adding one for this would be a query
  // nobody else wants. Kernel purposes (`intent`, `journal`) interleave,
  // hence 24 rather than 1.
  const recent = await getRecentLlmAudit(24)
  const last = recent.find((row) => row.purpose === 'ask') ?? null
  const window = (last?.model && loadSundialConfig().llm.contextWindows?.[last.model]) || CONTEXT_WINDOW
  return {
    promptTokens: last?.promptTokens ?? null,
    model: last?.model ?? null,
    at: last?.requestedAt ?? null,
    contextWindow: window,
    compactAt: Math.floor(window * COMPACT_THRESHOLD_RATIO),
  }
}
