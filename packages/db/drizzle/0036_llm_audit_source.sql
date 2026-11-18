-- Step 3 of docs/provider-implementation.md: which source served a call, and how.
--
-- `source` is the route id the row was written under (`openai`, a provider id, `claude`,
-- `jev`): until now only the `llm:dispatched` event knew it. `access` says what kind of
-- source: `api` (a key or a local server, priced per token), `runtime` (a vendor's own
-- binary on the owner's plan: counted, never priced) or `judge` (Jev). NULL on every
-- row from before this column.
ALTER TABLE `llm_audit` ADD `source` text;--> statement-breakpoint
ALTER TABLE `llm_audit` ADD `access` text;