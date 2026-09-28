import { isTerminal } from '@sundial/helpers/window-classification.js';
import { ShellCapture, type ShellCommandCapture } from './shell-capture.js';

export interface ShellEvent {
  type: 'shell:command';
  payload: Record<string, unknown>;
}

/**
 * The terminal-focus gate applies to the HISTORY-FILE path only.
 *
 * WCS gated all shell reading on a focused terminal, and for history files
 * that is the only correct thing to do: a history line carries no cwd and no
 * producer, so the focused window is the sole evidence of which shell typed
 * it, and lines that accumulated while unfocused are re-seeked past on
 * re-focus (WCS's `startPolling()` behavior).
 *
 * A hook-file entry needs none of that — it carries its own cwd, exit code and
 * timestamp, which is why this class never re-seeked it. Gating it on focus
 * was therefore inherited, not reasoned, and it made the hook path unreachable
 * for the producer that needs it most: an agent's commands run while the owner
 * is looking at a browser, so a focus gate discards every one of them, and
 * `init()` would not even run until a terminal happened to be focused. The
 * 2026-08-16 tooling audit found exactly that — ~15 agent commands absent from
 * the lowest-level record while `gnomon_signals(shell)` answered confidently.
 *
 * So: hook file → read on every tick. History file → focus-gated, as before.
 */
export class ShellSensor {
  private readonly capture = new ShellCapture();
  private initialized = false;
  private wasFocused = false;

  poll(currentProcessName: string | null): ShellEvent[] {
    const focused = currentProcessName !== null && isTerminal(currentProcessName);

    // Initialization decides WHICH source is in use, so it cannot itself wait
    // for a focused terminal — that was the deadlock that kept the hook path
    // from ever being selected.
    if (!this.initialized) {
      this.capture.init();
      this.initialized = true;
      this.wasFocused = focused;
    }

    // Asked before the focus gate, not after: the gate returns early on the
    // history path, so a check made later could never see the hook file appear.
    if (this.capture.refreshSource()) {
      this.wasFocused = focused;
      return this.capture.readNewCommands().map(toEvent);
    }

    if (!focused) {
      this.wasFocused = false;
      return [];
    }
    if (!this.wasFocused) this.capture.reseekHistoryFileToNow();
    this.wasFocused = true;

    return this.capture.readNewCommands().map(toEvent);
  }
}

function toEvent(capture: ShellCommandCapture): ShellEvent {
  return { type: 'shell:command', payload: { ...capture } };
}
