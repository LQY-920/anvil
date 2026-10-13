CREATE TABLE `integration_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`repo_key` text NOT NULL,
	`repo_path` text NOT NULL,
	`repo_common_dir` text NOT NULL,
	`repo_dev` text NOT NULL,
	`repo_ino` text NOT NULL,
	`task_branch` text NOT NULL,
	`target_branch` text NOT NULL,
	`task_head` text NOT NULL,
	`target_head` text NOT NULL,
	`intent_hash` text NOT NULL,
	`status` text NOT NULL,
	`merge_commit` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "integration_attempts_status_check" CHECK("integration_attempts"."status" IN ('prepared','local_merged','recovery_required','completed')),
	CONSTRAINT "integration_attempts_merge_commit_check" CHECK("integration_attempts"."status" NOT IN ('local_merged','completed') OR "integration_attempts"."merge_commit" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_attempts_task_id_unique` ON `integration_attempts` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `integration_attempts_active_repo_unique` ON `integration_attempts` (`repo_key`) WHERE "integration_attempts"."status" <> 'completed';