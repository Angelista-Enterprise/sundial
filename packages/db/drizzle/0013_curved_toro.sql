ALTER TABLE `entity_facts` ADD `alpha` real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `entity_facts` ADD `beta` real DEFAULT 1 NOT NULL;--> statement-breakpoint
--> Phase 2a (docs/design/08 §5): seed the Beta posterior from each fact's
--> existing confidence so the derived mean round(100*alpha/(alpha+beta))
--> matches its stored confidence (exact for the /10 heuristic seed values),
--> and reinforcement/decay start from a sensible evidence count.
UPDATE `entity_facts` SET `alpha` = MAX(1, ROUND(confidence / 10.0)), `beta` = MAX(1, ROUND((100 - confidence) / 10.0));