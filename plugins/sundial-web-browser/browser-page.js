// Load one URL in a throwaway tab of the owner's Chrome and read it back.
//
// The tab is created, used and closed per request. A long-lived tab would
// accumulate state across unrelated fetches and would sit visible in the
// owner's window list; a fresh one is cheap and leaves no trace.
//
// Named exports only.

/** Bodies are capped here, at acquisition — a 40MB page must never reach a prompt. */
export const MAX_BODY_CHARS = 200_000;

/** Wall-clock bound on one page load, independent of the per-command CDP timeout. */
export const DEFAULT_LOAD_TIMEOUT_MS = 30_000;

/**
 * Only http(s). CDP would happily navigate to `file://`, `chrome://` or
 * `devtools://`, which would turn a model-chosen URL into a local file read
 * and an escape from the sandbox the rest of the harness enforces.
 */
export function assertFetchableUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`not a valid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`refusing to open ${parsed.protocol}// — only http and https are fetchable`);
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error(`refusing to open ${parsed.hostname} — this Mac and your local network are not fetchable (a model-chosen URL could read Sundial's own API or a router)`);
  }
  if (parsed.username || parsed.password) throw new Error('refusing a URL with credentials in it');
  return parsed.toString();
}

/**
 * Loopback, link-local, private-range and `.local` names, as written in the
 * URL. A public name that RESOLVES to a private address is not caught here —
 * Chrome resolves it — so this closes the direct path, not DNS rebinding.
 */
export function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '0.0.0.0' || h === '::' || h === '::1') return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h) || /^fe80:/.test(h) || h.startsWith('::ffff:')) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Cap a body and say so, rather than silently handing back a prefix. */
export function capBody(text, maxChars = MAX_BODY_CHARS) {
  if (text.length <= maxChars) return { content: text, truncated: false };
  return { content: text.slice(0, maxChars), truncated: true };
}

/**
 * The page-side extractor, evaluated inside the tab.
 *
 * `innerText` rather than `textContent`: it respects layout, so it skips
 * `display:none` boilerplate and keeps the line breaks that make a page
 * readable. Falls back to the document element for pages with no `body`.
 */
export const EXTRACT_EXPRESSION = `(() => {
  const el = document.body || document.documentElement;
  return {
    title: document.title || '',
    url: location.href,
    text: el ? (el.innerText || el.textContent || '') : '',
  };
})()`;

/**
 * Open `url` in a new tab, wait for load, read the rendered text, close the tab.
 *
 * @returns { url, statusCode, title, text, truncated }
 */
export async function loadPage(client, url, { loadTimeoutMs = DEFAULT_LOAD_TIMEOUT_MS, maxBodyChars = MAX_BODY_CHARS } = {}) {
  const target = await client.send('Target.createTarget', { url: 'about:blank' });
  const targetId = target.targetId;
  let sessionId;
  try {
    ({ sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true }));

    // Network gives the status code, which the DOM cannot. A non-2xx page is a
    // RESULT, not an error — the seam's contract — so the code is carried back
    // rather than thrown.
    await client.send('Network.enable', {}, sessionId);
    await client.send('Page.enable', {}, sessionId);

    let statusCode = 0;
    const disposeStatus = client.on((frame) => {
      if (frame.sessionId !== sessionId) return;
      // The first Document response IS the navigation's own; later ones are
      // sub-frames (ads, embeds) and must not overwrite it.
      if (frame.method === 'Network.responseReceived' && frame.params?.type === 'Document' && statusCode === 0) {
        statusCode = frame.params.response?.status ?? 0;
      }
    });

    try {
      const loaded = client.waitFor('Page.loadEventFired', {
        predicate: (frame) => frame.sessionId === sessionId,
        timeoutMs: loadTimeoutMs,
      });
      const navigation = await client.send('Page.navigate', { url }, sessionId);
      if (navigation.errorText) throw new Error(`navigation failed: ${navigation.errorText}`);
      await loaded;
    } finally {
      disposeStatus();
    }

    const evaluated = await client.send(
      'Runtime.evaluate',
      { expression: EXTRACT_EXPRESSION, returnByValue: true, awaitPromise: false },
      sessionId,
    );
    const value = evaluated?.result?.value ?? {};
    const { content, truncated } = capBody(String(value.text ?? ''), maxBodyChars);

    return {
      // The URL AFTER redirects — the seam asks for the final one.
      url: typeof value.url === 'string' && value.url.length > 0 ? value.url : url,
      // A page that loaded but reported no Document response (a cached or
      // synthetic navigation) is reported as 200 rather than a false 0.
      statusCode: statusCode === 0 ? 200 : statusCode,
      title: String(value.title ?? ''),
      text: content,
      truncated,
    };
  } finally {
    // Always close the tab, including on a failed navigation — otherwise a
    // broken URL leaves a blank tab in the owner's browser every time.
    try {
      await client.send('Target.closeTarget', { targetId });
    } catch {
      // Browser already gone; nothing to clean up.
    }
  }
}
