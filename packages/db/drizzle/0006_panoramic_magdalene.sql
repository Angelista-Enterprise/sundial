ALTER TABLE `knowledge_entries` ADD `importance_score` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_entries` ADD `last_accessed_at` text;--> statement-breakpoint
ALTER TABLE `moments` ADD `importance_score` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `moments` ADD `last_accessed_at` text;