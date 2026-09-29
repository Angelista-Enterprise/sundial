import type { ToolDefinition } from '@sundial/llm/types.js';
import { CONTEXT_TOOLS } from './context-tools.js';
// lane B
import { BRIEF_TOOLS } from './brief-tools.js';
import { EVIDENCE_TOOLS } from './evidence-tools.js';
import { FIGURE_TOOLS } from './figure-tools.js';
// lane D
import { HANDOFF_TOOLS } from './handoff-tools.js';
import { MEMORY_TOOLS } from './memory-tools.js';
import { TREND_TOOLS } from './trend-tools.js';
import { RECALL_TOOLS } from './recall-tools.js';
import { executeTool, toolDefinitions, type GnomonTool } from './registry.js';

export { UnknownToolError, ToolArgumentError, type GnomonTool } from './registry.js';
export { ASK_SYSTEM_PROMPT } from './ask-prompt.js';

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
// lane D: HANDOFF_TOOLS (#20); lane C: TREND_TOOLS; lane B: BRIEF_TOOLS; lane A: RECALL_TOOLS; the figures stay last.
export const TOOL_REGISTRY: GnomonTool[] = [...EVIDENCE_TOOLS, ...CONTEXT_TOOLS, ...MEMORY_TOOLS, ...HANDOFF_TOOLS, ...TREND_TOOLS, ...BRIEF_TOOLS, ...RECALL_TOOLS, ...FIGURE_TOOLS];

/**
 * What the chat may call. The same list MCP is advertised since
 * `gnomon_show_view`, the one tool that drove the app window, was deleted
 * (2026-09-28): the chat moves the owner's view through `gnomon_board`, which
 * is not a kernel tool. A tool that drives the window belongs to the surface
 * that IS the window, never to this shared list.
 */
export const ASK_TOOL_REGISTRY: GnomonTool[] = TOOL_REGISTRY;

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
