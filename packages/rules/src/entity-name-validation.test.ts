import { describe, it, expect } from 'vitest';
import { isPlausibleEntityName, knownProjectNames, rejectEntityName } from './entity-name-validation.js';

/**
 * Every rejected case below is a REAL name that the first full recompute
 * (`scripts/recompute-derived.ts`) promoted into core memory from historical
 * `entity:fact-candidate` events, and every accepted case is a real name the
 * current producers emit. Using live data rather than invented examples is the
 * point: this gate exists because of specific junk, and a test made of
 * hypotheticals would not prove that junk is excluded.
 */
describe('rejectEntityName — the junk a recompute resurrected', () => {
  const junk: Array<[string, string]> = [
    // Activity classes the nightly pass paired with projects, 2026-08 → 09: what
    // the work was done IN, not what it was about.
    ['topic', 'email'],
    ['topic', 'Terminal'],
    ['topic', 'ai-chat'],
    ['topic', 'browser'],
    ['topic', ')'],
    ['topic', '/changes)'],
    ['topic', '/commits)'],
    ['topic', 'featured-article-overview-layout)'],
    ['topic', '): polish popup intro typography and image credits by sam-Acme · Pull Request #143'],
    ['topic', '] BE/FE: Paywall - JIRA - Google Chrome - Sam (Acme) (https://studio-nl.atlassian.net/browse/PL-280)'],
    ['topic', 'localhost:3000artikelen/instrument-gezocht'],
    ['topic', 'stop sleeping when lid is closed mac'],
    ['topic', 'what are lora finde tunnes'],
    ['topic', 'claude fable price calculatro 2mtokens 1.6m iin and 102k out'],
    // `person-<hash>` is no longer junk: a stable alias is one unnamed invitee (see below).
    ['person', 'RTM-1-08 (12)'],
  ];

  for (const [kind, name] of junk) {
    it(`rejects ${kind} "${name.slice(0, 40)}"`, () => {
      const rejection = rejectEntityName(kind, name, 'inference');
      expect(rejection, `expected a rejection for ${name}`).not.toBeNull();
      expect(rejection?.reason).toBeTruthy();
    });
  }
});

describe('rejectEntityName — the names current producers actually emit', () => {
  const legitimate: Array<[string, string]> = [
    // Subjects the nightly pass names — what the work was ABOUT. (Its old
    // controlled vocabulary of activity classes — terminal, notes, browser,
    // jira — moved to the junk list above on 2026-09-07.)
    ['topic', 'crossword hints'],
    ['topic', 'BOX-484 onboarding tutorials'],
    ['topic', 'paywall'],
    ['project', 'gnomon'],
    ['project', 'puzzlebox-studio'],
    ['project', 'overture'],
    ['project', 'client-app'],
    ['tool', 'Xcode'],
    ['tool', 'VS Code'],
    // A colleague, not the owner — the owner is covered by the context rejects below.
    ['person', 'Priya Sharma'],
    ['person', 'Tim'],
    // Real names with punctuation inside them must survive — this gate checks
    // shape, and a hyphen or apostrophe is part of plenty of real names.
    ['person', 'Jean-Luc Picard'],
    ['person', "Sinéad O'Connor"],
    ['person', 'Joris de Vries'],
  ];

  for (const [kind, name] of legitimate) {
    it(`accepts ${kind} "${name}"`, () => {
      expect(rejectEntityName(kind, name, 'inference')).toBeNull();
    });
  }
});

describe('hard rejects apply to every provenance', () => {
  /**
   * An owner assertion is trusted on style but cannot create an entity nobody can
   * refer to. These three are not matters of formatting — none of them identifies
   * anything.
   */
  it('rejects an empty name even from an assertion', () => {
    expect(rejectEntityName('topic', '   ', 'assertion')?.reason).toBe('empty');
  });

  it('rejects a name with no letters or digits even from an assertion', () => {
    expect(rejectEntityName('topic', '—()', 'assertion')?.reason).toBe('no alphanumeric characters');
  });

  /**
   * A stable redaction alias IS a person — the same invitee every time, merely
   * unnamed (decision 2026-09-04 on the attendee issue). It is admitted, and a
   * reader shows it as the alias until the owner supplies `knownAs`.
   */
  it('admits a stable redaction alias as a person, from any provenance', () => {
    expect(rejectEntityName('person', 'person-0a1b2c3d4e', 'inference')).toBeNull();
    expect(rejectEntityName('person', 'person-0a1b2c3d4e', 'assertion')).toBeNull();
    expect(rejectEntityName('topic', 'person-0a1b2c3d4e', 'inference')).toBeNull();
  });
});

describe('shape heuristics yield to an owner assertion', () => {
  /**
   * The owner typing a name deliberately is the one authoritative input path
   * (enhancements/assertions-versus-observations), so it must not also be the most
   * restricted one. A long, phrase-shaped name from an assertion is allowed;
   * the same name inferred from a window title is not.
   */
  it('accepts a phrase-shaped topic from an assertion but not from an inference', () => {
    const name = 'stop sleeping when lid is closed mac';
    expect(isPlausibleEntityName('topic', name, 'assertion')).toBe(true);
    expect(isPlausibleEntityName('topic', name, 'inference')).toBe(false);
  });

  it('accepts a bracketed person name from an assertion', () => {
    expect(isPlausibleEntityName('person', 'Sam (Acme)', 'assertion')).toBe(true);
    expect(isPlausibleEntityName('person', 'Sam (Acme)', 'inference')).toBe(false);
  });

  it('still applies shape rules to an assistant-provenance candidate', () => {
    // An assistant is not the owner. Its claims go through the same bar as a
    // sensor's (decisions/assistant-as-an-event-source).
    expect(isPlausibleEntityName('topic', ') fragment', 'assistant')).toBe(false);
  });
});

describe('shape heuristics, stated individually', () => {
  it('rejects a name longer than 48 characters', () => {
    expect(rejectEntityName('project', 'a'.repeat(49), 'inference')?.reason).toContain('longer than 48');
  });

  it('accepts a name at exactly the length limit', () => {
    expect(rejectEntityName('project', 'a'.repeat(48), 'inference')).toBeNull();
  });

  it('rejects an unbalanced closing bracket but accepts a balanced pair', () => {
    expect(rejectEntityName('topic', 'layout)', 'inference')?.reason).toContain('unbalanced');
    expect(rejectEntityName('topic', 'layout (v2)', 'inference')).toBeNull();
  });

  it('allows a four-word topic and rejects a five-word one', () => {
    expect(rejectEntityName('topic', 'new york times games', 'inference')).toBeNull();
    expect(rejectEntityName('topic', 'new york times games daily', 'inference')?.reason).toContain('5 words');
  });

  /**
   * The word cap is for labels only. A person's name can legitimately run to
   * several words and a project name can be a phrase.
   */
  it('does not apply the word cap to people or projects', () => {
    expect(rejectEntityName('person', 'Maria del Carmen de la Cruz', 'inference')).toBeNull();
    expect(rejectEntityName('project', 'the big client rewrite thing', 'inference')).toBeNull();
  });
});

/**
 * Context rejects — the two cases the shape heuristics documented as blind spots,
 * now covered because `KernelState` already carries the knowledge needed to judge
 * them. Both were resurrected by the first full recompute.
 */
describe('rejectEntityName — context rejects', () => {
  const context = {
    ownerAliases: ['sam', 'Sam Rivers', 'sam.rivers@example.com', 'person-0a1b2c3d4e'],
    projectNames: ['puzzlebox-team', 'puzzlebox-studio', 'gnomon', 'WCS'],
  };

  /**
   * The concrete failure: five `sam collaboratesOn …` facts, i.e. the owner
   * collaborating with themselves. `ownerAliases` exists to prevent exactly this
   * (CLAUDE.md) but the filter lived only in the removed calendar producer.
   */
  it('rejects the owner as a person entity', () => {
    expect(rejectEntityName('person', 'sam', 'inference', context)?.reason).toBe('the owner is not a person entity');
    // The same alias IS welcome as the owner kind, and nothing else is.
    expect(rejectEntityName('owner', 'sam', 'assertion', context)).toBeNull();
    expect(rejectEntityName('owner', 'someone else', 'assertion', context)?.reason).toBe('not an owner alias');
    expect(rejectEntityName('owner', 'sam', 'assertion', undefined)?.reason).toBe('no ownerAliases configured, so nothing can be the owner');
  });

  it('matches an owner alias case-insensitively and ignoring surrounding space', () => {
    expect(isPlausibleEntityName('person', '  SAM  ', 'inference', context)).toBe(false);
    expect(isPlausibleEntityName('person', 'Sam Rivers', 'inference', context)).toBe(false);
  });

  /** The shape gate's documented blind spot: a team name is shaped exactly like a personal one. */
  it('rejects a known project name proposed as a person', () => {
    expect(rejectEntityName('person', 'puzzlebox-team', 'inference', context)?.reason).toBe('names a known project, not a person');
  });

  /**
   * Applied to assertions too. An assertion naming a project as a colleague is a
   * mistake worth refusing rather than honouring, and the owner recording
   * themselves belongs on a kind other than `person`.
   */
  it('applies to assertions as well as inferences', () => {
    expect(isPlausibleEntityName('person', 'sam', 'assertion', context)).toBe(false);
    expect(isPlausibleEntityName('person', 'puzzlebox-team', 'assertion', context)).toBe(false);
  });

  /** Only `person` is affected — a project entity legitimately carries a project name. */
  it('does not stop a project being named after itself', () => {
    expect(isPlausibleEntityName('project', 'gnomon', 'inference', context)).toBe(true);
    expect(isPlausibleEntityName('topic', 'gnomon', 'inference', context)).toBe(true);
  });

  it('leaves real colleagues alone', () => {
    expect(isPlausibleEntityName('person', 'Priya Sharma', 'inference', context)).toBe(true);
    expect(isPlausibleEntityName('person', 'jesse', 'inference', context)).toBe(true);
  });

  /** No context supplied (a caller that has no config) must not start rejecting people. */
  it('is inert without context', () => {
    expect(isPlausibleEntityName('person', 'sam', 'inference')).toBe(true);
  });
});

describe('knownProjectNames', () => {
  it('gathers alias keys, alias values and detected project names', () => {
    const names = knownProjectNames({ WCS: 'gnomon', 'PB-Games': 'puzzlebox-studio' }, { '~/p/x': { name: 'overture' } });

    // A key is the wrong name someone used, a value is the canonical one, and
    // either appearing as a "person" is the same defect.
    expect(names).toContain('WCS');
    expect(names).toContain('gnomon');
    expect(names).toContain('PB-Games');
    expect(names).toContain('overture');
  });

  it('is empty when nothing is configured or detected', () => {
    expect(knownProjectNames({}, {})).toEqual([]);
  });
});

describe('an activity class is a SHAPE reject, so the owner can still assert one', () => {
  const context = { ownerAliases: [], projectNames: [] };

  it('drops an activity-class topic from the nightly pass', () => {
    expect(rejectEntityName('topic', 'email', 'inference', context)).not.toBeNull();
    expect(rejectEntityName('topic', 'Terminal', 'inference', context)).not.toBeNull();
  });

  it('honours the owner asserting one — the hard tier ran BEFORE the assertion bypass and silently ate it', () => {
    // `topic: "code review"` typed by the owner used to be discarded while the
    // tool reported success, so they had no way to see why it never appeared.
    expect(rejectEntityName('topic', 'code review', 'assertion', context)).toBeNull();
    expect(rejectEntityName('topic', 'documentation', 'assertion', context)).toBeNull();
  });

  it('still hard-rejects what cannot identify anything, assertion or not', () => {
    expect(rejectEntityName('topic', '', 'assertion', context)).not.toBeNull();
    expect(rejectEntityName('topic', ')))', 'assertion', context)).not.toBeNull();
  });
});

describe('W1/W3 — the shapes the 2026-09-23 card audit found', () => {
  const ctx = { ownerAliases: ['pat', 'Pat Doe'], projectNames: ['sundial', 'Gnomon', 'puzzlebox-studio'] };

  it('refuses an owner alias on every kind, not only person', () => {
    // It stopped at `person`, so nine of the owner's own assertions landed on
    // `topic:Pat` beside `owner:pat` and each held half the picture.
    expect(rejectEntityName('topic', 'Pat', 'inference', ctx)).not.toBeNull();
    expect(rejectEntityName('topic', 'Pat', 'assertion', ctx), 'the owner saying it does not make them a topic').not.toBeNull();
    expect(rejectEntityName('owner', 'pat', 'assertion', ctx)).toBeNull();
  });

  it('refuses a part of Gnomon as a tool, but keeps Gnomon itself', () => {
    expect(rejectEntityName('tool', 'Gnomon board', 'inference', ctx)).not.toBeNull();
    expect(rejectEntityName('tool', 'gnomon window sensor', 'conversation', ctx)).not.toBeNull();
    expect(rejectEntityName('tool', 'Gnomon', 'inference', ctx)).toBeNull();
    expect(rejectEntityName('tool', 'Gnomon board', 'assertion', ctx), 'the owner may still say it').toBeNull();
  });

  it('refuses a project that is not a known project unless the owner asserted it', () => {
    expect(rejectEntityName('project', 'Board Audits', 'conversation', ctx)).not.toBeNull();
    expect(rejectEntityName('project', 'lets get sanity certified', 'conversation', ctx)).not.toBeNull();
    expect(rejectEntityName('project', 'sundial', 'inference', ctx)).toBeNull();
    expect(rejectEntityName('project', 'Daily', 'assertion', ctx)).toBeNull();
    // No project list, no guess — a producer without context is not second-guessed.
    expect(rejectEntityName('project', 'Board Audits', 'conversation', { ownerAliases: ['pat'] })).toBeNull();
  });
});
