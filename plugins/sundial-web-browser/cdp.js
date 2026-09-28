// A minimal Chrome DevTools Protocol client, on Node's built-in WebSocket.
//
// No dependency: Node 22 ships a global `WebSocket`, and CDP is a plain
// JSON-over-WebSocket request/response protocol with an event channel. Pulling
// in puppeteer to open a tab and read its text would add a browser download and
// a large dependency tree for the four commands used here.
//
// The target is the owner's OWN Chrome, started with `--remote-debugging-port`.
// That is the whole point: pages load with the owner's existing sessions and
// cookies, so a docs page behind a login reads the same way it does for them,
// and there is no third-party API quota to run out of.
//
// Named exports only.

/** One command may not hang the tool call forever if Chrome stops answering. */
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/** Discover the browser-level WebSocket URL. The only plain-HTTP step CDP requires. */
export async function discoverBrowserSocket(endpoint, signal) {
  let response;
  try {
    response = await fetch(new URL('/json/version', endpoint), { signal });
  } catch (cause) {
    // Node's own message here is a bare "fetch failed", which the live audit
    // trail recorded verbatim and which tells nobody what to do. Say what was
    // actually tried and what would fix it.
    if (signal?.aborted) throw new Error('the web request was cancelled');
    throw new Error(`no browser is listening for DevTools connections at ${endpoint}`, { cause });
  }
  if (!response.ok) throw new Error(`CDP endpoint ${endpoint} answered HTTP ${response.status}`);
  const info = await response.json();
  const url = info?.webSocketDebuggerUrl;
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error(`CDP endpoint ${endpoint} returned no webSocketDebuggerUrl`);
  }
  return url;
}

/**
 * Connect to a CDP WebSocket and return a small client.
 *
 * The client multiplexes: every command gets an incrementing id and resolves
 * when the reply with that id arrives, while unsolicited frames (no `id`) are
 * CDP events and go to the event listeners. That is the whole protocol.
 */
export async function connectCdp(socketUrl, { WebSocketImpl = WebSocket, commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
  const socket = new WebSocketImpl(socketUrl);
  const pending = new Map();
  const listeners = new Set();
  let nextId = 0;
  let closedReason = null;

  const failAll = (reason) => {
    closedReason = reason;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    pending.clear();
  };

  socket.addEventListener('message', (event) => {
    let frame;
    try {
      frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return; // Not our protocol; ignore rather than tear down the connection.
    }
    if (frame.id !== undefined && pending.has(frame.id)) {
      const { resolve, reject, timer } = pending.get(frame.id);
      pending.delete(frame.id);
      clearTimeout(timer);
      // A CDP error is a normal reply with an `error` member, not a socket fault.
      if (frame.error) reject(new Error(`${frame.error.message ?? 'CDP error'} (${frame.error.code ?? 'no code'})`));
      else resolve(frame.result ?? {});
      return;
    }
    if (typeof frame.method === 'string') {
      for (const listener of listeners) listener(frame);
    }
  });

  socket.addEventListener('close', () => failAll('CDP socket closed'));
  socket.addEventListener('error', () => failAll('CDP socket error'));

  await new Promise((resolve, reject) => {
    if (socket.readyState === 1) return resolve();
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`could not open a CDP socket to ${socketUrl}`)), { once: true });
  });

  return {
    /** Send one command. `sessionId` targets an attached page rather than the browser. */
    send(method, params = {}, sessionId) {
      if (closedReason) return Promise.reject(new Error(closedReason));
      const id = ++nextId;
      const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP command ${method} timed out after ${commandTimeoutMs}ms`));
        }, commandTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          socket.send(JSON.stringify(message));
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    },

    /** Observe every CDP event; returns a disposer. */
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Resolve on the first event matching `method` (and `predicate`), or reject on timeout. */
    waitFor(method, { predicate = () => true, timeoutMs = commandTimeoutMs } = {}) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          dispose();
          reject(new Error(`timed out after ${timeoutMs}ms waiting for ${method}`));
        }, timeoutMs);
        const dispose = this.on((frame) => {
          if (frame.method !== method || !predicate(frame)) return;
          clearTimeout(timer);
          dispose();
          resolve(frame);
        });
      });
    },

    close() {
      try {
        socket.close();
      } catch {
        // Already closing.
      }
    },
  };
}
