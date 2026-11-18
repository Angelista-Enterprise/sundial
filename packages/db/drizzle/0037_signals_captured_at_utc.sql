-- Rewrite every `signals.captured_at` that is not in UTC to UTC.
--
-- The phone inbox stored the phone's own spelling of the time: a local offset
-- (`+01:00`) and six decimals. Every reader compares this column as text, so
-- those rows sorted in the wrong place. The writers are fixed (`eventsOf`,
-- `ingestAndApply`); these are the rows from before.
--
-- The instant does not change, only its spelling. `id`, row order and `data`
-- stay as they are, so a replay folds the same events in the same order. A
-- value SQLite cannot read is left alone: the column is NOT NULL.
UPDATE `signals`
SET `captured_at` = strftime('%Y-%m-%dT%H:%M:%fZ', `captured_at`)
WHERE `captured_at` NOT GLOB '*Z'
  AND julianday(`captured_at`) IS NOT NULL;
