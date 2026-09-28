CREATE TABLE `knowledge_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`severity` text,
	`dedupe_key` text NOT NULL,
	`source_event_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_knowledge_entries_dedupe` ON `knowledge_entries` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_entries_created` ON `knowledge_entries` (`created_at`);