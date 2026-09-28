ALTER TABLE `llm_audit` ADD `attempt` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `llm_audit` ADD `parent_call_id` text;