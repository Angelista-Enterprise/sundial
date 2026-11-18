/**
 * The phone's way in since 2026-11-03: Shortcuts post to an ntfy topic on the
 * always-on hub (`notifications.inbox`), and this reads that topic as a JSON
 * stream from the last message id it folded. The hub keeps the queue, so an
 * arrival posted while the laptop was shut lands when it wakes, with the time
 * the phone sent it. Replaces the loopback listener dropped on 2026-10-14.
 *
 * Same guard as that listener: only `phone:*` and `health:*` types, a phone can
 * add its own readings and nothing else. Payloads are checked by the rules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getSundialRuntimeDir } from '@sundial/helpers/sundial-paths.js';

const RETRY_MS = 30_000;

export interface PhoneInboxOptions {
  /** The ntfy topic URL, `notifications.inbox`. */
  url: string;
  /** `ctx.gnomonKernel.appendSignal` — sanitize-at-ingest + fold, serialized. */
  appendSignal: (type: string, payload: Record<string, unknown>, ts?: string) => Promise<void>;
  cursorPath?: string;
  fetch?: typeof fetch;
}

interface NtfyLine {
  id?: string;
  time?: number;
  event?: string;
  message?: string;
}

/** The accepted events in one ntfy message, each with a time: its own, else when the hub got it. */
export function eventsOf(line: NtfyLine): Array<{ type: string; payload: Record<string, unknown>; ts: string }> {
  if (line.event !== 'message' || typeof line.message !== 'string') return [];
  let body: unknown;
  try {
    body = JSON.parse(line.message);
  } catch {
    return [];
  }
  const events = (body as { events?: unknown })?.events;
  if (!Array.isArray(events)) return [];
  const sent = new Date((line.time ?? Date.now() / 1000) * 1000).toISOString();
  return events.flatMap((e) => {
    const { type, ts, payload } = (e ?? {}) as { type?: unknown; ts?: unknown; payload?: unknown };
    if (typeof type !== 'string' || !/^(phone|health):[a-z_-]+$/.test(type)) return [];
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return [];
    const at = typeof ts === 'string' && Number.isFinite(Date.parse(ts)) ? new Date(ts).toISOString() : sent;
    return [{ type, payload: payload as Record<string, unknown>, ts: at }];
  });
}

/** Reads the topic until stopped; reconnects after a drop. Returns the stop function. */
export function startPhoneInbox(options: PhoneInboxOptions): () => void {
  const cursorPath = options.cursorPath ?? path.join(getSundialRuntimeDir(), 'phone-inbox.cursor');
  const doFetch = options.fetch ?? fetch;
  const abort = new AbortController();
  let cursor = fs.existsSync(cursorPath) ? fs.readFileSync(cursorPath, 'utf-8').trim() : '';

  const take = async (raw: string): Promise<void> => {
    let line: NtfyLine;
    try {
      line = JSON.parse(raw) as NtfyLine;
    } catch {
      return;
    }
    if (line.event !== 'message' || !line.id) return;
    for (const e of eventsOf(line)) await options.appendSignal(e.type, e.payload, e.ts);
    cursor = line.id;
    fs.writeFileSync(cursorPath, cursor, { mode: 0o600 });
  };

  const run = async (): Promise<void> => {
    while (!abort.signal.aborted) {
      try {
        const res = await doFetch(`${options.url}/json?since=${cursor || 'all'}`, { signal: abort.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            await take(buffer.slice(0, nl));
            buffer = buffer.slice(nl + 1);
          }
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        console.warn('[sundial-sensors] phone inbox:', (error as Error).message);
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  };
  void run();
  return () => abort.abort();
}
