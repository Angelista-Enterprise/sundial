/**
 * Set 3 R3: the web hosts a fetch may reach after a private read without asking, when it carries no data shape
 * (sundial-actions gate.js underEgress): each host and its subdomains. `web.knownHosts` in config.json replaces the list.
 */
export interface WebConfig {
  knownHosts: string[];
}

export const DEFAULT_KNOWN_HOSTS = ['wikipedia.org', 'wikimedia.org', 'wiktionary.org', 'github.com', 'stackoverflow.com', 'developer.apple.com', 'developer.mozilla.org', 'npmjs.com', 'nodejs.org', 'python.org'];

export const DEFAULT_WEB_CONFIG: WebConfig = { knownHosts: DEFAULT_KNOWN_HOSTS };

/** `web` from config.json: a `knownHosts` list replaces the default one, lower case, empty entries dropped; anything else keeps the default. */
export function resolveWeb(value: unknown): WebConfig {
  const hosts = (value as { knownHosts?: unknown } | null | undefined)?.knownHosts;
  return { knownHosts: Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === 'string' && h.trim() !== '').map((h) => h.trim().toLowerCase()) : DEFAULT_KNOWN_HOSTS };
}
