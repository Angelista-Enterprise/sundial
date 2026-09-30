// The global search's hits (`/gnomon/api/search`): the record through `gnomon_semantic_search`
// and the owner's own conversations through dsh's session index, searched together and shown apart.
// The route streams these, then a model's reading of them.
import { executeGnomonTool, toolEnv } from '@sundial/kernel/tools/index.js'

const SEARCH_RECORD_LIMIT = 12
const SEARCH_CONVERSATION_LIMIT = 6
/** One hit's text, on one prompt line. Long enough to carry a claim, short enough that 18 of them are still cheap. */
const SEARCH_LINE_CHARS = 240

/**
 * The owner's own conversations, searched.
 *
 * dsh refuses a search when the set of live sessions moved between its two
 * observations and retries only once; under Gnomon's work loop a child
 * starting mid-search is an ordinary moment, not a fault. Same wait-it-out as
 * `gnomon_conversation_search`, which cannot be called from here: that tool
 * lives in dsh's registry, and this route reads the kernel's.
 *
 * A corpus that cannot be searched says so. It returns `{hits, unavailable}`
 * rather than an empty list, because a silently missing half of a GLOBAL
 * search is the one failure the owner cannot detect: "nothing was said about
 * this" and "the index would not open" draw identically as no rows, and only
 * one of them is a finding.
 */
async function searchConversations(query, sessionQuery) {
  if (typeof sessionQuery?.searchSessions !== 'function') return { hits: [], unavailable: 'This profile has no conversation index.' }
  for (let attempt = 1; ; attempt += 1) {
    try {
      const page = await sessionQuery.searchSessions({ query, limit: SEARCH_CONVERSATION_LIMIT })
      // dsh answers `{items: [{header, bestMatch}]}` — one row per session,
      // carrying the single event that matched. `time` is epoch ms and `type`
      // is `<role>/<what>`; the view wants an ISO instant and a bare role.
      const items = Array.isArray(page?.items) ? page.items : []
      return {
        hits: items.map((item) => {
          const match = item?.bestMatch ?? {}
          return {
            sessionId: String(item?.header?.id ?? match.sessionId ?? ''),
            at: Number.isFinite(match.time) ? new Date(match.time).toISOString() : null,
            role: String(match.type ?? '').split('/')[0],
            excerpt: String(match.snippet ?? ''),
          }
        }),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (attempt < 4 && /did not stabilize/.test(message)) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
        continue
      }
      console.error(`[sundial-shell] conversation search failed: ${message}`)
      // One unreadable session log takes the whole index down with it — the
      // same `unsupported descriptor version` that already fails
      // `/gnomon/api/session` on those sessions. Name that, rather than the
      // stack: the owner can act on "one conversation cannot be read".
      return { hits: [], unavailable: /descriptor version/.test(message) ? 'A conversation log this dsh cannot read is blocking the index.' : `The conversation index did not answer: ${message}` }
    }
  }
}

const cut = (text, n) => (text.length > n ? `${text.slice(0, n)}…` : text)

/** Both corpora at once: neither waits on the other, and a failure in one still shows the other rather than emptying the card. */
export async function readSearch({ query, state, sessionQuery }) {
  const [record, talk] = await Promise.all([
    executeGnomonTool('gnomon_semantic_search', { query, limit: SEARCH_RECORD_LIMIT }, toolEnv(() => state))
      .then((hits) => (Array.isArray(hits) ? hits : []))
      .catch((error) => {
        console.error(`[sundial-shell] record search failed: ${error instanceof Error ? error.message : String(error)}`)
        return []
      }),
    searchConversations(query, sessionQuery),
  ])
  return { record, conversations: talk.hits, ...(talk.unavailable ? { conversationsUnavailable: talk.unavailable } : {}) }
}

/** The hits as the reading's prompt lines. The instant is explicit: `label` is the hit's own words. */
export const searchLines = ({ record, conversations }) => [
  ...record.map((hit) => `- [${hit.refType}] ${hit.at ?? ''} ${hit.label ?? ''} — ${cut(String(hit.text ?? ''), SEARCH_LINE_CHARS)}`),
  ...conversations.map((hit) => `- [conversation] ${hit.at ?? ''} ${hit.role} — ${cut(hit.excerpt, SEARCH_LINE_CHARS)}`),
]
