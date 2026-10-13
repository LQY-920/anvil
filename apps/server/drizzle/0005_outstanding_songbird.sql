CREATE TABLE `delivery_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`decision_id` text,
	`action` text NOT NULL,
	`state` text NOT NULL,
	`expected_head` text NOT NULL,
	`request_key` text NOT NULL,
	`payload_hash` text NOT NULL,
	`intent_json` text NOT NULL,
	`result_json` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decision_id`) REFERENCES `review_decisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "delivery_operations_action_check" CHECK("delivery_operations"."action" IN ('local_merge','pull_request')),
	CONSTRAINT "delivery_operations_state_check" CHECK("delivery_operations"."state" IN ('prepared','unknown','failed','succeeded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_operations_request_unique` ON `delivery_operations` (`task_id`,`action`,`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_operations_active_task_action_unique` ON `delivery_operations` (`task_id`,`action`) WHERE "delivery_operations"."state" IN ('prepared','unknown');--> statement-breakpoint
CREATE TABLE `external_issues` (
	`repository_id` text NOT NULL,
	`external_id` text NOT NULL,
	`local_issue_id` text NOT NULL,
	`issue_number` integer NOT NULL,
	`url` text NOT NULL,
	`accepted_snapshot_id` text NOT NULL,
	`latest_snapshot_id` text NOT NULL,
	PRIMARY KEY(`repository_id`, `external_id`),
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`local_issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`accepted_snapshot_id`) REFERENCES `source_snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`latest_snapshot_id`) REFERENCES `source_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_issues_local_issue_unique` ON `external_issues` (`local_issue_id`);--> statement-breakpoint
CREATE TABLE `pull_request_links` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`task_id` text NOT NULL,
	`external_id` text NOT NULL,
	`number` integer NOT NULL,
	`url` text NOT NULL,
	`head_ref` text NOT NULL,
	`head_sha` text NOT NULL,
	`base_ref` text NOT NULL,
	`state` text NOT NULL,
	`merge_commit` text,
	`last_synced_at` text NOT NULL,
	`checks_json` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pull_request_links_state_check" CHECK("pull_request_links"."state" IN ('open','closed','merged'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_request_links_task_unique` ON `pull_request_links` (`task_id`);--> statement-breakpoint
CREATE INDEX `pull_request_links_repository_external` ON `pull_request_links` (`repository_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`mode` text NOT NULL,
	`host` text NOT NULL,
	`external_id` text NOT NULL,
	`full_name` text NOT NULL,
	`clone_url` text NOT NULL,
	`target_branch` text NOT NULL,
	`checkout_path` text NOT NULL,
	`identity_json` text NOT NULL,
	`connection_login` text,
	`can_push` integer DEFAULT false NOT NULL,
	`connection_status` text NOT NULL,
	`last_synced_at` text,
	`next_sync_at` text,
	`error` text,
	`version` integer DEFAULT 1 NOT NULL,
	`sync_failures` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "repositories_mode_check" CHECK("repositories"."mode" IN ('local_git','github_pr')),
	CONSTRAINT "repositories_connection_status_check" CHECK("repositories"."connection_status" IN ('connected','unavailable','renamed','permission_denied'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_host_external_id_unique` ON `repositories` (`host`,`external_id`);--> statement-breakpoint
CREATE INDEX `repositories_workspace` ON `repositories` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `review_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`result` text NOT NULL,
	`reason` text NOT NULL,
	`head_commit` text NOT NULL,
	`evidence_version` text NOT NULL,
	`request_key` text NOT NULL,
	`payload_hash` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "review_decisions_result_check" CHECK("review_decisions"."result" IN ('approved','overridden','rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_decisions_task_unique` ON `review_decisions` (`task_id`);--> statement-breakpoint
CREATE TABLE `source_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`external_id` text NOT NULL,
	`issue_number` integer NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`state` text NOT NULL,
	`source_updated_at` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "source_snapshots_state_check" CHECK("source_snapshots"."state" IN ('open','closed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_snapshots_repository_external_hash_unique` ON `source_snapshots` (`repository_id`,`external_id`,`hash`);--> statement-breakpoint
ALTER TABLE `issues` ADD `repository_id` text REFERENCES repositories(id);--> statement-breakpoint
ALTER TABLE `issues` ADD `source_snapshot_id` text REFERENCES source_snapshots(id);--> statement-breakpoint
ALTER TABLE `tasks` ADD `repository_id` text REFERENCES repositories(id);--> statement-breakpoint
ALTER TABLE `tasks` ADD `repository_snapshot_json` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `source_snapshot_id` text REFERENCES source_snapshots(id);