// Effects that spend a model call (or start work that does): each hands off to its dispatcher on the runtime.
import { systemOneBackend } from '@sundial/llm/index.js';
import type { Handlers } from './index.js';

export const THINK = {
  ScheduleLLM: (host, effect) => host.dispatchScheduleLLM(effect),
  Judge: (host, effect) => host.dispatchJudge(effect),
  RunGoalTrial: (host, effect) => host.dispatchRunGoalTrial(effect),
  RunReflection: (host, effect) => host.dispatchRunReflection(effect),
  RunFactExtraction: (host, effect) => host.dispatchRunFactExtraction(effect),
  ResolveAliases: (host, effect) => host.dispatchResolveAliases(effect),
  RunConversationExtraction: (host, effect) => host.dispatchRunConversationExtraction(effect),
  RunMeetingPromises: (host, effect) => host.dispatchRunMeetingPromises(effect),
  RunRefutation: (host, effect) => host.dispatchRunRefutation(effect),
  RunBeliefAudit: (host, effect) => host.dispatchRunBeliefAudit(effect),
  RunAliasAlignment: (host, effect) => {
    if (host.getState() && systemOneBackend() !== 'off') host.defer(() => void host.performAliasAlignment(effect), 0);
  },
  RunAskHarvestBackfill: (host) => host.dispatchRunAskHarvestBackfill(),
  RunJournal: (host, effect) => host.dispatchRunJournal(effect),
  RunGoalPlan: (host, effect) => host.dispatchRunGoalPlan(effect),
  RunRejudge: (host, effect) => host.dispatchRunRejudge(effect),
  StartJob: (host, effect) => host.act(effect),
  StartSubagent: (host, effect) => host.act(effect),
} satisfies Handlers;
