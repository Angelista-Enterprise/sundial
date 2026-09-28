-- K0.5: the executor's journal learns to record a failure, and which event an
-- emit became.
--
-- Two faults in one table, both found by the Trace card (I14).
--
-- 1. A FAILURE HEALED INTO A SUCCESS. `executeEffects` had no `catch`, so an
--    effect that threw left its row in `started`, aborted the rest of that
--    event's effects, and was re-run on the next boot — every variant in the
--    union is `at-least-once` — which stamped it `completed`. All 27,029 rows
--    said `completed`, and that was not "nothing ever failed": it was that the
--    one surface able to report a failed side effect reported the opposite.
--    `failures` counts the throws and SURVIVES a later success, because "this
--    worked on the third try" is the fact an operator wants and a status alone
--    cannot hold it. `last_error` keeps the newest message.
--
-- 2. NO EDGE FROM AN EMIT TO WHAT IT EMITTED. `describeEffect` writes
--    `EmitEvent <type>` and nothing else, so the chain from one sensor reading
--    through three internal hops could not be rebuilt — and that chain is most
--    of the traffic: 15,684 of the 20,839 events Gnomon acted on it raised
--    itself. `emitted_event_id` is the child's own id, which the effect already
--    carries before dispatch, so a row joins to the rows of the event it
--    caused.
--
-- All three nullable/defaulted. Nothing is backfilled: a failure that healed
-- before this landed left no trace anywhere, and the emitted id of an old row
-- is unrecoverable. `failures = 0` on an old row means "never counted", not
-- "never failed", and the card says which.
ALTER TABLE `applied_effects` ADD `failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `applied_effects` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `applied_effects` ADD `emitted_event_id` text;
