CREATE TABLE `cover_cache` (
	`url_hash` text PRIMARY KEY NOT NULL,
	`file` text NOT NULL,
	`content_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `device_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_ref` integer NOT NULL,
	`day` text NOT NULL,
	`playback_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`device_ref`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `device_usage_device_day` ON `device_usage` (`device_ref`,`day`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile` text NOT NULL,
	`device_id` text,
	`state` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `playback` (
	`episode_id` text PRIMARY KEY NOT NULL,
	`series_id` text NOT NULL,
	`definition` text NOT NULL,
	`expires_at` integer NOT NULL,
	`duration` integer NOT NULL,
	`encrypted_bytes` integer NOT NULL,
	`encryption_method` text NOT NULL,
	`media_file` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `playback_series` ON `playback` (`series_id`);--> statement-breakpoint
CREATE TABLE `sprite_sheets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`episode_id` text NOT NULL,
	`video_id` text NOT NULL,
	`sheet_index` integer NOT NULL,
	`file` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`grid_x` integer NOT NULL,
	`grid_y` integer NOT NULL,
	`cell_width` integer NOT NULL,
	`cell_height` integer NOT NULL,
	`frame_count` integer NOT NULL,
	`interval` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sprite_episode` ON `sprite_sheets` (`episode_id`,`sheet_index`);