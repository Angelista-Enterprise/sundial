import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getLocationInfoJsonPath } from '@sundial/helpers/sundial-paths.js';

export interface NetworkState {
  fingerprint: string;
  gatewayIp: string | null;
  interfaceName: string | null;
  ssid: string | null;
  bssid: string | null;
  networkId: string | null;
  sname: string | null;
  interfaceType: string | null;
  isExpensive: boolean | null;
  security: string | null;
  label: string | null;
}

interface DefaultRoute {
  gateway: string | null;
  iface: string | null;
}

interface MacInterfaceDetails {
  ssid: string | null;
  bssid: string | null;
  networkId: string | null;
  sname: string | null;
  interfaceType: string | null;
  isExpensive: boolean | null;
  security: string | null;
  router: string | null;
}

const REDACTED = '<redacted>';

/**
 * Identity of a network, hashed from only the inputs that stay put for as long
 * as the owner would still call it "the same network".
 *
 * Deliberately EXCLUDES two inputs the previous `net_…` composition mixed in,
 * both of which move while the network does not:
 *
 * - `bssid` — the access point's MAC. Roaming between APs on one mesh network
 *   or one office floor changes it, so including it minted a fresh identity per
 *   access point.
 * - the DNS resolver list — reordered by the resolver on a DHCP lease renewal,
 *   so the same network re-keyed itself on a reconnect.
 *
 * That was not merely untidy. `state.presence.networks` keys the owner's
 * presence CONSENT by this value, so every re-key silently dropped the grant
 * and `presenceTrack` stopped folding sweeps with no error surfaced anywhere —
 * see the consent gate in `presenceTrack`.
 *
 * `networkId`/`sname` stay in the key even though gateway + interface alone
 * would be shorter, because `192.168.1.1` on `en0` is the most common LAN
 * address there is: without a name component a home network and a café network
 * would collapse into ONE identity, which loses more than the bug being fixed.
 *
 * The `net2_` prefix versions the scheme so a stored key says for itself
 * whether it predates this change and still needs remapping.
 */
export function stableNetworkKey(parts: Array<string | null>): string {
  const joined = parts.map((p) => p ?? '').join('|');
  return 'net2_' + createHash('sha256').update(joined).digest('hex').slice(0, 12);
}

/** The stable subset of a network observation that `networkKeyFor` hashes. */
export interface NetworkKeyInputs {
  networkId: string | null;
  sname: string | null;
  gatewayIp: string | null;
  interfaceName: string | null;
  security: string | null;
}

/**
 * The single definition of which fields, in which order, compose a network
 * identity. Both the sensor and the old-key remap script call this, so the two
 * cannot drift into disagreeing about what "the same network" means — a drift
 * that would re-open the consent-loss bug from the other side.
 */
export function networkKeyFor(inputs: NetworkKeyInputs): string {
  return stableNetworkKey([inputs.networkId, inputs.sname, inputs.gatewayIp, inputs.interfaceName, inputs.security]);
}

export function parseMacInterfaceDetails(out: string | null): MacInterfaceDetails {
  if (!out) {
    return { ssid: null, bssid: null, networkId: null, sname: null, interfaceType: null, isExpensive: null, security: null, router: null };
  }

  const scalar = (key: string): string | null => {
    const m = out.match(new RegExp(`^  ${key} : (.+)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  const unredact = (v: string | null): string | null => (v === null || v === REDACTED ? null : v);

  return {
    ssid: unredact(scalar('SSID')),
    bssid: unredact(scalar('BSSID')),
    networkId: unredact(scalar('NetworkID')),
    sname: out.match(/sname = (\S+)/)?.[1] ?? null,
    interfaceType: scalar('InterfaceType'),
    isExpensive: scalar('IsExpensive') === 'TRUE' ? true : scalar('IsExpensive') === 'FALSE' ? false : null,
    security: scalar('Security'),
    router: out.match(/Router : (\S+)/)?.[1] ?? null,
  };
}

/**
 * Whether this process holds Location Services authorization, inferred from what
 * configd was willing to tell us — there is no sidecar or preflight API to ask.
 * macOS redacts SSID/BSSID/NetworkID (the literal `<redacted>`, mapped to null by
 * `unredact` above) for an unauthorized caller, but still reports `Security`. So a
 * WiFi interface whose security mode is known while its SSID is not is a hard
 * denial, not an absent network — that asymmetry *is* the signal.
 *
 * `null` (can't tell) where the observation genuinely can't decide: a non-WiFi
 * interface never exercises the permission at all, and WiFi with no security mode
 * either is mid-association or told us nothing. Note `sname` is never redacted, so
 * a personal hotspot still yields a label while denied — absence of a label is not
 * a usable proxy for this grant.
 */
export function inferLocationServicesGrant(details: Pick<MacInterfaceDetails, 'interfaceType' | 'ssid' | 'security'>): boolean | null {
  if (details.interfaceType !== 'WiFi') return null;
  if (details.ssid !== null) return true;
  return details.security !== null ? false : null;
}

/**
 * Persist the inferred grant so `getPermissionStatus` can report Location
 * Services without re-running `ipconfig`. Only a decided true/false is written:
 * an inconclusive read leaves the previous marker alone rather than overwriting a
 * real grant with "can't tell" (the same rule `persistCalendarGrantMarker`
 * follows). Best-effort — the marker is permission reporting, not load-bearing.
 */
function persistLocationGrantMarker(granted: boolean | null): void {
  if (granted === null) return;
  try {
    fs.writeFileSync(getLocationInfoJsonPath(), JSON.stringify({ timestamp: new Date().toISOString(), locationServicesGranted: granted }));
  } catch {
    // ignore — see above.
  }
}

export function parseDefaultRouteMacOS(out: string | null): DefaultRoute {
  if (!out) return { gateway: null, iface: null };
  return {
    gateway: out.match(/gateway:\s+(\S+)/)?.[1] ?? null,
    iface: out.match(/interface:\s+(\S+)/)?.[1] ?? null,
  };
}

function exec(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 2000 }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(stdout);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * True when `ipconfig getsummary` told us the interface is Wi-Fi but returned
 * none of the fields that identify WHICH wireless network it is.
 *
 * This read genuinely happens (measured once in 122 observations of one
 * network) and it is not benign: every field that composes the key reads null,
 * so the observation hashes to an identity of its own and the owner appears to
 * have joined a network they have never seen. That is the same
 * one-network-many-identities defect `networkKeyFor` exists to remove, arriving
 * through a bad read instead of a volatile field.
 *
 * Deliberately narrow. It requires `interfaceType === 'WiFi'`, so a wired
 * connection — where a null SSID and null security are the correct answer, not a
 * failed read — is never suppressed.
 *
 * The trade-off: on a machine that can never read link details, the sensor stays
 * silent instead of reporting a network. That is the intended direction. A
 * missing observation is visible as staleness, whereas a phantom identity is
 * indistinguishable from a real network and would become a separate consent key.
 */
export interface WifiLinkFields {
  interfaceType: string | null;
  ssid: string | null;
  networkId: string | null;
  sname: string | null;
  security: string | null;
}

export function isIncompleteWifiRead(details: WifiLinkFields): boolean {
  return details.interfaceType === 'WiFi' && details.ssid === null && details.networkId === null && details.sname === null && details.security === null;
}

export async function readMacOSNetworkState(): Promise<NetworkState | null> {
  const routeOut = await exec('route', ['get', 'default']);
  const route = parseDefaultRouteMacOS(routeOut);
  if (!route.iface) return null;

  const detailsOut = await exec('ipconfig', ['getsummary', route.iface]);
  const details = parseMacInterfaceDetails(detailsOut);
  if (isIncompleteWifiRead(details)) return null;
  const gateway = details.router ?? route.gateway;
  persistLocationGrantMarker(inferLocationServicesGrant(details));

  return {
    fingerprint: networkKeyFor({ networkId: details.networkId, sname: details.sname, gatewayIp: gateway, interfaceName: route.iface, security: details.security }),
    gatewayIp: gateway,
    interfaceName: route.iface,
    ssid: details.ssid,
    bssid: details.bssid,
    networkId: details.networkId,
    sname: details.sname,
    interfaceType: details.interfaceType,
    isExpensive: details.isExpensive,
    security: details.security,
    label: details.ssid ?? details.sname ?? gateway,
  };
}

export async function readLinuxNetworkState(): Promise<NetworkState | null> {
  const routeOut = await exec('ip', ['route', 'show', 'default']);
  if (!routeOut) return null;

  const gateway = routeOut.match(/default via\s+(\S+)/)?.[1] ?? null;
  const iface = routeOut.match(/dev\s+(\S+)/)?.[1] ?? null;

  return {
    // Linux exposes no SSID here, so the key is gateway + interface only. That
    // is coarser than the macOS key — two different LANs that both hand out
    // `192.168.1.1` on `wlan0` read as one network. Accepted rather than papered
    // over with the DNS list, which is what made the key unstable in the first
    // place; a finer Linux key needs a real network-name source, not a volatile
    // one.
    fingerprint: networkKeyFor({ networkId: null, sname: null, gatewayIp: gateway, interfaceName: iface, security: null }),
    gatewayIp: gateway,
    interfaceName: iface,
    ssid: null,
    bssid: null,
    networkId: null,
    sname: null,
    interfaceType: null,
    isExpensive: null,
    security: null,
    label: gateway,
  };
}
