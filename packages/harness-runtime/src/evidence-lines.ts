// Moved from runtime.ts (a pure move, W5): the evidence clauses and the skeptic's reply parser.

/**
 * Longest run of speech carried on ONE evidence line. `momentRollup` caps a
 * moment's own excerpt at 600, and 60 moments of that is 36k characters of
 * transcript in a prompt whose other 60 lines are short — the speech would
 * drown the window-title evidence rather than join it. 240 matches the screen
 * excerpt's cap and keeps the whole pass in the same order of magnitude it had.
 */
const SPOKEN_EVIDENCE_CHARS = 240;

/**
 * The `said: "…"` clause on one evidence line — the tail of what was heard
 * while that moment was open.
 *
 * Why this exists at all: ambient hearing reached `moments` and stopped there.
 * Nothing read `spokenExcerpt`, so the single richest source of owner facts —
 * the owner's own words, and their colleagues' — fed neither the knowledge
 * graph nor retrieval, exactly the crossing the retired enhancement page
 * conversation-memory described as missing (now almanac/concepts/memory-tiers). Speech enters here rather than through a new rule
 * because this pass ALREADY reads the day's rollups and already funnels its
 * output through the ordinary `entity:fact-candidate` gate.
 *
 * It is quoted, and labelled `said`, on purpose. A window title is a thing the
 * machine observed; a transcript line is a thing whisper GUESSED, and this
 * corpus is bilingual Dutch/English where proper nouns come back mangled. The
 * prompt leans on that label to hold speech-only claims below the confidence
 * where a fact becomes expensive to unseat.
 */
export function spokenEvidence(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const said = raw.trim();
  if (said === '' || said === '[private]') return '';
  const tail = said.length > SPOKEN_EVIDENCE_CHARS ? said.slice(said.length - SPOKEN_EVIDENCE_CHARS) : said;
  return ` — said: "${tail.replace(/"/g, "'")}"`;
}

/** The `with: …` clause naming who was in a meeting, for one evidence line. Ported verbatim (see the daemon's long rationale comment). */
export function meetingAttendeeEvidence(raw: unknown, ownerAliases: string[]): string {
  if (!Array.isArray(raw) || raw.length === 0) return '';
  const owners = new Set(ownerAliases.map((a) => a.trim().toLowerCase()));
  const names = [
    ...new Set(
      raw
        .filter((a): a is string => typeof a === 'string')
        .map((a) => a.trim())
        .filter((a) => a.length > 0 && !owners.has(a.toLowerCase())),
    ),
  ];
  return names.length === 0 ? '' : ` — with: ${names.join(', ')}`;
}

/** One refutation the model claims to have made, as it comes back over the wire. */
interface RefutationVerdict {
  factId: string;
  refuted: boolean;
  correctedObject?: string;
  reason?: string;
}

/** Parses the skeptic's reply, discarding anything it cannot vouch for. Ported verbatim. */
export function parseRefutationVerdicts(content: string, knownFactIds: Set<string>): RefutationVerdict[] {
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const out: RefutationVerdict[] = [];
  for (const row of parsed) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const factId = typeof r.factId === 'string' ? r.factId : '';
    if (!knownFactIds.has(factId) || seen.has(factId)) continue;
    if (r.refuted !== true) continue;
    seen.add(factId);
    out.push({
      factId,
      refuted: true,
      correctedObject: typeof r.correctedObject === 'string' && r.correctedObject.trim() !== '' ? r.correctedObject.trim() : undefined,
      reason: typeof r.reason === 'string' ? r.reason : undefined,
    });
  }
  return out;
}
