import { describe, it, expect } from 'vitest';
import { parseArpTable, hashDeviceId } from './presence-capture.js';

const MACOS_ARP = `? (192.168.1.1) at a4:83:e7:11:22:33 on en0 ifscope [ethernet]
? (192.168.1.14) at 8c:85:90:aa:bb:cc on en0 ifscope [ethernet]
? (192.168.1.99) at (incomplete) on en0 ifscope [ethernet]
? (224.0.0.251) at 1:0:5e:0:0:fb on en0 ifscope permanent [ethernet]`;

describe('parseArpTable', () => {
  it('returns one hash per complete entry', () => {
    const devices = parseArpTable(MACOS_ARP);
    // Three complete entries; the `(incomplete)` line is not a device.
    expect(devices).toHaveLength(3);
    expect(devices.every((d) => d.hash.startsWith('dev_'))).toBe(true);
  });

  /**
   * An `(incomplete)` entry is an address the kernel asked about and got no
   * answer for — evidence of ABSENCE. Counting it as a device would inflate
   * presence with exactly the machines that are not there.
   */
  it('skips incomplete entries', () => {
    const onlyIncomplete = parseArpTable('? (192.168.1.99) at (incomplete) on en0 ifscope [ethernet]');
    expect(onlyIncomplete).toEqual([]);
  });

  it('never returns a raw MAC address anywhere in its output', () => {
    const serialized = JSON.stringify(parseArpTable(MACOS_ARP));
    expect(serialized).not.toContain('a4:83:e7');
    expect(serialized).not.toContain('8c:85:90');
  });

  it('deduplicates a device appearing on two interfaces', () => {
    const duplicated = `? (192.168.1.14) at 8c:85:90:aa:bb:cc on en0 ifscope [ethernet]
? (10.0.0.14) at 8c:85:90:aa:bb:cc on en1 ifscope [ethernet]`;
    expect(parseArpTable(duplicated)).toHaveLength(1);
  });

  it('returns an empty list for output with no entries', () => {
    expect(parseArpTable('')).toEqual([]);
  });
});

describe('hashDeviceId', () => {
  it('is stable for the same address', () => {
    expect(hashDeviceId('a4:83:e7:11:22:33')).toBe(hashDeviceId('a4:83:e7:11:22:33'));
  });

  it('is case-insensitive, since platforms differ on casing', () => {
    expect(hashDeviceId('A4:83:E7:11:22:33')).toBe(hashDeviceId('a4:83:e7:11:22:33'));
  });

  it('distinguishes different devices', () => {
    expect(hashDeviceId('a4:83:e7:11:22:33')).not.toBe(hashDeviceId('a4:83:e7:11:22:34'));
  });

  /**
   * macOS and Linux disagree on whether to print a leading zero, so the same
   * device would hash to two different tokens — and therefore be counted twice —
   * without the zero-padding `parseArpTable` applies before hashing.
   */
  it('treats a zero-padded and an unpadded octet as the same device via parseArpTable', () => {
    const padded = parseArpTable('? (192.168.1.5) at 0a:0b:0c:01:02:03 on en0 ifscope [ethernet]');
    const unpadded = parseArpTable('? (192.168.1.5) at a:b:c:1:2:3 on en0 ifscope [ethernet]');
    expect(padded[0].hash).toBe(unpadded[0].hash);
  });
});
