CREATE TABLE `ask_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`question` text NOT NULL,
	`answer` text,
	`reason` text,
	`source_count` integer DEFAULT 0 NOT NULL,
	`sources` text,
	`asked_at` text NOT NULL,
	`remembered` integer DEFAULT false NOT NULL,
	`remembered_at` text,
	`remembered_entry_id` text,
	`source_event_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_ask_threads_asked` ON `ask_threads` (`asked_at`);