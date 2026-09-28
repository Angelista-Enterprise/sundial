import { ulid } from 'ulid';

/**
 * Event/signal IDs are ULIDs — sortable by insertion time, unlike a random
 * UUID. Phase 2's boot replay (`log_offset` = last-seen id) depends on this
 * lexical ordering, so it's used from Phase 1 onward rather than migrated
 * to later.
 */
export function createEventId(): string {
  return ulid();
}
