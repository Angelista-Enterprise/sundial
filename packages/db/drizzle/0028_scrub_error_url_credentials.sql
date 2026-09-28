-- Scrub credentials out of URLs already stored in `llm_audit.error`.
--
-- The column keeps whatever the failing layer wrote, and that is routinely the
-- endpoint it was talking to. An endpoint carries a key when the key travels
-- as a query parameter, and once it is here it is in every readout of the
-- ledger. New rows are guarded at the write path (`updateLlmAudit` ->
-- `redactUrlCredentials`); this is the rows written before that guard existed.
--
-- The `instr` pair is the guard against mangling an ordinary sentence: only a
-- '?' that comes AFTER a '://' is treated as the start of a query string.
-- Userinfo (`https://user:pass@host`) is NOT rewritten here — SQLite has no
-- regexp, the shape has never appeared in this table, and the write-path guard
-- covers it from now on.
UPDATE `llm_audit`
SET `error` = rtrim(substr(`error`, 1, instr(`error`, '?') - 1))
WHERE `error` LIKE '%://%?%'
  AND instr(`error`, '?') > instr(`error`, '://');
