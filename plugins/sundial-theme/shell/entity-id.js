// One way to turn a name into an entity id.
//
// There were two, and the record shows what that cost. `POST /gnomon/goals/status`
// wrote `goal:Ask team whether moving standup to 9:30 still stands` while
// `gnomon_assert` and `POST /gnomon/api/assert` wrote
// `goal:ask-team-whether-moving-standup-to-9-30-still-stands`, so pressing Done
// on the card and saying "that's done" in the chat reached two different
// entities. Four goals ended up split across two ids each, and because a
// supersede only ever looks at one of them, two contradicting statuses stood
// live at once: `done` on the slug, `dropped` on the raw name.
//
// The write side is now one door (`/gnomon/api/assert`). This is here so the
// read side folds the wreckage back together by the same rule, and so the next
// caller has something to import instead of a regex to retype.

/** `Ledger failure views (L1–L7)` → `ledger-failure-views-l1-l7`. */
export const entitySlug = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** The id an assertion about this thing lands on. */
export const entityId = (kind, name) => `${kind}:${entitySlug(name)}`
