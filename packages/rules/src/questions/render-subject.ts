/**
 * The template render (J1.2): Jev points at which field of the evidence
 * names the work; this turns the pointer into the one-line reading the
 * Recorded view shows. Names only what is IN the evidence — a guessed
 * project name is impossible by construction. Pure; the lab renders the
 * same lines for the side-by-side, from `dist`.
 *
 * `spoken` and `commands` are the two subjects with no template: what the
 * owner said, and what the shell was doing, need a sentence — those go to
 * the text model (tier 1), and then through `verifyLine`.
 */
export type SubjectKey = 'project' | 'branch' | 'meeting' | 'spoken' | 'commands' | 'window' | 'app';
export const TEXT_RENDER_SUBJECTS: ReadonlySet<string> = new Set(['spoken', 'commands']);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const lastSegment = (p: unknown): string | null => (str(p) ? str(p)!.replace(/\/+$/, '').split('/').pop() || null : null);
const MAX = 70;

/** Is the field the subject points at actually present? A pick at a null field is a bad pick, and falls through to the next available subject. */
export function subjectAvailable(subject: string, evidence: Record<string, unknown>): boolean {
  switch (subject) {
    case 'project':
      return str(evidence.project) !== null;
    case 'branch':
      return str(evidence.git_branch) !== null;
    case 'meeting':
      return str(evidence.meeting_title) !== null;
    case 'spoken':
      return str(evidence.heard_aloud) !== null;
    case 'commands':
      return Array.isArray(evidence.shell_commands) && evidence.shell_commands.length > 0;
    case 'window':
      return Array.isArray(evidence.window_titles) && evidence.window_titles.some((t) => str(t) !== null);
    case 'app':
      return true;
    default:
      return false;
  }
}

/** The order a missing subject falls through in: the most specific thing the evidence still has. */
const FALLBACK: SubjectKey[] = ['meeting', 'project', 'branch', 'window', 'app'];

/** The subject to render: Jev's pick when its field exists, else the most specific available one. Never `spoken`/`commands` on fallback — those need the text model. */
export function resolveSubject(pick: string | null | undefined, evidence: Record<string, unknown>): SubjectKey {
  if (pick && subjectAvailable(pick, evidence)) return pick as SubjectKey;
  return FALLBACK.find((s) => subjectAvailable(s, evidence)) ?? 'app';
}

/** One line under 70 chars from a template subject. `null` for the two subjects that need a sentence. */
export function renderSubject(subject: SubjectKey, evidence: Record<string, unknown>): string | null {
  const project = lastSegment(evidence.project);
  const branch = str(evidence.git_branch);
  const app = str(evidence.app) ?? 'an app';
  switch (subject) {
    case 'meeting':
      return `Meeting: ${str(evidence.meeting_title)}`.slice(0, MAX);
    case 'project':
      return `Working on ${project}${branch && branch !== 'main' && branch !== 'master' ? ` (${branch})` : ''}`.slice(0, MAX);
    case 'branch':
      return `On ${branch}${project ? ` in ${project}` : ''}`.slice(0, MAX);
    case 'window': {
      const titles = (evidence.window_titles as unknown[]).map(str).filter((t): t is string => t !== null);
      return `${app}: ${titles[0]}`.slice(0, MAX);
    }
    case 'app':
      return `In ${app}`.slice(0, MAX);
    default:
      return null;
  }
}
