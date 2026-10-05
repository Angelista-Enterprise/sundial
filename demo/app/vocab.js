/**
 * The words more than one part of Sundial must spell the same way: one copy,
 * zero imports. The host imports `@sundial/helpers/vocab.js`; the no-build
 * browser client gets this same compiled file at `/gnomon/app/vocab.js` (an
 * ASSETS entry in `shell/server.js`, mapped in the page's import map), so a
 * module shared by both sides imports it by the one bare name.
 *
 * It lives in helpers rather than the kernel because helpers is the one
 * package every other package and plugin already depends on.
 * `test/architecture.test.js` (F6) fails when a copy appears anywhere else.
 */
/** A turn with no frame for this long is closed as quiet (the theme's `/turn` watchdog); a chat stream is given half of it. */
export const TURN_IDLE_MS = 240_000;
/** The session the proactive plugin speaks into: "the conversation". */
export const COMPANION_SESSION_ID = 'gnomon-companion';
/** The owner's verdicts on anything Gnomon said, in the order the phone offers them. */
export const VERDICTS = ['useful', 'not-now', 'wrong'];
/** Every kind of entity core memory holds (`EntityKind`). */
export const ENTITY_KINDS = ['person', 'project', 'tool', 'topic', 'task', 'owner', 'goal'];
/** What the nightly pass and an answered question may extract. `task` is not (owner decision 3 in the autonomy plan). */
export const EXTRACTABLE_ENTITY_KINDS = ['person', 'project', 'tool', 'topic', 'owner', 'goal'];
/** What the owner may assert by hand, in the order the form lists them. */
export const ASSERTABLE_ENTITY_KINDS = ['person', 'project', 'tool', 'topic', 'goal', 'owner'];
/** What Gnomon may claim with `gnomon_claim`: never the owner or a goal, which are the owner's to state. */
export const CLAIMABLE_ENTITY_KINDS = ['person', 'project', 'tool', 'topic', 'task'];
/** A notice key a test or a smoke run wrote, not a notice the owner was given: left out of every precision. */
export const isTestNoticeKey = (key) => /test|experiment/i.test(key) || key.startsWith('j0.');
//# sourceMappingURL=vocab.js.map