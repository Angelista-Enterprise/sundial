// lane H (H5)
/**
 * Prefix every console line with its ISO time, so `logs/sundial.log` can say
 * WHEN something happened. Idempotent: the plugins share one console, and a
 * reload (HMR) must not stamp a line twice. A string first argument is joined
 * rather than preceded, so a `%s` format string keeps working.
 */
const STAMPED = Symbol.for('sundial.console-stamped');

export function stampConsole(target: Console = console, now: () => Date = () => new Date()): void {
  const marked = target as Console & { [STAMPED]?: true };
  if (marked[STAMPED]) return;
  marked[STAMPED] = true;
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => {
      const ts = now().toISOString();
      if (typeof args[0] === 'string') original(`${ts} ${args[0]}`, ...args.slice(1));
      else original(ts, ...args);
    };
  }
}
