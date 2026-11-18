import type { ChatCompletionMessage, ChatCompletionResult, ToolDefinition } from './types.js';

/**
 * The one seam between the kernel's background calls and a model the raw
 * OpenAI-compatible fetch in `transport.ts` cannot speak to (an
 * Anthropic-messages or OpenAI-responses provider). The kernel runs inside the
 * dsh process, so the implementation is `ctx.llm.stream` over dsh's adapters
 * (plugins/sundial-kernel/dsh-model-port.js): the same routes, credentials and
 * retry the chat uses. A process with no kernel (the MCP server, a lab script)
 * has no port, and such a call fails with a plain message. If Sundial ever
 * leaves dsh, only the implementation changes (docs/provider-implementation.md, step 2).
 */
export interface ModelPortRequest {
  route: string;
  model: string;
  messages: ChatCompletionMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}
export interface ModelPort {
  complete(request: ModelPortRequest): Promise<ChatCompletionResult>;
}

let port: ModelPort | null = null;
export function setModelPort(next: ModelPort | null): void {
  port = next;
}
export function getModelPort(): ModelPort | null {
  return port;
}
