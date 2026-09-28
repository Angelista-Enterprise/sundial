import { describe, it, expect } from 'vitest';
import {
  inferLocationServicesGrant,
  isIncompleteWifiRead,
  networkKeyFor,
  parseDefaultRouteMacOS,
  parseMacInterfaceDetails,
} from './location-network-capture.js';

const HOME = { networkId: 'net-1', sname: 'HomeWifi', gatewayIp: '192.168.1.1', interfaceName: 'en0', security: 'WPA2_PSK' };

describe('networkKeyFor', () => {
  it('is stable for the same inputs', () => {
    expect(networkKeyFor(HOME)).toBe(networkKeyFor(HOME));
    expect(networkKeyFor(HOME)).toMatch(/^net2_[a-f0-9]{12}$/);
  });

  it('differs for a genuinely different network', () => {
    expect(networkKeyFor(HOME)).not.toBe(networkKeyFor({ ...HOME, networkId: 'net-2', sname: 'Acme-Guest' }));
  });

  // The bug this key exists to fix: presence consent is stored per key, so any
  // input that moves while the network stays put silently revoked the grant.
  it('survives roaming to another access point on the same network', () => {
    // BSSID is no longer an input at all — the caller cannot even pass it.
    expect(networkKeyFor(HOME)).toBe(networkKeyFor({ ...HOME }));
  });

  it('separates two networks that share a gateway address', () => {
    const cafe = { ...HOME, networkId: 'net-cafe', sname: 'Cafe-Free' };
    expect(networkKeyFor(cafe)).not.toBe(networkKeyFor(HOME));
  });

  it('distinguishes wired from wireless on one machine', () => {
    expect(networkKeyFor({ ...HOME, interfaceName: 'en1' })).not.toBe(networkKeyFor(HOME));
  });
});

describe('isIncompleteWifiRead', () => {
  it('flags a Wi-Fi read that identified no network', () => {
    // Observed once in 122 readings of one network: ipconfig reported the
    // interface type and nothing else, which would hash to its own identity.
    expect(isIncompleteWifiRead({ interfaceType: 'WiFi', ssid: null, networkId: null, sname: null, security: null })).toBe(true);
  });

  it('accepts a Wi-Fi read carrying any one identifying field', () => {
    expect(isIncompleteWifiRead({ interfaceType: 'WiFi', ssid: null, networkId: null, sname: null, security: 'WPA3_SAE' })).toBe(false);
    expect(isIncompleteWifiRead({ interfaceType: 'WiFi', ssid: null, networkId: null, sname: 'Home', security: null })).toBe(false);
  });

  it('never suppresses a wired connection, where null link fields are correct', () => {
    expect(isIncompleteWifiRead({ interfaceType: 'Ethernet', ssid: null, networkId: null, sname: null, security: null })).toBe(false);
    expect(isIncompleteWifiRead({ interfaceType: null, ssid: null, networkId: null, sname: null, security: null })).toBe(false);
  });
});

describe('parseDefaultRouteMacOS', () => {
  it('extracts gateway and interface', () => {
    const route = parseDefaultRouteMacOS('   route to: default\ndestination: default\n       gateway: 192.168.1.1\n     interface: en0\n');
    expect(route).toEqual({ gateway: '192.168.1.1', iface: 'en0' });
  });

  it('returns nulls when output is missing', () => {
    expect(parseDefaultRouteMacOS(null)).toEqual({ gateway: null, iface: null });
  });
});

describe('parseMacInterfaceDetails', () => {
  it('extracts SSID/BSSID/security and treats <redacted> as null', () => {
    const out = ['  SSID : HomeWifi', '  BSSID : <redacted>', '  Security : WPA2_PSK', '  NetworkID : abc-123'].join('\n');
    const details = parseMacInterfaceDetails(out);
    expect(details.ssid).toBe('HomeWifi');
    expect(details.bssid).toBeNull(); // redacted by macOS Location Services -> null, not the literal string
    expect(details.security).toBe('WPA2_PSK');
  });
});

describe('inferLocationServicesGrant', () => {
  /** Verbatim shape of a real `ipconfig getsummary en0` on this machine while denied. */
  const DENIED_OUTPUT = ['  BSSID : <redacted>', '  InterfaceType : WiFi', '  NetworkID : <redacted>', '  SSID : <redacted>', '  Security : SHA256_8021X'].join('\n');

  it('reports denied when macOS redacts the SSID but still names the security mode', () => {
    // The asymmetry is the whole signal: configd can see the network (it told us
    // the security mode) yet withholds its name, which only happens unauthorized.
    expect(inferLocationServicesGrant(parseMacInterfaceDetails(DENIED_OUTPUT))).toBe(false);
  });

  it('reports granted once a real SSID comes through', () => {
    const out = ['  InterfaceType : WiFi', '  SSID : HomeWifi', '  Security : WPA3_SAE'].join('\n');
    expect(inferLocationServicesGrant(parseMacInterfaceDetails(out))).toBe(true);
  });

  it("can't tell on a non-WiFi interface, which never exercises the permission", () => {
    const out = ['  InterfaceType : Ethernet', '  Router : 10.0.0.1'].join('\n');
    expect(inferLocationServicesGrant(parseMacInterfaceDetails(out))).toBeNull();
  });

  it("can't tell on WiFi with no security mode (mid-association, or told us nothing)", () => {
    expect(inferLocationServicesGrant(parseMacInterfaceDetails('  InterfaceType : WiFi'))).toBeNull();
    expect(inferLocationServicesGrant(parseMacInterfaceDetails(null))).toBeNull();
  });

  it('does not treat a hotspot sname as a grant — sname survives redaction', () => {
    const out = ['  InterfaceType : WiFi', '  SSID : <redacted>', '  Security : WPA2_PSK', 'sname = Pat-Iphone'].join('\n');
    const details = parseMacInterfaceDetails(out);
    expect(details.sname).toBe('Pat-Iphone');
    expect(inferLocationServicesGrant(details)).toBe(false);
  });
});
