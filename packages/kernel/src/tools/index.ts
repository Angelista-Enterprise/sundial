import type { ToolDefinition } from '@sundial/llm/types.js';
import { CONTEXT_TOOLS } from './context-tools.js';
import { EVIDENCE_TOOLS } from './evidence-tools.js';
import { FIGURE_TOOLS } from './figure-tools.js';
import { MEMORY_TOOLS } from './memory-tools.js';
import { VIEW_TOOLS } from './view-tools.js';
import { executeTool, toolDefinitions, type GnomonTool } from './registry.js';

export { UnknownToolError, ToolArgumentError, type GnomonTool } from './registry.js';
export { ASK_SYSTEM_PROMPT, askContextBlock } from './ask-prompt.js';
export { VIEW_TOOLS, type ShowViewRequest } from './view-tools.js';

/**
 * Every tool Gnomon exposes, in the order a model reads them.
 *
 * Evidence first, deliberately. A model shown `gnomon_semantic_search` at the
 * top of a ten-tool list reaches for it by default, and semantic search is the
 * wrong instrument for most of what gets asked — it ranks, it cannot filter or
 * aggregate. Leading with the tools that take a date and a project makes the
 * filter-shaped question find the filter-shaped tool.
 */
/**
 * Figures come LAST, after every tool that fetches evidence, and the ordering
 * argument above is why: a model shown the drawing tool early reaches for it
 * before it has anything to draw. A figure is composed from what the evidence
 * tools already established, so it belongs at the end of the list the same way
 * it belongs at the end of the work.
 */
export const TOOL_REGISTRY: GnomonTool[] = [...EVIDENCE_TOOLS, ...CONTEXT_TOOLS, ...MEMORY_TOOLS, ...FIGURE_TOOLS];

/**
 * What `/ask` may call: everything shared, plus the tools that drive this app.
 *
 * The split exists because `TOOL_REGISTRY` has two consumers and only one of
 * them is a window. MCP runs in the same user session and is advertised the
 * shared list; if `gnomon_show_view` were in it, Claude Code could move the
 * owner's app while they were reading something else — an actuation on their
 * screen that nobody asked for, arriving from a third party. A tool that drives
 * THIS surface belongs only to THIS surface.
 *
 * Everything read-only stays in the shared list, so the drift that moving the
 * registry here fixed cannot come back: a new evidence tool is still defined
 * once and reaches both.
 */
export const ASK_TOOL_REGISTRY: GnomonTool[] = [...TOOL_REGISTRY, ...VIEW_TOOLS];

/** The registry as OpenAI-format function definitions, for `/ask`'s tool loop. */
export function gnomonToolDefinitions(): ToolDefinition[] {
  return toolDefinitions(ASK_TOOL_REGISTRY);
}

/**
 * Validate and run one tool by name. Throws `UnknownToolError` /
 * `ToolArgumentError` / whatever the handler throws — the tool loop turns each
 * into a result the model reads and retries against.
 */
export async function executeGnomonTool(name: string, args: unknown): Promise<unknown> {
  return executeTool(ASK_TOOL_REGISTRY, name, args);
}
