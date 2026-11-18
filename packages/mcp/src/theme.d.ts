/**
 * The one web-client reader the MCP server still calls (B2): the goals. It is plain
 * JavaScript in `plugins/sundial-theme/host/`, and stays there because its logic is
 * shared with the browser shell (`shell/goals.js`), which no package can import. Today,
 * the rhythm and the open question moved into `packages/kernel/src/read/` on 2026-10-05.
 * Typed loosely on purpose: the shape is the route's, and the page draws what the route says.
 */
declare module '@sundial/dsh-theme/host/read-goals.js' {
  export function readGoals(args: { now: number }): Promise<{ goals: Record<string, unknown>[]; quietAfterDays: number }>;
}
