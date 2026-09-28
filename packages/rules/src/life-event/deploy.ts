import { deriveId } from '@sundial/helpers/derive-id.js';
import type { Rule } from '@sundial/kernel/types.js';

/**
 * L1 (docs/audit/remediation-todo.md's standalone bug list) — `git push`
 * only counts as a deploy signal when pushed to a branch name that's
 * unambiguously deploy-related (`prod`/`production`/`release`), not
 * `main`/`master`. Those two are just the ordinary default branch name for
 * routine solo-repo work — `git push origin main` happens constantly for
 * completely unremarkable reasons (no CI/CD needs to exist for it to be
 * routine), and counting every one as a "deploy" polluted `event:deploy`'s
 * consumers (C2's `deployedVia` fact, any future deploy-triggered life
 * event) with false positives far more often than it caught a real deploy.
 */
const DEPLOY_RE =
  /\b(npm\s+publish|yarn\s+publish|pnpm\s+publish|cargo\s+publish|docker\s+push|git\s+push\s+(origin\s+)?(prod|production|release)|kubectl\s+apply|terraform\s+apply|fly\s+deploy|vercel\s+--prod|netlify\s+deploy\s+--prod|gcloud\s+app\s+deploy|rsync\s+.*deploy)\b/;

const DEPLOY_TARGETS: Array<[RegExp, string]> = [
  [/npm\s+publish/, 'npm'],
  [/yarn\s+publish/, 'yarn'],
  [/pnpm\s+publish/, 'pnpm'],
  [/cargo\s+publish/, 'cargo'],
  [/docker\s+push/, 'docker'],
  [/git\s+push/, 'git-push'],
  [/kubectl\s+apply/, 'kubernetes'],
  [/terraform\s+apply/, 'terraform'],
  [/fly\s+deploy/, 'fly'],
  [/vercel/, 'vercel'],
  [/netlify/, 'netlify'],
  [/gcloud/, 'gcloud'],
];

interface ShellCommandPayload {
  command?: string;
}

/** Ported verbatim from WCS's `LifeEventSensor.onShellCommand`'s deploy branch — stateless regex match. */
export const deploy: Rule = (state, event) => {
  if (event.type !== 'shell:command') return { state, effects: [] };

  const payload = event.payload as ShellCommandPayload;
  const command = typeof payload.command === 'string' ? payload.command : '';
  if (!DEPLOY_RE.test(command)) return { state, effects: [] };

  let target: string | null = null;
  for (const [re, name] of DEPLOY_TARGETS) {
    if (re.test(command)) {
      target = name;
      break;
    }
  }

  return {
    state,
    effects: [
      {
        type: 'EmitEvent',
        event: {
          id: deriveId(event.ts, event.id, 'deploy'),
          type: 'event:deploy',
          ts: event.ts,
          payload: { timestamp: event.ts, command, projectName: state.project.current?.name ?? null, target },
        },
      },
    ],
  };
};
