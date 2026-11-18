-- Plan 15 I16: the time to the first streamed text of a reply. NULL when nothing streamed, and on every row from before.
ALTER TABLE `llm_audit` ADD `first_token_ms` integer;