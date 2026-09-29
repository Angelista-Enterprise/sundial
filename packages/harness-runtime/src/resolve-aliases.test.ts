import { describe, expect, it } from 'vitest';
import { personAliasFor } from '@sundial/helpers/sanitize-at-ingest.js';
import { addressesFromMail, matchAliases } from './resolve-aliases.js';

/**
 * The pairs below are REAL rows from the live record, kept verbatim on purpose.
 *
 * They are the proof the whole rule rests on: these aliases were written by
 * `sanitizeAtIngest` weeks before a resolver existed, so a test that reproduces
 * them from the address side shows the forward hash still agrees with what is
 * already stored. If `aliasIfEmail` ever changes its normalisation, every alias
 * in the database stops matching and this is the test that says so.
 */
const KNOWN = [
  { address: 'alexm@example.com', alias: 'person-c205ca11f2', name: 'Alexm' },
  { address: 'sam.lee@example.com', alias: 'person-7451c54295', name: 'Sam Lee' },
  { address: 'jordan.de.wit@example.com', alias: 'person-d1feb17d9f', name: 'Jordan De Wit' },
];

describe('matchAliases', () => {
  it('names a real alias from the live record, from the address alone', () => {
    for (const { address, alias, name } of KNOWN) {
      expect(matchAliases([alias], [address])).toEqual([{ alias, name }]);
    }
  });

  it('resolves the aliases it was asked about and ignores the rest', () => {
    const asked = [KNOWN[0]!.alias, KNOWN[1]!.alias];
    const resolved = matchAliases(asked, KNOWN.map((k) => k.address));
    expect(resolved.map((r) => r.alias).sort()).toEqual([...asked].sort());
  });

  it('matches the mailto: spelling too — the log holds both', () => {
    const { address, alias, name } = KNOWN[0]!;
    expect(matchAliases([alias], [`mailto:${address}`])).toEqual([{ alias, name }]);
  });

  it('reports nothing for an address that is not the one behind the alias', () => {
    expect(matchAliases([KNOWN[0]!.alias], ['someone.else@example.com'])).toEqual([]);
  });

  // A match proves WHICH address it was, not who the person is. `noreply@` is
  // name-shaped enough to hash and match, and minting a colleague called
  // "Noreply" would put a false person into core memory for good.
  it('drops a match whose address is a role mailbox, not a person', () => {
    const address = 'noreply@example.com';
    const alias = personAliasFor(address);
    // The hash DOES match — this is the guard after the match, not before it.
    expect(alias).toMatch(/^person-[0-9a-f]{10}$/);
    expect(matchAliases([alias], [address])).toEqual([]);
  });

  it('never reports the same alias twice', () => {
    const { address, alias } = KNOWN[0]!;
    expect(matchAliases([alias], [address, address, `mailto:${address}`])).toHaveLength(1);
  });
});

/**
 * The name column, which the first pass discarded.
 *
 * Reading only `%ae` forced the name to be derived from the local part, so
 * `alexm@example.com` resolved to "Alexm" — which the owner then corrected to
 * "Alex Morgan" by hand. Git had been recording that exact string in the
 * column beside the address the whole time.
 */
describe('matchAliases with a name from the source', () => {
  const { address, alias } = KNOWN[0]!;

  it('prefers the recorded name over the one derived from the address', () => {
    expect(matchAliases([alias], [[address, 'Alex Morgan']])).toEqual([{ alias, name: 'Alex Morgan' }]);
  });

  it('falls back to the derivation when the source recorded no name', () => {
    expect(matchAliases([alias], [[address, null]])).toEqual([{ alias, name: 'Alexm' }]);
  });

  it('still accepts a bare address, so the plain form keeps working', () => {
    expect(matchAliases([alias], [address])).toEqual([{ alias, name: 'Alexm' }]);
  });

  // A role mailbox with a real committer name behind it is a person after all —
  // the guard that drops "Noreply" is about the DERIVATION, not about the match.
  it('accepts a recorded name even when the address alone would yield none', () => {
    const roleAddress = 'ci-bot-2@example.com';
    const roleAlias = personAliasFor(roleAddress);
    expect(matchAliases([roleAlias], [roleAddress])).toEqual([]);
    expect(matchAliases([roleAlias], [[roleAddress, 'Sam Rye']])).toEqual([{ alias: roleAlias, name: 'Sam Rye' }]);
  });
});

describe('addressesFromMail (M4)', () => {
  it("names a hashed attendee from Mail's display name for the same address", async () => {
    const rows = [
      { address: 'x7@example.com', name: 'Mira Bakker' },
      { address: 'billing@example.com', name: 'billing@example.com' },
      { address: 'x7@example.com', name: null },
    ];
    const mail = await addressesFromMail('Envelope Index', async () => JSON.stringify(rows));
    expect(mail.get('x7@example.com')).toBe('Mira Bakker');
    expect(mail.get('billing@example.com')).toBeNull();
    const alias = personAliasFor('mailto:x7@example.com');
    expect(matchAliases([alias], mail)).toEqual([{ alias, name: 'Mira Bakker' }]);
  });

  it('contributes nothing when the index cannot be read', async () => {
    expect((await addressesFromMail(null)).size).toBe(0);
    expect((await addressesFromMail('f', async () => Promise.reject(new Error('EPERM')))).size).toBe(0);
  });
});
