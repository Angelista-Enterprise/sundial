import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * One device seen on the local subnet, already pseudonymised.
 *
 * There is deliberately no field carrying the MAC address. Hashing happens here,
 * in the capture layer, rather than in `sanitizeAtIngest` where the rest of
 * Gnomon's redaction lives — and the exception is intentional. Every other
 * redaction trims a value that legitimately had to be read into an event first
 * (a window title, a URL, a shell command). A MAC address never needs to be in
 * an event at all: the only question this sensor answers is "how many known
 * devices are here", and a stable opaque token answers it completely. Keeping
 * the raw address out of the payload entirely means it cannot leak through a
 * path that forgets to sanitize, and there is no such path to audit.
 *
 * `dev_` prefix mirrors `networkKeyFor`'s `net2_`, so a hash is identifiable as
 * a device rather than looking like an arbitrary hex string in a log.
 */
export interface PresenceDevice {
  hash: string;
}

export function hashDeviceId(mac: string): string {
  return 'dev_' + createHash('sha256').update(mac.trim().toLowerCase()).digest('hex').slice(0, 12);
}

/**
 * Parses `arp -an` output into pseudonymised device hashes.
 *
 * The ARP table is deliberately the source rather than an active mDNS or ping
 * sweep. It is already populated by ordinary traffic, so reading it is passive:
 * no packets are sent, nothing on the network can tell it happened, and it costs
 * one cheap subprocess. That matters for a sensor whose whole justification is
 * that it observes other people's devices — the least invasive query that
 * answers the question is the right one, and an active sweep would announce
 * Gnomon's presence to every device in the building to learn the same fact.
 *
 * The cost of passivity is recall: a device that has not exchanged traffic with
 * this machine recently may be absent from the table even though it is present.
 * That biases `deviceCount` downward and is the accepted trade — the signal is
 * used as a coarse "is anyone here" reading, and a false absence is corrected by
 * the next scan once any traffic flows.
 *
 * Incomplete entries (`(incomplete)`) are skipped: they are addresses the kernel
 * asked about and got no answer for, which is evidence of absence, not presence.
 */
export function parseArpTable(raw: string): PresenceDevice[] {
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    if (line.includes('incomplete')) continue;
    // `? (192.168.1.5) at a4:83:e7:11:22:33 on en0 ifscope [ethernet]`
    const match = line.match(/\bat\s+([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\b/i);
    if (!match) continue;
    seen.add(hashDeviceId(normalizeMac(match[1])));
  }
  return [...seen].map((hash) => ({ hash }));
}

/**
 * macOS and Linux both print octets without a leading zero (`a4:83:e7:1:2:3`),
 * inconsistently between the two, so the same device would otherwise hash to two
 * different tokens depending on the platform that read it. Zero-padding each
 * octet makes the hash stable across both.
 */
function normalizeMac(mac: string): string {
  return mac
    .split(':')
    .map((octet) => octet.padStart(2, '0'))
    .join(':')
    .toLowerCase();
}

/**
 * Reads the local ARP table. Returns `null` — rather than an empty list — when
 * the command is unavailable or fails, because "we could not look" and "we
 * looked and nobody is here" are opposite readings of an absent hour and this
 * sensor exists precisely to stop conflating those two.
 */
export async function readArpDevices(): Promise<PresenceDevice[] | null> {
  try {
    const { stdout } = await exec('arp', ['-an'], { timeout: 5_000 });
    return parseArpTable(stdout);
  } catch {
    return null;
  }
}
