import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { personAliasFor } from '@sundial/helpers/sanitize-at-ingest.js';
import { displayNameFromAddress, looksLikePersonName } from '@sundial/helpers/person-name.js';
import { getAllEntities, getCurrentEntityFacts, getAllProjects } from '@sundial/db/index.js';

const run = promisify(execFile);

/**
 * Turning a `person-<hash>` alias back into a name, from addresses already on
 * this machine.
 *
 * The alias is `sha256(address)` truncated (`personAliasFor`), which is a
 * one-way function over an UNKNOWN input and a trivial one over a known
 * candidate. So this never inverts a hash: it gathers addresses the machine can
 * read in plain text, hashes each with the sanitizer's own function, and keeps
 * the ones whose hash equals an alias it was asked about. A match is proof, not
 * a guess — the same address produced that alias.
 *
 * `personAliasFor` and NOT `aliasIfEmail`: the latter tries a display name first
 * and so no longer reaches the hash for a name-shaped address, which would make
 * this match nothing while looking right. Every hashed alias left in the record
 * predates that shortcut or is an address the shortcut rejects.
 *
 * What this deliberately does NOT do:
 *
 *   - Ask a model. There is nothing to infer; a model asked "who is
 *     person-c7e3af19c4" can only invent a colleague, and the answer would be
 *     written into core memory as a durable fact about a real person.
 *   - Put an address in the log. Only the derived NAME leaves this module. The
 *     whole reason the alias exists is that the address should not be stored,
 *     and a resolver that logged what it resolved from would undo that.
 *   - Read Contacts. macOS gates the address book behind Full Disk Access,
 *     which does not propagate to node through the bundle (see the TCC notes in
 *     CLAUDE.md), so the authoritative source has to be reached from the Swift
 *     calendar helper instead. That is a separate fix at the sensor; this one
 *     cleans up rows already written.
 */

/** A `person-<hash>` canonical name, the only kind of person entity this can help. */
const HASHED_NAME = /^person-[0-9a-f]{6,}$/i;

/** Bound on how much history one repository contributes, newest first. */
const GIT_LOG_LIMIT = 2000;
const GIT_TIMEOUT_MS = 10_000;

/** `~` in a stored root is expanded here, not at write time, so the row stays portable. */
function expandHome(path: string): string {
  return path.startsWith('~') ? homedir() + path.slice(1) : path;
}

/**
 * Every address that has authored or committed in the known project roots, and
 * the human name git recorded beside it.
 *
 * Colleagues who share a repository with the owner are exactly the colleagues
 * who show up in their calendar, which is why this source works at all: on the
 * live record it matched 6 of 25 aliases with no other input.
 *
 * `%an`/`%cn` is the load-bearing half and was missed on the first pass. Reading
 * only the address meant the name had to be DERIVED from the local part, which
 * turns `alexm@example.com` into "Alexm" — a name the owner then corrected to
 * "Alex Morgan" by hand. Git had been recording exactly that string all
 * along, in the column beside the one being read.
 *
 * A root that is not a git repository, or a `git` that fails for any reason,
 * contributes nothing and never throws — a resolver is an optimisation over
 * asking, so a broken source must degrade to "no match" rather than to an error.
 */
async function addressesFromGit(): Promise<Map<string, string | null>> {
  /** address → how often each spelling of a name was seen for it. */
  const tally = new Map<string, Map<string, number>>();
  const projects = await getAllProjects();
  for (const project of projects) {
    const cwd = expandHome(project.rootPath);
    try {
      const { stdout } = await run('git', ['log', '--all', `-${GIT_LOG_LIMIT}`, '--format=%ae%x09%an%n%ce%x09%cn'], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
      for (const line of stdout.split('\n')) {
        const [rawAddress, rawName] = line.split('\t');
        const address = (rawAddress ?? '').trim();
        if (address === '') continue;
        const names = tally.get(address) ?? new Map<string, number>();
        const name = (rawName ?? '').trim();
        // A name only counts if it reads like a person's. A `git config` set to
        // a handle ("bjorn-studio") or to nothing must not become a colleague.
        if (name !== '' && looksLikePersonName(name)) names.set(name, (names.get(name) ?? 0) + 1);
        tally.set(address, names);
      }
    } catch {
      // Not a repository, no git, or a timeout. Next root.
    }
  }

  const resolved = new Map<string, string | null>();
  for (const [address, names] of tally) resolved.set(address, bestName(names));
  return resolved;
}

/**
 * The name to believe when one address has committed under several.
 *
 * It happens for two ordinary reasons: a `git config` tidied up over time
 * ("Björn" then "Björn Vermeule"), and a pairing or hand-over commit authored
 * under someone else's address — `alexm@example.com` carries both "Alex Morgan"
 * and "Jordan" on this record. Most frequent wins, and the longest breaks a tie,
 * which picks the fuller spelling of the same person rather than a first name
 * alone. Deterministic on both counts, so a replay resolves identically.
 */
function bestName(names: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const name of Array.from(names.keys()).sort()) {
    const count = names.get(name) ?? 0;
    if (count > bestCount || (count === bestCount && best !== null && name.length > best.length)) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

export interface ResolvedAlias {
  alias: string;
  name: string;
}

/**
 * Which of `aliases` these candidate addresses account for.
 *
 * Both spellings are tested because the log holds both: the calendar hands some
 * attendees over as `mailto:someone@example.com` and the hash was taken over the
 * string AS RECEIVED, prefix included. So a candidate is reduced to the bare
 * address first and then hashed twice, once with the prefix and once without —
 * otherwise a candidate that happens to arrive prefixed can only ever match a
 * prefixed alias, and one arriving bare can only match a bare one.
 *
 * The name comes from `displayNameFromAddress` — the same derivation a
 * never-hashed attendee gets — so a resolved colleague and a natively-named one
 * end up spelled identically instead of arriving in two forms. An address that
 * yields no name (a role mailbox, digits, a one-letter local part) is dropped:
 * matching it proves WHICH address it is without saying who the person is, and
 * "Noreply" is not a colleague.
 */
export function matchAliases(aliases: readonly string[], candidates: Iterable<string | [string, string | null]>): ResolvedAlias[] {
  const wanted = new Set(aliases);
  const resolved = new Map<string, string>();
  for (const candidate of candidates) {
    const [address, given] = typeof candidate === 'string' ? [candidate, null] : candidate;
    const bare = address.replace(/^mailto:/i, '');
    for (const raw of [bare, `mailto:${bare}`]) {
      const alias = personAliasFor(raw);
      if (!wanted.has(alias) || resolved.has(alias)) continue;
      // A name the SOURCE recorded beats one derived from the local part: git
      // holds "Alex Morgan" where the address only implies "Alexm".
      const name = given ?? displayNameFromAddress(bare);
      if (name !== null) resolved.set(alias, name);
    }
  }
  return Array.from(resolved, ([alias, name]) => ({ alias, name }));
}

/**
 * Every person entity whose name is still a hash and which has no `knownAs`
 * belief.
 *
 * Read from the `entities` table rather than handed in by the rule. The rule
 * cannot query, and the one state slice that lists attendees —
 * `state.meetings.seen` — holds only recent meetings, so a rule-side list found
 * nothing to do on a machine whose last meeting had aged out while 25 hashed
 * people sat here.
 */
async function unnamedAliases(): Promise<string[]> {
  const entities = await getAllEntities();
  const hashed = entities.filter((entity) => entity.kind === 'person' && HASHED_NAME.test(entity.canonicalName ?? ''));
  const unnamed: string[] = [];
  for (const entity of hashed) {
    const facts = await getCurrentEntityFacts(entity.id);
    if (facts.some((fact) => fact.predicate === 'knownAs')) continue;
    unnamed.push(entity.canonicalName);
  }
  return unnamed;
}

/** One sweep: find who is still unnamed, and name whoever this machine can account for. */
export async function resolveAliases(): Promise<ResolvedAlias[]> {
  const aliases = await unnamedAliases();
  if (aliases.length === 0) return [];
  return matchAliases(aliases, await addressesFromGit());
}
