PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_memory_embeddings` (
	`id` text PRIMARY KEY NOT NULL,
	`ref_type` text NOT NULL,
	`ref_id` text NOT NULL,
	`model` text NOT NULL,
	`vector` blob NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_memory_embeddings`("id", "ref_type", "ref_id", "model", "vector", "created_at") SELECT "id", "ref_type", "ref_id", "model", "vector", "created_at" FROM `memory_embeddings`;--> statement-breakpoint
DROP TABLE `memory_embeddings`;--> statement-breakpoint
ALTER TABLE `__new_memory_embeddings` RENAME TO `memory_embeddings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_memory_embeddings_ref` ON `memory_embeddings` (`ref_type`,`ref_id`);