import dns from 'node:dns';

/**
 * A host name that stops resolving for a moment keeps its last good address.
 *
 * Measured 2026-10-02 on the owner's Mac: the home network's DNS server
 * answered SERVFAIL to 11 of 263 queries in 15 minutes, and macOS keeps such an
 * answer for about 7 s. A host whose 60 s record came up for refresh in that
 * moment was `getaddrinfo ENOTFOUND` for those seconds, so a model call failed
 * all three tries (the retries took 2–4 ms: the kept failure, not a new query),
 * was dropped, and counted three times toward the route breaker. Separately,
 * macOS's own getaddrinfo failed 1 lookup in about 26,000 with the record in
 * cache. A DNS cache flush "fixed" it only by throwing the kept failure away.
 *
 * So the whole process (every `fetch` and socket goes through `dns.lookup`)
 * answers a failed lookup with the last address that worked for the same host
 * and options. Only a name that did not resolve: any other error, and a host
 * never resolved before, fail as they did. A stale address is safe: TLS still
 * checks the certificate against the host name.
 */
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const INSTALLED = Symbol.for('sundial.dnsLastGood');

type Lookup = (hostname: string, options: unknown, callback: (error: NodeJS.ErrnoException | null, ...answer: unknown[]) => void) => void;

export function installLastGoodLookup(): void {
  const target = dns as unknown as { lookup: Lookup; [INSTALLED]?: true };
  if (target[INSTALLED]) return;
  const lookup = target.lookup;
  const good = new Map<string, unknown[]>();
  target.lookup = function (this: unknown, hostname, options, callback) {
    const done = (typeof options === 'function' ? options : callback) as Parameters<Lookup>[2];
    const opts = (typeof options === 'function' ? {} : typeof options === 'number' ? { family: options } : (options ?? {})) as { all?: boolean; family?: unknown };
    const key = `${hostname}|${opts.all ? 'all' : ''}|${opts.family ?? 0}`;
    return lookup.call(this, hostname, opts, (error, ...answer) => {
      if (!error) good.set(key, answer);
      else if (DNS_CODES.has(error.code ?? '') && good.has(key)) {
        console.warn(`[sundial] DNS lookup for ${hostname} failed (${error.code}); using its last good address`);
        return done(null, ...good.get(key)!);
      }
      return done(error, ...answer);
    });
  };
  target[INSTALLED] = true;
}
