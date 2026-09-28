CREATE TABLE `llm_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`moment_id` text,
	`purpose` text NOT NULL,
	`model` text NOT NULL,
	`prompt` text NOT NULL,
	`requested_at` text NOT NULL,
	`responded_at` text,
	`latency_ms` integer,
	`status_code` integer,
	`success` integer DEFAULT false NOT NULL,
	`response_content` text,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`total_tokens` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_llm_audit_requested` ON `llm_audit` (`requested_at`);--> statement-breakpoint
CREATE INDEX `idx_llm_audit_purpose` ON `llm_audit` (`purpose`);