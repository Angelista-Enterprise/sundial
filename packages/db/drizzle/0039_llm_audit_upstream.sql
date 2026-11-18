-- Set 4 R1: the host the route says served the call (OpenRouter's provider). NULL when none is named, and on every row from before.
ALTER TABLE `llm_audit` ADD `upstream` text;