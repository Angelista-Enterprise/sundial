CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`canonical_name` text NOT NULL,
	`aliases_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_entities_kind` ON `entities` (`kind`);--> statement-breakpoint
CREATE TABLE `entity_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`predicate` text NOT NULL,
	`object` text NOT NULL,
	`confidence` integer NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`superseded_by` text,
	`source_event_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_entity_facts_entity` ON `entity_facts` (`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_entity_facts_valid_to` ON `entity_facts` (`valid_to`);--> statement-breakpoint
CREATE TABLE `memory_embeddings` (
	`id` text PRIMARY KEY NOT NULL,
	`ref_type` text NOT NULL,
	`ref_id` text NOT NULL,
	`model` text NOT NULL,
	`vector` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_memory_embeddings_ref` ON `memory_embeddings` (`ref_type`,`ref_id`);