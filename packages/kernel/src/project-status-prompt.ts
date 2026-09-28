import { JOURNAL_TLDR_MAX_CHARS, JOURNAL_NARRATIVE_TARGET_CHARS } from './daily-journal-prompt.js';
import { EVIDENCE_DISCIPLINE, NO_DIAGNOSIS, withPersona } from './persona.js';
import type { ProjectStatusContext } from './project-context.js';
import type { ChatMessage, MomentKind } from './types.js';

// The output shape is the SAME as the daily journal's `JournalResult`
// (tldr/narrative/noticed/followups), so the parser (and the length budget it
// enforces), the structured-entry persistence, and the UI's section renderer
// are all reused — only the prompt and the serialized context differ. See
// `daily-journal-prompt.ts`.

const SYSTEM_PROMPT = withPersona(
  EVIDENCE_DISCIPLINE,
  NO_DIAGNOSIS,
  [
  'Today you are writing a rolling STATUS summary for a single software project of the owner\'s, from its recent activity log.',
  "Write in their own voice — natural prose, first person implied (never \"the user\"). This is about where the project stands lately, not a play-by-play of one day.",
  'This is read in a small, fixed-height card, not a page — brevity is part of the brief, not a fallback for a quiet project.',
  'Respond with STRICT JSON only, no markdown fencing, matching exactly:',
  '{"tldr":"...","narrative":"...","noticed":["..."],"followups":["..."]}',
  `- "tldr": ONE sentence on where the project stands and its momentum (actively moving, stalled, wrapping up, just started). Under ${JOURNAL_TLDR_MAX_CHARS} characters.`,
  `- "narrative": 2-3 SHORT paragraphs (use \\n\\n between them), about ${JOURNAL_NARRATIVE_TARGET_CHARS} characters total, on the recent trajectory — what has been happening, what changed, what the work has centered on. Quote branch names, ticket IDs, and window titles VERBATIM when they carry signal. Do not invent motivation the log does not support.`,
  '- "noticed": 2-4 non-obvious observations grounded in a specific number, date, or branch from the log (e.g. a drop-off, a long-lived branch, a phase imbalance), each ONE sentence. Empty array if none are well-supported.',
  '- "followups": concrete open loops for THIS project only — a dirty/unmerged branch, an area left mid-change, a ticket referenced but not closed. One short line per distinct piece of work. Empty array if none.',
  ].join('\n'),
);

// ─── Serialization of ProjectStatusContext → the user message ────────────────

/** YYYY-MM-DD → readable; the context dates are already local YYYY-MM-DD. */
function phaseMixLine(phaseMix: Record<MomentKind, number>): string {
  return (Object.entries(phaseMix) as [MomentKind, number][])
    .filter(([, min]) => min > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, min]) => `${k} ${min}m`)
    .join(', ');
}

/** Serialize a ProjectStatusContext into the plain-text log the model reads. Public for testing. */
export function serializeProjectStatusContext(ctx: ProjectStatusContext): string {
  const lines: string[] = [];
  lines.push(`PROJECT: ${ctx.name}${ctx.org ? ` · ${ctx.org}` : ''}`);
  if (ctx.rootPath) lines.push(`ROOT: ${ctx.rootPath}`);
  lines.push(
    `ACTIVITY: ${ctx.totalTrackedMin} tracked min across ${ctx.momentCount} moments, ${ctx.span.daysActive} active day${ctx.span.daysActive === 1 ? '' : 's'}` +
      `${ctx.span.firstActivity ? ` (${ctx.span.firstActivity.slice(0, 10)} → ${ctx.span.lastActivity!.slice(0, 10)})` : ''}`,
  );
  if (ctx.commits || ctx.branches.length) {
    lines.push(`GIT: ${ctx.commits} commit${ctx.commits === 1 ? '' : 's'}${ctx.branches.length ? `, branches ${ctx.branches.join(', ')}` : ''}`);
  }

  const phaseMix = phaseMixLine(ctx.phaseMix);
  if (phaseMix) lines.push(`PHASE MIX: ${phaseMix}`);
  lines.push(`FOCUS: deep ${ctx.focus.deepMin}m, steady ${ctx.focus.steadyMin}m, shallow ${ctx.focus.shallowMin}m`);

  if (ctx.momentum.length) {
    lines.push(`MOMENTUM (min/day): ${ctx.momentum.map((p) => `${p.date}:${p.minutes}`).join(' ')}`);
  }

  if (ctx.recent.length) {
    lines.push('RECENT (newest first):');
    lines.push(...ctx.recent.map((r) => `- ${r.date}: ${r.text}`));
  }
  return lines.join('\n');
}

export function buildProjectStatusMessages(ctx: ProjectStatusContext): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: serializeProjectStatusContext(ctx) },
  ];
}
