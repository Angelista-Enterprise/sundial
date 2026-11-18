import path from 'node:path';
import { getSundialHome } from '@sundial/helpers/config.js';
import { collectRun, runtimeFor, toChatCompletion, type RuntimeSource } from './runtime/index.js';
import type { ChatCompletionMessage, ChatCompletionResult } from './types.js';

/**
 * A kernel purpose answered by a vendor runtime on the owner's own login (the
 * `claude` source since 2026-10-05, `copilot` since step 4): one job on the
 * runtime port (`runtime/`), text in, text out. Measured first for Claude:
 * Sonnet named the owner's moments validly 40 of 40 times against qwen's 31
 * (docs/claude-only-mode.md). A call that passes tools gets Sundial's read
 * tools as MCP and runs them itself, so it answers with text and the kernel's
 * loop ends on its first round.
 */

/** The conversation as one prompt: a runtime takes a system prompt and one user turn. */
export function flatten(messages: readonly ChatCompletionMessage[]): { system: string; prompt: string } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');
  if (rest.length === 1 && rest[0]!.role === 'user') return { system, prompt: rest[0]!.content };
  const prompt = rest
    .map((m) => {
      if (m.role === 'tool') return `Tool result:\n${m.content}`;
      const calls = m.toolCalls?.length ? `\n(called ${m.toolCalls.map((c) => `${c.name}(${c.arguments})`).join(', ')})` : '';
      return `${m.role === 'assistant' ? 'Assistant' : 'User'}:\n${m.content}${calls}`;
    })
    .join('\n\n');
  return { system, prompt: `${prompt}\n\nAnswer as the assistant's next turn.` };
}

export async function callRuntime(
  source: RuntimeSource,
  messages: readonly ChatCompletionMessage[],
  opts: { model: string; withTools?: boolean; timeoutMs?: number },
): Promise<ChatCompletionResult> {
  const home = getSundialHome();
  const { system, prompt } = flatten(messages);
  // Under `.daemon/hands`: Claude Code registers every run as a session, and the fleet sensor skips
  // that folder as Sundial's own work, so 500 calls a day never show up as the owner's agents.
  const run = await collectRun(runtimeFor(source).run({ model: opts.model, cwd: path.join(home, '.daemon', 'hands', 'llm'), system, prompt, tools: opts.withTools ? 'read' : 'none', home, timeoutMs: opts.timeoutMs }));
  return toChatCompletion(run);
}
